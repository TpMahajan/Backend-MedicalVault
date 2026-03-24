import { AuditLog } from "../models/AuditLog.js";
import crypto from "crypto";

const asString = (value) => (value == null ? "" : String(value));
const SENSITIVE_KEYS = new Set([
  "password",
  "token",
  "refreshToken",
  "accessToken",
  "authorization",
  "email",
  "mobile",
  "phone",
  "ssn",
  "aadhaar",
  "pan",
]);

const maskValue = (value) => {
  const raw = asString(value);
  if (!raw) return raw;
  if (raw.length <= 4) return "***";
  return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
};

const sanitizeMetadata = (value) => {
  if (Array.isArray(value)) return value.map(sanitizeMetadata);
  if (!value || typeof value !== "object") return value;
  return Object.entries(value).reduce((acc, [key, val]) => {
    const normalizedKey = asString(key).toLowerCase();
    acc[key] = SENSITIVE_KEYS.has(normalizedKey) ? maskValue(val) : sanitizeMetadata(val);
    return acc;
  }, {});
};

const buildRecordHash = ({ previousHash, actorId, actorRole, action, resourceType, resourceId, patientId, statusCode, ipAddress, userAgent, requestId, metadata }) =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        previousHash,
        actorId,
        actorRole,
        action,
        resourceType,
        resourceId,
        patientId,
        statusCode,
        ipAddress,
        userAgent,
        requestId,
        metadata,
      })
    )
    .digest("hex");

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
    const latest = await AuditLog.findOne({}).sort({ createdAt: -1 }).select("recordHash").lean();
    const previousHash = asString(latest?.recordHash);
    const safeMetadata = sanitizeMetadata(metadata);
    const recordHash = buildRecordHash({
      previousHash,
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
      metadata: safeMetadata,
    });

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
      metadata: safeMetadata,
      previousHash,
      recordHash,
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
