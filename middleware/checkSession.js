import { User } from "../models/User.js";
import { canDoctorAccessPatient } from "../services/accessControl.js";

const privilegedRoles = new Set(["admin", "superadmin"]);

const normalizeRole = (role) => String(role || "").trim().toLowerCase();

const resolvePatientIdFromRequest = async (req) => {
  const direct = req.params.userId || req.params.patientId || req.params.id || "";
  if (!direct) return "";

  if (req.params?.id && !req.params?.userId && !req.params?.patientId) {
    try {
      const { Document } = await import("../models/File.js");
      const doc = await Document.findById(req.params.id).select("userId").lean();
      if (doc?.userId) {
        return String(doc.userId);
      }
    } catch {
      // Fall through and treat :id as patient id.
    }
  }

  return String(direct);
};

/**
 * Fail-closed session/relationship guard for patient resources.
 */
export const checkSession = async (req, res, next) => {
  try {
    if (!req.auth?.id || !req.auth?.role) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const role = normalizeRole(req.auth.role);
    const patientId = await resolvePatientIdFromRequest(req);

    if (!patientId) {
      return res.status(403).json({ success: false, message: "Patient context required" });
    }

    if (privilegedRoles.has(role)) {
      req.patientId = patientId;
      return next();
    }

    if (role === "patient") {
      if (String(req.auth.id) !== String(patientId)) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
      req.patientId = patientId;
      return next();
    }

    if (role !== "doctor") {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const allowed = await canDoctorAccessPatient(String(req.auth.id), String(patientId));
    if (!allowed) {
      return res.status(403).json({
        success: false,
        message: "No active doctor-patient relationship",
        code: "NO_ACTIVE_SESSION",
      });
    }

    req.patientId = patientId;
    return next();
  } catch (error) {
    console.error("Session access guard error:", error);
    return res.status(403).json({ success: false, message: "Access denied" });
  }
};

/**
 * Email-based variant used by grouped document endpoint.
 */
export const checkSessionByEmail = async (req, res, next) => {
  try {
    if (!req.auth?.id || !req.auth?.role) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const email = String(req.params.email || "").trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ success: false, message: "Email parameter is required" });
    }

    const patient = await User.findOne({ email }).select("_id").lean();
    if (!patient?._id) {
      return res.status(404).json({ success: false, message: "Patient not found" });
    }

    req.params.id = String(patient._id);
    req.params.patientId = String(patient._id);
    return checkSession(req, res, next);
  } catch (error) {
    console.error("Email-based session guard error:", error);
    return res.status(403).json({ success: false, message: "Access denied" });
  }
};

export const bypassSessionCheck = (req, res, next) => {
  req.bypassSession = true;
  next();
};
