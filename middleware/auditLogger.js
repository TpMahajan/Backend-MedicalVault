import { AuditLog } from "../models/AuditLog.js";

const asString = (value) => (value == null ? "" : String(value));

export const writeAuditLog = async ({
  req,
  action,
  resourceType,
  resourceId = "",
  patientId = "",
  statusCode = 200,
  metadata = {},
}) => {
  try {
    const actorId = asString(req.auth?.id || req.superAdmin?.email || "anonymous");
    const actorRole = asString(req.auth?.role || req.superAdmin?.role || "anonymous").toLowerCase();

    await AuditLog.create({
      actorId,
      actorRole,
      action: asString(action),
      resourceType: asString(resourceType),
      resourceId: asString(resourceId),
      patientId: asString(patientId),
      statusCode: Number(statusCode) || 500,
      ipAddress: asString(req.ip),
      userAgent: asString(req.headers["user-agent"]),
      requestId: asString(req.headers["x-request-id"]),
      metadata,
    });
  } catch (error) {
    console.error("Audit log write failed:", error.message);
  }
};

export const auditTrail = ({ action, resourceType, getResourceId, getPatientId, getMetadata } = {}) => {
  return (req, res, next) => {
    res.on("finish", () => {
      if (res.statusCode >= 400) return;
      writeAuditLog({
        req,
        action,
        resourceType,
        resourceId: typeof getResourceId === "function" ? getResourceId(req, res) : "",
        patientId: typeof getPatientId === "function" ? getPatientId(req, res) : "",
        statusCode: res.statusCode,
        metadata: typeof getMetadata === "function" ? getMetadata(req, res) : {},
      });
    });
    next();
  };
};
