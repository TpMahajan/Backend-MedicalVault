import { Notification } from "../models/Notification.js";
import { DeviceToken } from "../models/DeviceToken.js";
import { User } from "../models/User.js";
import { DoctorUser } from "../models/DoctorUser.js";
import { sendPushNotification } from "../config/firebase.js";

const INVALID_TOKEN_CODES = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token", "messaging/invalid-argument"]);
const id = (value) => String(value || "");
export const emptyDeliveryResult = () => ({ recipientsSelected: 0, notificationsCreated: 0, socketDelivered: 0, socketUnavailable: 0, pushAttempted: 0, pushSucceeded: 0, pushFailed: 0, invalidTokensRemoved: 0, recipientsWithoutTokens: 0, errorsByCode: {} });

function normalizeData(input, notificationId) {
  const source = input || {};
  return Object.fromEntries(Object.entries({ ...source, notificationId: id(notificationId), type: source.type || "general" }).filter(([, value]) => value != null).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]));
}

async function tokensFor(recipient) {
  const records = await DeviceToken.find({ userId: recipient.userId, enabled: true }).select("+token platform").lean();
  if (records.length) return records;
  const Model = recipient.role === "doctor" ? DoctorUser : User;
  const legacy = await Model.findById(recipient.userId).select("fcmToken").lean();
  return legacy?.fcmToken ? [{ token: legacy.fcmToken, legacy: true, platform: "unknown" }] : [];
}

async function deliverOne(recipient, request, result) {
  const idempotencyKey = String(request.data?.idempotencyKey || "").trim();
  if (idempotencyKey) {
    const existing = await Notification.findOne({ recipientId: recipient.userId, "data.idempotencyKey": idempotencyKey });
    if (existing) return existing;
  }
  const notification = await Notification.create({ title: request.title, body: request.body, type: request.type || "general", data: request.data || {}, recipientId: recipient.userId, recipientRole: recipient.role, senderId: request.senderId || "system", senderRole: request.senderRole || "system" });
  result.notificationsCreated += 1;
  const { broadcastNotification } = await import("../controllers/notificationController.js");
  const realtime = await broadcastNotification(notification);
  result.socketDelivered += realtime?.delivered || 0;
  result.socketUnavailable += realtime?.unavailable ? 1 : 0;
  const tokens = await tokensFor(recipient);
  if (!tokens.length) { result.recipientsWithoutTokens += 1; return notification; }
  for (const device of tokens) {
    result.pushAttempted += 1;
    const response = await sendPushNotification(device.token, { title: request.title, body: request.body, image: request.imageUrl }, normalizeData(request.data, notification._id));
    if (response.success) { result.pushSucceeded += 1; notification.fcmSent = true; notification.fcmMessageId = response.messageId; continue; }
    result.pushFailed += 1;
    const code = response.code || "unknown";
    result.errorsByCode[code] = (result.errorsByCode[code] || 0) + 1;
    if (INVALID_TOKEN_CODES.has(code)) {
      if (device.legacy) { const Model = recipient.role === "doctor" ? DoctorUser : User; await Model.updateOne({ _id: recipient.userId, fcmToken: device.token }, { $set: { fcmToken: null } }); }
      else await DeviceToken.deleteOne({ _id: device._id, token: device.token });
      result.invalidTokensRemoved += 1;
    }
  }
  await notification.save();
  return notification;
}

/** Persists first; socket and FCM failures never discard the in-app notification. */
export async function deliverNotifications(request) {
  const recipients = [...new Map((request.recipients || []).map((entry) => [`${id(entry.userId)}:${entry.role}`, { userId: entry.userId, role: String(entry.role).toLowerCase() }])).values()];
  const result = emptyDeliveryResult(); result.recipientsSelected = recipients.length;
  const notifications = [];
  for (let offset = 0; offset < recipients.length; offset += 25) {
    const settled = await Promise.allSettled(recipients.slice(offset, offset + 25).map((recipient) => deliverOne(recipient, request, result)));
    settled.forEach((entry) => { if (entry.status === "fulfilled") notifications.push(entry.value); else result.errorsByCode.persistence = (result.errorsByCode.persistence || 0) + 1; });
  }
  return { result, notifications };
}
