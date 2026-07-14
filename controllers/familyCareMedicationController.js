import mongoose from "mongoose";
import { MedicationOrder } from "../models/MedicationOrder.js";
import { MedicationSchedule, MEDICATION_SCHEDULE_TYPES } from "../models/MedicationSchedule.js";
import { MedicationDoseEvent } from "../models/MedicationDoseEvent.js";
import { writeAuditLog } from "../middleware/auditLogger.js";
import {
  cancelFuturePendingDoseEvents,
  generateRollingDoseEvents,
  isValidIanaTimezone,
  localDateFor,
  validateMedicationScheduleInput,
  zonedDateTimeToUtc,
} from "../services/medicationScheduleService.js";
import { sendDoseActionConfirmation } from "../services/familyCareNotificationService.js";

const text = (value, max = 240) => String(value ?? "").trim().slice(0, max);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const foodInstructions = new Set(["before_food", "after_food", "with_food", "not_specified"]);

const dateInput = (value) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const raw = text(value, 16);
  if (!DATE.test(raw)) return undefined;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw ? undefined : date;
};

const orderView = (order, schedule = null) => ({
  id: String(order._id),
  patientProfileId: String(order.patientProfileId),
  name: order.name,
  strength: order.strength || "",
  dosageForm: order.dosageForm || "",
  doseQuantity: order.doseQuantity,
  doseUnit: order.doseUnit,
  foodInstruction: order.foodInstruction,
  startDate: order.startDate?.toISOString?.().slice(0, 10) || null,
  endDate: order.endDate?.toISOString?.().slice(0, 10) || null,
  noEndDate: order.noEndDate,
  notes: order.notes || "",
  prescriptionDocumentId: order.prescriptionDocumentId ? String(order.prescriptionDocumentId) : null,
  status: order.status,
  stock: order.stock?.toObject?.() || order.stock || {},
  notificationPolicy: order.notificationPolicy?.toObject?.() || order.notificationPolicy || {},
  schedule: schedule ? scheduleView(schedule) : null,
});

const scheduleView = (schedule) => ({
  id: String(schedule._id),
  medicationOrderId: String(schedule.medicationOrderId),
  patientProfileId: String(schedule.patientProfileId),
  scheduleType: schedule.scheduleType,
  localTimes: schedule.localTimes || [],
  weekdays: schedule.weekdays || [],
  intervalHours: schedule.intervalHours ?? null,
  timezone: schedule.timezone,
  fixedToProfileTimezone: schedule.fixedToProfileTimezone !== false,
  activeStartDate: schedule.activeStartDate?.toISOString?.().slice(0, 10) || null,
  activeEndDate: schedule.activeEndDate?.toISOString?.().slice(0, 10) || null,
  status: schedule.status,
});

const doseView = (event) => ({
  id: String(event._id),
  medicationOrderId: String(event.medicationOrderId?._id || event.medicationOrderId),
  medicationScheduleId: String(event.medicationScheduleId?._id || event.medicationScheduleId),
  patientProfileId: String(event.patientProfileId),
  medicationName: event.medicationOrderId?.name || null,
  scheduledAt: event.scheduledAt,
  originalLocalDate: event.originalLocalDate,
  originalLocalTime: event.originalLocalTime,
  scheduleTimezone: event.scheduleTimezone,
  status: event.status,
  snoozedUntil: event.snoozedUntil || null,
  confirmedAt: event.confirmedAt || null,
});

const orderPayload = (body = {}, profileId, actorId, current = null) => {
  const source = current ? { ...current.toObject(), ...body } : body;
  const startDate = dateInput(source.startDate);
  const endDate = source.noEndDate === true || source.endDate === null || source.endDate === "" ? null : dateInput(source.endDate);
  return {
    patientProfileId: profileId,
    name: text(source.name, 160),
    strength: text(source.strength, 80),
    dosageForm: text(source.dosageForm, 60),
    doseQuantity: Number(source.doseQuantity),
    doseUnit: text(source.doseUnit, 40),
    foodInstruction: text(source.foodInstruction, 40) || "not_specified",
    startDate,
    endDate,
    noEndDate: source.noEndDate !== false,
    notes: text(source.notes, 2000),
    prescriptionDocumentId: source.prescriptionDocumentId || null,
    status: ["active", "paused", "stopped"].includes(source.status) ? source.status : current?.status || "active",
    stock: source.stock && typeof source.stock === "object" ? {
      quantity: source.stock.quantity === null || source.stock.quantity === "" ? null : Number(source.stock.quantity),
      unit: text(source.stock.unit, 40),
      lowStockThreshold: source.stock.lowStockThreshold === null || source.stock.lowStockThreshold === "" ? null : Number(source.stock.lowStockThreshold),
      refillAt: source.stock.refillAt ? dateInput(source.stock.refillAt) : null,
    } : current?.stock || {},
    notificationPolicy: source.notificationPolicy && typeof source.notificationPolicy === "object" ? {
      enabled: source.notificationPolicy.enabled !== false,
      repeatAfterMinutes: Number(source.notificationPolicy.repeatAfterMinutes || 30),
      escalationAfterMinutes: Number(source.notificationPolicy.escalationAfterMinutes || 120),
    } : current?.notificationPolicy || {},
    ...(current ? { updatedByUserId: actorId } : { createdByUserId: actorId, updatedByUserId: actorId }),
  };
};

const validateOrder = (payload) => {
  const fields = {};
  if (!payload.name) fields.name = "Medicine name is required.";
  if (!Number.isFinite(payload.doseQuantity) || payload.doseQuantity <= 0 || payload.doseQuantity > 100000) fields.doseQuantity = "Enter a valid dose quantity.";
  if (!payload.doseUnit) fields.doseUnit = "Dose unit is required.";
  if (!payload.startDate) fields.startDate = "Enter a valid start date.";
  if (payload.endDate === undefined) fields.endDate = "Enter a valid end date or choose no end date.";
  if (payload.endDate && payload.startDate && payload.endDate < payload.startDate) fields.endDate = "End date cannot be before the start date.";
  if (!foodInstructions.has(payload.foodInstruction)) fields.foodInstruction = "Choose a supported food instruction.";
  if (payload.stock?.quantity !== null && payload.stock?.quantity !== undefined && (!Number.isFinite(payload.stock.quantity) || payload.stock.quantity < 0)) fields.stock = "Stock quantity cannot be negative.";
  if (payload.stock?.lowStockThreshold !== null && payload.stock?.lowStockThreshold !== undefined && (!Number.isFinite(payload.stock.lowStockThreshold) || payload.stock.lowStockThreshold < 0)) fields.stock = "Low-stock threshold cannot be negative.";
  if (!Number.isFinite(Number(payload.notificationPolicy?.repeatAfterMinutes)) || Number(payload.notificationPolicy.repeatAfterMinutes) < 5 || Number(payload.notificationPolicy.repeatAfterMinutes) > 1440) fields.notificationPolicy = "Repeat reminder must be between 5 minutes and 24 hours.";
  return fields;
};

const schedulePayload = (body = {}, order, profile, actorId, current = null) => {
  const source = current ? { ...current.toObject(), ...body } : body;
  const timezone = text(source.timezone, 80) || profile.timezone || "Asia/Kolkata";
  const activeStartDate = dateInput(source.activeStartDate || order.startDate?.toISOString?.().slice(0, 10));
  const activeEndDate = source.activeEndDate === null || source.activeEndDate === "" ? null : dateInput(source.activeEndDate || order.endDate?.toISOString?.().slice(0, 10));
  return {
    medicationOrderId: order._id,
    patientProfileId: profile._id,
    scheduleType: text(source.scheduleType, 40),
    localTimes: Array.isArray(source.localTimes) ? [...new Set(source.localTimes.map((item) => text(item, 5)).filter((item) => TIME.test(item)))].sort() : [],
    weekdays: Array.isArray(source.weekdays) ? [...new Set(source.weekdays.map(Number).filter((item) => Number.isInteger(item) && item >= 0 && item <= 6))].sort() : [],
    intervalHours: source.intervalHours === null || source.intervalHours === "" ? null : Number(source.intervalHours),
    timezone,
    fixedToProfileTimezone: source.fixedToProfileTimezone !== false,
    activeStartDate,
    activeEndDate,
    status: order.status === "active" ? (source.status === "paused" || source.status === "stopped" ? source.status : "active") : order.status,
    ...(current ? { updatedByUserId: actorId } : { createdByUserId: actorId, updatedByUserId: actorId }),
  };
};

const validateSchedule = (payload) => {
  const fields = validateMedicationScheduleInput(payload);
  if (!MEDICATION_SCHEDULE_TYPES.includes(payload.scheduleType)) fields.scheduleType = "Choose a supported frequency.";
  if (!payload.activeStartDate) fields.activeStartDate = "Enter a valid schedule start date.";
  if (payload.activeEndDate === undefined) fields.activeEndDate = "Enter a valid schedule end date.";
  if (payload.activeEndDate && payload.activeStartDate && payload.activeEndDate < payload.activeStartDate) fields.activeEndDate = "Schedule end date cannot be before start date.";
  return fields;
};

const sendValidation = (res, fields) => res.status(400).json({ success: false, code: "VALIDATION_ERROR", message: "Please correct the highlighted fields.", error: { code: "VALIDATION_ERROR", fields } });

export const listMedications = async (req, res) => {
  const [orders, schedules] = await Promise.all([
    MedicationOrder.find({ patientProfileId: req.patientProfile._id }).sort({ status: 1, createdAt: -1 }),
    MedicationSchedule.find({ patientProfileId: req.patientProfile._id }).sort({ createdAt: -1 }),
  ]);
  const scheduleByOrder = new Map(schedules.map((schedule) => [String(schedule.medicationOrderId), schedule]));
  return res.json({ success: true, data: { medications: orders.map((order) => orderView(order, scheduleByOrder.get(String(order._id)) || null)) } });
};

export const createMedication = async (req, res) => {
  const order = new MedicationOrder(orderPayload(req.body || {}, req.patientProfile._id, req.auth.id));
  const orderFields = validateOrder(order.toObject());
  const scheduleData = schedulePayload(req.body?.schedule || {}, order, req.patientProfile, req.auth.id);
  const scheduleFields = validateSchedule(scheduleData);
  const fields = { ...orderFields, ...Object.fromEntries(Object.entries(scheduleFields).map(([key, value]) => [`schedule.${key}`, value])) };
  if (Object.keys(fields).length) return sendValidation(res, fields);
  try {
    await order.save();
    const schedule = await MedicationSchedule.create(scheduleData);
    await generateRollingDoseEvents({ schedule });
    await writeAuditLog({ req, action: "family_medication_created", resourceType: "MedicationOrder", resourceId: order._id, patientProfileId: req.patientProfile._id, statusCode: 201 });
    return res.status(201).json({ success: true, data: { medication: orderView(order, schedule) } });
  } catch (error) {
    await MedicationOrder.deleteOne({ _id: order._id }).catch(() => undefined);
    if (error?.code === 11000) return res.status(409).json({ success: false, code: "MEDICATION_DUPLICATE", message: "This medicine schedule was already created." });
    console.error("Family Care medication create failed:", error.message);
    return res.status(500).json({ success: false, code: "MEDICATION_CREATE_FAILED", message: "Unable to create this medicine." });
  }
};

export const updateMedication = async (req, res) => {
  const order = await MedicationOrder.findOne({ _id: req.params.medicationId, patientProfileId: req.patientProfile._id });
  if (!order) return res.status(404).json({ success: false, code: "MEDICATION_NOT_FOUND", message: "Medicine not found." });
  const payload = orderPayload(req.body || {}, req.patientProfile._id, req.auth.id, order);
  const orderFields = validateOrder(payload);
  const schedule = await MedicationSchedule.findOne({ medicationOrderId: order._id, patientProfileId: req.patientProfile._id });
  const scheduleData = req.body?.schedule !== undefined && schedule
    ? schedulePayload(req.body.schedule || {}, order, req.patientProfile, req.auth.id, schedule)
    : null;
  const scheduleFields = scheduleData ? validateSchedule(scheduleData) : {};
  const fields = { ...orderFields, ...Object.fromEntries(Object.entries(scheduleFields).map(([key, value]) => [`schedule.${key}`, value])) };
  if (Object.keys(fields).length) return sendValidation(res, fields);
  Object.assign(order, payload);
  if (req.body?.stock !== undefined) {
    order.lowStockNotificationSentAt = null;
    order.refillReminderSentAt = null;
  }
  await order.save();
  if (scheduleData && schedule) {
    await cancelFuturePendingDoseEvents({ medicationScheduleId: schedule._id, reason: "schedule_changed" });
    Object.assign(schedule, scheduleData);
    await schedule.save();
    await generateRollingDoseEvents({ schedule });
  }
  await writeAuditLog({ req, action: "family_medication_updated", resourceType: "MedicationOrder", resourceId: order._id, patientProfileId: req.patientProfile._id });
  return res.json({ success: true, data: { medication: orderView(order, scheduleData ? schedule : schedule) } });
};

const changeMedicationState = (state) => async (req, res) => {
  const order = await MedicationOrder.findOne({ _id: req.params.medicationId, patientProfileId: req.patientProfile._id });
  if (!order) return res.status(404).json({ success: false, code: "MEDICATION_NOT_FOUND", message: "Medicine not found." });
  order.status = state;
  order.updatedByUserId = req.auth.id;
  await order.save();
  const schedules = await MedicationSchedule.find({ medicationOrderId: order._id });
  for (const schedule of schedules) {
    schedule.status = state;
    schedule.updatedByUserId = req.auth.id;
    await schedule.save();
    if (state === "active") await generateRollingDoseEvents({ schedule });
    else await cancelFuturePendingDoseEvents({
      medicationScheduleId: schedule._id,
      reason: `medication_${state}`,
      statuses: ["pending", "snoozed"],
    });
  }
  await writeAuditLog({ req, action: `family_medication_${state}`, resourceType: "MedicationOrder", resourceId: order._id, patientProfileId: req.patientProfile._id });
  return res.json({ success: true, data: { medication: orderView(order, schedules[0] || null) } });
};

export const pauseMedication = changeMedicationState("paused");
export const resumeMedication = changeMedicationState("active");
export const stopMedication = changeMedicationState("stopped");

export const listTodayDoses = async (req, res) => {
  const timezone = req.patientProfile.timezone || "Asia/Kolkata";
  const requestedDate = DATE.test(text(req.query.date, 16)) ? text(req.query.date, 16) : localDateFor(new Date(), timezone);
  const start = zonedDateTimeToUtc(requestedDate, "00:00", timezone);
  const end = zonedDateTimeToUtc(requestedDate, "23:59", timezone);
  const events = await MedicationDoseEvent.find({ patientProfileId: req.patientProfile._id, scheduledAt: { $gte: start, $lte: end } })
    .populate("medicationOrderId", "name strength dosageForm doseQuantity doseUnit foodInstruction")
    .sort({ scheduledAt: 1 });
  return res.json({ success: true, data: { date: requestedDate, timezone, doses: events.map(doseView) } });
};

const actionIdempotencyKey = (req) => text(req.get("Idempotency-Key"), 128);
const allowedAction = new Set(["taken", "skipped", "snoozed", "missed"]);

const doseAction = (action, { correction = false } = {}) => async (req, res) => {
  const event = await MedicationDoseEvent.findOne({ _id: req.params.doseEventId, patientProfileId: req.patientProfile._id })
    .populate("medicationOrderId")
    .populate("patientProfileId");
  if (!event) return res.status(404).json({ success: false, code: "DOSE_EVENT_NOT_FOUND", message: "Dose event not found." });
  const key = actionIdempotencyKey(req);
  if (!key || key.length < 8) return res.status(400).json({ success: false, code: "IDEMPOTENCY_KEY_REQUIRED", message: "Use an Idempotency-Key to update a dose." });
  if (event.actionIdempotencyKey === key) return res.json({ success: true, data: { dose: doseView(event), replayed: true } });
  if (!correction && !["pending", "due", "snoozed", "missed"].includes(event.status)) return res.status(409).json({ success: false, code: "DOSE_ALREADY_CONFIRMED", message: "This dose was already confirmed." });
  if (action === "snoozed") {
    const minutes = Number(req.body?.minutes || 15);
    if (!Number.isFinite(minutes) || minutes < 5 || minutes > 480) return res.status(400).json({ success: false, code: "INVALID_SNOOZE_DURATION", message: "Snooze between 5 minutes and 8 hours." });
    event.snoozedUntil = new Date(Date.now() + minutes * 60 * 1000);
  } else {
    event.confirmedAt = new Date();
  }
  event.status = action;
  event.confirmingUserId = req.auth.id;
  event.actionIdempotencyKey = key;
  event.audit.push({ action, actorUserId: req.auth.id, at: new Date(), details: action === "snoozed" ? { minutes: Number(req.body?.minutes || 15) } : {} });
  await event.save();
  await writeAuditLog({ req, action: `family_medication_dose_${action}`, resourceType: "MedicationDoseEvent", resourceId: event._id, patientProfileId: req.patientProfile._id });
  if (["taken", "skipped"].includes(action) && event.medicationOrderId && event.patientProfileId) {
    sendDoseActionConfirmation({ event, order: event.medicationOrderId, profile: event.patientProfileId, action }).catch((error) => console.error("Family Care dose confirmation notification failed:", error.message));
  }
  return res.json({ success: true, data: { dose: doseView(event) } });
};

export const markDoseTaken = doseAction("taken");
export const markDoseSkipped = doseAction("skipped");
export const snoozeDose = doseAction("snoozed");

export const correctDose = async (req, res) => {
  const status = text(req.body?.status, 20);
  if (!allowedAction.has(status) || status === "snoozed") return res.status(400).json({ success: false, code: "INVALID_DOSE_CORRECTION", message: "A dose can be corrected to taken, skipped, or missed." });
  return doseAction(status, { correction: true })(req, res);
};
