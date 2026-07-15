import mongoose from "mongoose";
import { Session } from "../models/Session.js";
import { Appointment } from "../models/Appointment.js";

const asText = (value) => (value == null ? "" : String(value).trim());

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(asText(value));

/**
 * Resolves whether a doctor and patient have any linked Session or
 * Appointment record — the authorization gate for all direct-chat
 * operations (send, read, and now typing). Extracted from
 * routes/sessionRoutes.js so the raw-WebSocket typing path
 * (services/chatPresenceRealtime.js) can apply the same check the REST
 * routes already enforce, instead of trusting a client-supplied
 * counterpartId with no verification.
 */
export const resolveDoctorPatientLink = async ({ doctorId, patientId }) => {
  if (!isValidObjectId(doctorId) || !isValidObjectId(patientId)) {
    return {
      linkedSession: null,
      linkedAppointment: null,
      relationType: "",
      relationId: "",
    };
  }

  const normalizedDoctorId = asText(doctorId);
  const normalizedPatientId = asText(patientId);
  const patientIdVariants = [normalizedPatientId];

  const linkedSession = await Session.findOne({
    doctorId: normalizedDoctorId,
    patientId: normalizedPatientId,
    status: { $in: ["pending", "accepted", "ended", "declined"] },
  })
    .sort({ createdAt: -1 })
    .select("_id status createdAt")
    .lean();

  const linkedAppointment = linkedSession
    ? null
    : await Appointment.findOne({
        doctorId: normalizedDoctorId,
        patientId: { $in: patientIdVariants },
      })
        .sort({ appointmentDate: -1, createdAt: -1 })
        .select("_id appointmentDate createdAt")
        .lean();

  return {
    linkedSession,
    linkedAppointment,
    relationType: linkedSession
      ? "session"
      : linkedAppointment
      ? "appointment"
      : "",
    relationId: linkedSession
      ? linkedSession._id.toString()
      : linkedAppointment
      ? linkedAppointment._id.toString()
      : "",
  };
};

export const isDoctorPatientLinked = async ({ doctorId, patientId }) => {
  const relation = await resolveDoctorPatientLink({ doctorId, patientId });
  return Boolean(relation.linkedSession || relation.linkedAppointment);
};
