import { canAccessPatientResource } from "../services/accessControl.js";

const normalizeRole = (role) => String(role || "").trim().toLowerCase();

export const checkRole = (...allowedRoles) => {
  const normalizedAllowed = allowedRoles.map((role) => normalizeRole(role));
  return (req, res, next) => {
    if (!req.auth?.id || !req.auth?.role) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const requesterRole = normalizeRole(req.auth.role);
    if (!normalizedAllowed.includes(requesterRole)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    return next();
  };
};

export const requirePatientResourceAccess = ({
  patientIdParam = "id",
  allowAdmin = true,
  allowSuperAdmin = true,
} = {}) => {
  return async (req, res, next) => {
    try {
      if (!req.auth?.id || !req.auth?.role) {
        return res.status(401).json({ success: false, message: "Authentication required" });
      }

      const patientId = String(req.params[patientIdParam] || req.body?.patientId || "").trim();
      if (!patientId) {
        return res.status(400).json({ success: false, message: "Patient identifier is required" });
      }

      const role = normalizeRole(req.auth.role);
      if (role === "admin" && !allowAdmin) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }
      if (role === "superadmin" && !allowSuperAdmin) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }

      const allowed = await canAccessPatientResource({
        requesterRole: req.auth.role,
        requesterId: req.auth.id,
        patientId,
      });

      if (!allowed) {
        return res.status(403).json({ success: false, message: "Access denied" });
      }

      req.patientId = patientId;
      return next();
    } catch (error) {
      console.error("Patient access guard error:", error.message);
      return res.status(403).json({ success: false, message: "Access denied" });
    }
  };
};

export const requireOwnerOrRoles = ({ ownerParam = "id", allowedRoles = ["admin", "superadmin"] } = {}) => {
  const normalized = allowedRoles.map((role) => normalizeRole(role));
  return (req, res, next) => {
    if (!req.auth?.id || !req.auth?.role) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    const role = normalizeRole(req.auth.role);
    const ownerId = String(req.params[ownerParam] || "").trim();

    if (ownerId && String(req.auth.id) === ownerId) {
      return next();
    }

    if (normalized.includes(role)) {
      return next();
    }

    return res.status(403).json({ success: false, message: "Access denied" });
  };
};
