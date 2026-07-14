import mongoose from "mongoose";
import { Appointment } from "../models/Appointment.js";
import { DoctorUser } from "../models/DoctorUser.js";
import { writeAuditLog } from "../middleware/auditLogger.js";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const appointmentTypes = new Set(["consultation", "follow-up", "emergency", "routine", "specialist"]);
const modes = new Set(["in-person", "online"]);
const text = (value, max = 1000) => String(value ?? "").trim().slice(0, max);

const dateValue = (value) => {
  const raw = text(value, 16);
  if (!DATE.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw ? null : date;
};

const doctorView = (doctor) => ({
  id: String(doctor._id),
  name: text(doctor.name, 120),
  specialization: text(doctor.specialty || doctor.specialization, 120),
  location: text(doctor.location, 240),
  profilePicture: doctor.profilePictureUrl || doctor.profilePicture || null,
});

const appointmentView = (appointment) => ({
  id: String(appointment._id),
  patientProfileId: String(appointment.patientProfileId),
  appointmentDate: appointment.appointmentDate?.toISOString?.().slice(0, 10) || null,
  appointmentTime: appointment.appointmentTime,
  duration: appointment.duration,
  reason: appointment.reason,
  appointmentType: appointment.appointmentType,
  mode: appointment.mode || "in-person",
  notes: appointment.notes || "",
  status: appointment.status,
  doctor: appointment.doctorId?.name
    ? doctorView(appointment.doctorId)
    : {
        id: String(appointment.doctorId || ""),
        name: appointment.doctorName,
        specialization: appointment.doctorSpecialization || "",
        location: appointment.hospitalClinicName || "",
        profilePicture: null,
      },
  createdAt: appointment.createdAt,
  updatedAt: appointment.updatedAt,
});

const fieldsFor = (body = {}, { creation = false } = {}) => {
  const fields = {};
  const appointmentDate = body.appointmentDate === undefined ? undefined : dateValue(body.appointmentDate);
  const appointmentTime = body.appointmentTime === undefined ? undefined : text(body.appointmentTime, 5);
  const reason = body.reason === undefined ? undefined : text(body.reason, 1000);
  const appointmentType = body.appointmentType === undefined ? undefined : text(body.appointmentType, 40);
  const mode = body.mode === undefined ? undefined : text(body.mode, 20);
  const duration = body.duration === undefined ? undefined : Number(body.duration);
  if (creation && !appointmentDate) fields.appointmentDate = "Choose a valid appointment date.";
  if (creation && !appointmentTime) fields.appointmentTime = "Choose an appointment time.";
  if (creation && !reason) fields.reason = "Reason for visit is required.";
  if (appointmentDate === null) fields.appointmentDate = "Use YYYY-MM-DD.";
  if (appointmentTime !== undefined && !TIME.test(appointmentTime)) fields.appointmentTime = "Use HH:mm.";
  if (reason !== undefined && !reason) fields.reason = "Reason for visit is required.";
  if (appointmentType !== undefined && !appointmentTypes.has(appointmentType)) fields.appointmentType = "Choose a supported appointment type.";
  if (mode !== undefined && !modes.has(mode)) fields.mode = "Choose in-person or online.";
  if (duration !== undefined && (!Number.isInteger(duration) || duration < 15 || duration > 120)) {
    fields.duration = "Duration must be between 15 and 120 minutes.";
  }
  return { fields, appointmentDate, appointmentTime, reason, appointmentType, mode, duration };
};

const validation = (res, fields) => res.status(400).json({
  success: false,
  code: "VALIDATION_ERROR",
  message: "Please correct the highlighted fields.",
  error: { code: "VALIDATION_ERROR", fields },
});

export const listFamilyDoctors = async (_req, res) => {
  const doctors = await DoctorUser.find({ isActive: true })
    .select("name specialty specialization location profilePicture profilePictureUrl")
    .sort({ name: 1 })
    .limit(200)
    .lean();
  return res.json({ success: true, data: { doctors: doctors.map(doctorView) } });
};

export const listFamilyAppointments = async (req, res) => {
  const status = text(req.query.status, 40);
  const query = { patientProfileId: req.patientProfile._id };
  if (status) query.status = status;
  const appointments = await Appointment.find(query)
    .populate("doctorId", "name specialty specialization location profilePicture profilePictureUrl")
    .sort({ appointmentDate: 1, appointmentTime: 1 });
  return res.json({ success: true, data: { appointments: appointments.map(appointmentView) } });
};

export const getFamilyAppointment = async (req, res) => {
  const appointment = await Appointment.findOne({ _id: req.params.appointmentId, patientProfileId: req.patientProfile._id })
    .populate("doctorId", "name specialty specialization location profilePicture profilePictureUrl");
  if (!appointment) return res.status(404).json({ success: false, code: "APPOINTMENT_NOT_FOUND", message: "Appointment not found." });
  return res.json({ success: true, data: { appointment: appointmentView(appointment) } });
};

export const createFamilyAppointment = async (req, res) => {
  const doctorId = text(req.body?.doctorId, 80);
  if (!mongoose.isValidObjectId(doctorId)) return validation(res, { doctorId: "Choose a valid doctor." });
  const input = fieldsFor(req.body, { creation: true });
  if (Object.keys(input.fields).length) return validation(res, input.fields);
  const doctor = await DoctorUser.findOne({ _id: doctorId, isActive: true });
  if (!doctor) return res.status(404).json({ success: false, code: "DOCTOR_NOT_FOUND", message: "Doctor not found." });
  const profile = req.patientProfile;
  const appointment = await Appointment.create({
    // This legacy required field remains for compatibility. Family Care access
    // and queries are always anchored by patientProfileId.
    patientId: String(profile.identityUserId || profile.primaryOwnerUserId),
    patientProfileId: profile._id,
    createdByUserId: req.auth.id,
    managedByCaregiverUserId: String(profile.identityUserId || "") === String(req.auth.id) ? null : req.auth.id,
    patientName: profile.displayName,
    appointmentDate: input.appointmentDate,
    appointmentTime: input.appointmentTime,
    duration: input.duration ?? 30,
    reason: input.reason,
    appointmentType: input.appointmentType || "consultation",
    mode: input.mode || "in-person",
    notes: text(req.body?.notes, 2000),
    doctorId: doctor._id,
    doctorName: doctor.name,
    doctorSpecialization: doctor.specialty || doctor.specialization || "",
    hospitalClinicName: doctor.location || "",
    status: "pending",
  });
  await writeAuditLog({ req, action: "family_appointment_created", resourceType: "Appointment", resourceId: appointment._id, patientProfileId: profile._id, statusCode: 201 });
  try {
    const { sendNotificationToDoctor } = await import("../utils/notifications.js");
    if (doctor.fcmToken) await sendNotificationToDoctor(String(doctor._id), "New Family Care appointment request", `${profile.displayName} has requested an appointment.`, { type: "APPOINTMENT_PENDING", appointmentId: String(appointment._id), patientProfileId: String(profile._id) });
  } catch (_) {
    // Appointment creation is durable even if a best-effort device delivery fails.
  }
  return res.status(201).json({ success: true, data: { appointment: appointmentView(appointment) } });
};

export const updateFamilyAppointment = async (req, res) => {
  const appointment = await Appointment.findOne({ _id: req.params.appointmentId, patientProfileId: req.patientProfile._id });
  if (!appointment) return res.status(404).json({ success: false, code: "APPOINTMENT_NOT_FOUND", message: "Appointment not found." });
  if (["cancelled", "completed", "no-show"].includes(appointment.status)) return res.status(409).json({ success: false, code: "APPOINTMENT_NOT_EDITABLE", message: "This appointment can no longer be edited." });
  const input = fieldsFor(req.body);
  if (Object.keys(input.fields).length) return validation(res, input.fields);
  if (input.appointmentDate !== undefined) appointment.appointmentDate = input.appointmentDate;
  if (input.appointmentTime !== undefined) appointment.appointmentTime = input.appointmentTime;
  if (input.reason !== undefined) appointment.reason = input.reason;
  if (input.appointmentType !== undefined) appointment.appointmentType = input.appointmentType;
  if (input.mode !== undefined) appointment.mode = input.mode;
  if (input.duration !== undefined) appointment.duration = input.duration;
  if (req.body?.notes !== undefined) appointment.notes = text(req.body.notes, 2000);
  appointment.status = "pending";
  await appointment.save();
  await writeAuditLog({ req, action: "family_appointment_updated", resourceType: "Appointment", resourceId: appointment._id, patientProfileId: req.patientProfile._id });
  return res.json({ success: true, data: { appointment: appointmentView(appointment) } });
};

export const cancelFamilyAppointment = async (req, res) => {
  const appointment = await Appointment.findOne({ _id: req.params.appointmentId, patientProfileId: req.patientProfile._id });
  if (!appointment) return res.status(404).json({ success: false, code: "APPOINTMENT_NOT_FOUND", message: "Appointment not found." });
  if (["cancelled", "completed", "no-show"].includes(appointment.status)) return res.status(409).json({ success: false, code: "APPOINTMENT_NOT_CANCELLABLE", message: "This appointment can no longer be cancelled." });
  appointment.status = "cancelled";
  await appointment.save();
  await writeAuditLog({ req, action: "family_appointment_cancelled", resourceType: "Appointment", resourceId: appointment._id, patientProfileId: req.patientProfile._id });
  return res.json({ success: true, data: { appointment: appointmentView(appointment) } });
};
