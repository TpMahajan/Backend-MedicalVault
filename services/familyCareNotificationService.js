import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { CareRelationship } from "../models/CareRelationship.js";
import { MedicationOrder } from "../models/MedicationOrder.js";
import { MedicationSchedule } from "../models/MedicationSchedule.js";
import { MedicationDoseEvent } from "../models/MedicationDoseEvent.js";
import { sendPushNotification } from "../config/firebase.js";
import { broadcastNotification } from "../controllers/notificationController.js";
import { generateRollingDoseEvents, localDateTimeParts } from "./medicationScheduleService.js";

export const FAMILY_CARE_NOTIFICATION_KEYS = Object.freeze([
  "enabled", "medicineDue", "repeatReminder", "medicineMissed", "caregiverMissedDoseAlert",
  "takenConfirmation", "skippedConfirmation", "refillReminder", "lowStockReminder",
]);

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const text = (value, max = 160) => String(value ?? "").trim().slice(0, max);
const bool = (value, fallback) => value === undefined ? fallback : value === true;

export const defaultFamilyCareNotificationPreferences = () => ({
  enabled: true,
  medicineDue: true,
  repeatReminder: true,
  medicineMissed: true,
  caregiverMissedDoseAlert: true,
  takenConfirmation: false,
  skippedConfirmation: false,
  refillReminder: true,
  lowStockReminder: true,
  quietHours: { enabled: false, start: "22:00", end: "07:00", timezone: "Asia/Kolkata" },
});

const validTimezone = (timezone) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); return true; } catch (_) { return false; }
};

export const normalizeFamilyCareNotificationPreferences = (value = {}) => {
  const defaults = defaultFamilyCareNotificationPreferences();
  const quiet = value.quietHours || {};
  return {
    ...Object.fromEntries(FAMILY_CARE_NOTIFICATION_KEYS.map((key) => [key, bool(value[key], defaults[key])])),
    quietHours: {
      enabled: bool(quiet.enabled, defaults.quietHours.enabled),
      start: TIME.test(quiet.start) ? quiet.start : defaults.quietHours.start,
      end: TIME.test(quiet.end) ? quiet.end : defaults.quietHours.end,
      timezone: validTimezone(quiet.timezone) ? quiet.timezone : defaults.quietHours.timezone,
    },
  };
};

export const preferencesForProfile = (user, patientProfileId) => {
  const global = normalizeFamilyCareNotificationPreferences(user?.familyCareNotificationPreferences || {});
  const override = (user?.familyCareNotificationPreferences?.profileOverrides || [])
    .find((item) => String(item.patientProfileId) === String(patientProfileId));
  return override ? normalizeFamilyCareNotificationPreferences({ ...global, ...(override.toObject?.() || override) }) : global;
};

const isQuiet = (preferences, now = new Date()) => {
  const quiet = preferences.quietHours;
  if (!quiet?.enabled) return false;
  const local = localDateTimeParts(now, quiet.timezone);
  const current = `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
  if (quiet.start === quiet.end) return true;
  return quiet.start < quiet.end
    ? current >= quiet.start && current < quiet.end
    : current >= quiet.start || current < quiet.end;
};

const allowed = ({ preferences, preferenceKey, now }) => preferences.enabled
  && preferences[preferenceKey] !== false
  && !isQuiet(preferences, now);

export const resolveMedicationRecipients = async ({ patientProfile, preferenceKey, now = new Date(), caregiverOnly = false }) => {
  const recipientIds = new Set();
  if (!caregiverOnly && patientProfile.identityUserId) recipientIds.add(String(patientProfile.identityUserId));
  const caregivers = await CareRelationship.find({
    patientProfileId: patientProfile._id,
    status: "active",
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  }).select("caregiverUserId permissions role").lean();
  for (const relation of caregivers) {
    if (relation.role === "owner" || relation.permissions?.caregiverNotificationsReceive === true) {
      recipientIds.add(String(relation.caregiverUserId));
    }
  }
  const users = await User.find({ _id: { $in: [...recipientIds] }, isActive: true }).select("fcmToken familyCareNotificationPreferences");
  return users.filter((user) => allowed({ preferences: preferencesForProfile(user, patientProfile._id), preferenceKey, now }));
};

export const deliverFamilyCareNotification = async ({ recipient, patientProfileId, doseEvent, medicationOrder, kind, title, body, now = new Date() }) => {
  const eventIdentifier = doseEvent?._id ? String(doseEvent._id) : `order-${medicationOrder._id}`;
  const notificationActionId = `family-dose-${eventIdentifier}-${kind}`;
  const data = {
    module: "family_care",
    notificationActionId,
    action: kind,
    patientProfileId: String(patientProfileId),
    medicationOrderId: String(medicationOrder._id),
    ...(doseEvent?._id ? { doseEventId: String(doseEvent._id) } : {}),
  };
  const notification = await Notification.create({
    title,
    body,
    type: "family_care_medication",
    data,
    patientProfileId,
    recipientId: recipient._id,
    recipientRole: "patient",
    senderId: "system",
    senderRole: "system",
  });
  if (recipient.fcmToken) {
    const push = await sendPushNotification(recipient.fcmToken, { title, body }, data);
    if (push.success) {
      notification.fcmSent = true;
      notification.fcmMessageId = text(push.messageId, 240);
      await notification.save();
    }
  }
  await broadcastNotification(notification);
  return notification;
};

const dosageText = (order) => `${order.name}${order.strength ? ` ${order.strength}` : ""}`;

const notifyDose = async ({ event, order, profile, preferenceKey, kind, title, body, caregiverOnly = false, now = new Date() }) => {
  const recipients = await resolveMedicationRecipients({ patientProfile: profile, preferenceKey, caregiverOnly, now });
  await Promise.all(recipients.map((recipient) => deliverFamilyCareNotification({
    recipient,
    patientProfileId: profile._id,
    doseEvent: event,
    medicationOrder: order,
    kind,
    title,
    body,
    now,
  })));
  return recipients.length;
};

const notifyOrder = async ({ order, profile, preferenceKey, kind, title, body, caregiverOnly = false, now = new Date() }) => {
  const recipients = await resolveMedicationRecipients({ patientProfile: profile, preferenceKey, caregiverOnly, now });
  await Promise.all(recipients.map((recipient) => deliverFamilyCareNotification({
    recipient,
    patientProfileId: profile._id,
    medicationOrder: order,
    kind,
    title,
    body,
    now,
  })));
  return recipients.length;
};

export const sendDoseActionConfirmation = async ({ event, order, profile, action, now = new Date() }) => {
  const key = action === "taken" ? "takenConfirmation" : "skippedConfirmation";
  return notifyDose({
    event,
    order,
    profile,
    preferenceKey: key,
    kind: `${action}_confirmation`,
    title: action === "taken" ? "Dose marked taken" : "Dose marked skipped",
    body: `${dosageText(order)} was marked ${action}.`,
    now,
  });
};

const claim = async ({ event, field, now }) => MedicationDoseEvent.findOneAndUpdate(
  { _id: event._id, [field]: null },
  { $set: { [field]: now } },
  { new: true },
);

export const runFamilyCareMedicationScheduler = async ({ now = new Date(), limit = 250 } = {}) => {
  const schedules = await MedicationSchedule.find({ status: "active" }).limit(limit);
  let generated = 0;
  for (const schedule of schedules) {
    const outcome = await generateRollingDoseEvents({ schedule, now });
    generated += outcome.generated;
  }
  await MedicationDoseEvent.updateMany({ status: "snoozed", snoozedUntil: { $lte: now } }, { $set: { status: "due", snoozedUntil: null } });
  await MedicationDoseEvent.updateMany({ status: "pending", scheduledAt: { $lte: now } }, { $set: { status: "due" } });
  const due = await MedicationDoseEvent.find({ status: "due", scheduledAt: { $lte: now }, notificationSentAt: null }).sort({ scheduledAt: 1 }).limit(limit)
    .populate("medicationOrderId")
    .populate("patientProfileId");
  let dueNotifications = 0;
  for (const event of due) {
    const claimed = await claim({ event, field: "notificationSentAt", now });
    if (!claimed || !event.medicationOrderId || !event.patientProfileId) continue;
    dueNotifications += await notifyDose({
      event: claimed,
      order: event.medicationOrderId,
      profile: event.patientProfileId,
      preferenceKey: "medicineDue",
      kind: "dose_due",
      title: "Medicine due",
      body: `${dosageText(event.medicationOrderId)} is due now.`,
      now,
    });
  }
  const repeatCandidates = await MedicationDoseEvent.find({
    status: "due",
    notificationSentAt: { $ne: null },
  }).sort({ notificationSentAt: 1 }).limit(limit)
    .populate("medicationOrderId")
    .populate("patientProfileId");
  let repeatNotifications = 0;
  for (const event of repeatCandidates) {
    const order = event.medicationOrderId;
    const profile = event.patientProfileId;
    if (!order || !profile || order.notificationPolicy?.enabled === false) continue;
    const intervalMinutes = Number(order.notificationPolicy?.repeatAfterMinutes || 30);
    const lastSent = event.repeatReminderSentAt || event.notificationSentAt;
    if (!lastSent || now.getTime() - new Date(lastSent).getTime() < intervalMinutes * 60 * 1000) continue;
    const claimed = await MedicationDoseEvent.findOneAndUpdate(
      {
        _id: event._id,
        status: "due",
        $or: [
          { repeatReminderSentAt: null },
          { repeatReminderSentAt: { $lte: new Date(now.getTime() - intervalMinutes * 60 * 1000) } },
        ],
      },
      { $set: { repeatReminderSentAt: now } },
      { new: true },
    );
    if (!claimed) continue;
    repeatNotifications += await notifyDose({
      event: claimed,
      order,
      profile,
      preferenceKey: "repeatReminder",
      kind: "dose_repeat",
      title: "Medicine reminder",
      body: `${dosageText(order)} is still due.`,
      now,
    });
  }
  const missedBefore = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  await MedicationDoseEvent.updateMany(
    { status: "due", scheduledAt: { $lte: missedBefore } },
    { $set: { status: "missed" }, $push: { audit: { action: "missed", at: now, details: { source: "scheduler" } } } },
  );
  const missed = await MedicationDoseEvent.find({ status: "missed", missedNotificationSentAt: null }).sort({ scheduledAt: 1 }).limit(limit)
    .populate("medicationOrderId")
    .populate("patientProfileId");
  let missedNotifications = 0;
  for (const event of missed) {
    const claimed = await claim({ event, field: "missedNotificationSentAt", now });
    if (!claimed || !event.medicationOrderId || !event.patientProfileId) continue;
    missedNotifications += await notifyDose({
      event: claimed,
      order: event.medicationOrderId,
      profile: event.patientProfileId,
      preferenceKey: "medicineMissed",
      kind: "dose_missed",
      title: "Medicine dose missed",
      body: `${dosageText(event.medicationOrderId)} was not confirmed.`,
      now,
    });
    missedNotifications += await notifyDose({
      event: claimed,
      order: event.medicationOrderId,
      profile: event.patientProfileId,
      preferenceKey: "caregiverMissedDoseAlert",
      kind: "caregiver_missed_dose",
      title: "Family Care missed-dose alert",
      body: `${dosageText(event.medicationOrderId)} was not confirmed.`,
      caregiverOnly: true,
      now,
    });
  }
  const orders = await MedicationOrder.find({ status: "active" }).limit(limit).populate("patientProfileId");
  let stockNotifications = 0;
  let refillNotifications = 0;
  const refillWindow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  for (const order of orders) {
    const profile = order.patientProfileId;
    if (!profile || order.notificationPolicy?.enabled === false) continue;
    const stock = order.stock || {};
    const low = stock.quantity !== null && stock.quantity !== undefined
      && stock.lowStockThreshold !== null && stock.lowStockThreshold !== undefined
      && Number.isFinite(Number(stock.quantity))
      && Number.isFinite(Number(stock.lowStockThreshold))
      && Number(stock.quantity) <= Number(stock.lowStockThreshold);
    if (low && !order.lowStockNotificationSentAt) {
      const claimed = await MedicationOrder.findOneAndUpdate(
        { _id: order._id, lowStockNotificationSentAt: null },
        { $set: { lowStockNotificationSentAt: now } },
        { new: true },
      );
      if (claimed) stockNotifications += await notifyOrder({
        order: claimed,
        profile,
        preferenceKey: "lowStockReminder",
        kind: "low_stock",
        title: "Medicine stock is low",
        body: `${dosageText(claimed)} is at or below its low-stock threshold.`,
        now,
      });
    }
    const refillAt = stock.refillAt ? new Date(stock.refillAt) : null;
    if (refillAt && refillAt <= refillWindow && !order.refillReminderSentAt) {
      const claimed = await MedicationOrder.findOneAndUpdate(
        { _id: order._id, refillReminderSentAt: null },
        { $set: { refillReminderSentAt: now } },
        { new: true },
      );
      if (claimed) refillNotifications += await notifyOrder({
        order: claimed,
        profile,
        preferenceKey: "refillReminder",
        kind: "refill_due",
        title: "Medicine refill reminder",
        body: `${dosageText(claimed)} has a refill due soon.`,
        now,
      });
    }
  }
  return { generated, dueNotifications, repeatNotifications, missedNotifications, stockNotifications, refillNotifications };
};
