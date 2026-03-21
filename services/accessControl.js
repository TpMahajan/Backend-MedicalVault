import { Session } from "../models/Session.js";
import { DoctorPatientAssignment } from "../models/DoctorPatientAssignment.js";

export const hasActiveSession = async (doctorId, patientId) => {
  if (!doctorId || !patientId) return false;
  const activeSession = await Session.findOne({
    doctorId,
    patientId,
    status: "accepted",
    expiresAt: { $gt: new Date() },
  })
    .select("_id")
    .lean();
  return !!activeSession;
};

export const hasActiveAssignment = async (doctorId, patientId) => {
  if (!doctorId || !patientId) return false;
  const assignment = await DoctorPatientAssignment.findOne({
    doctorId,
    patientId,
    status: "active",
  })
    .select("_id")
    .lean();
  return !!assignment;
};

export const canDoctorAccessPatient = async (doctorId, patientId) => {
  if (!doctorId || !patientId) return false;
  const [assigned, sessionActive] = await Promise.all([
    hasActiveAssignment(doctorId, patientId),
    hasActiveSession(doctorId, patientId),
  ]);
  return assigned || sessionActive;
};

export const ensureDoctorPatientAssignment = async ({ doctorId, patientId, source = "session", assignedBy = {} }) => {
  if (!doctorId || !patientId) return null;
  return DoctorPatientAssignment.findOneAndUpdate(
    { doctorId, patientId, status: "active" },
    {
      $setOnInsert: {
        doctorId,
        patientId,
        status: "active",
        source,
        assignedBy,
        assignedAt: new Date(),
      },
    },
    { upsert: true, new: true }
  );
};

export const canAccessPatientResource = async ({ requesterRole, requesterId, patientId }) => {
  const role = String(requesterRole || "").toLowerCase();
  if (!requesterId || !patientId) return false;

  if (role === "superadmin" || role === "admin") return true;
  if (role === "patient") return String(requesterId) === String(patientId);
  if (role === "doctor") return canDoctorAccessPatient(String(requesterId), String(patientId));

  return false;
};
