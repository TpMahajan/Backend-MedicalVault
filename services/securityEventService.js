import { SecurityEvent } from "../models/SecurityEvent.js";

const asString = (v) => (v == null ? "" : String(v));

export const recordSecurityEvent = async ({
  eventType = "CRITICAL_SECURITY_EVENT",
  severity = "MEDIUM",
  actorId = "",
  actorRole = "",
  ipAddress = "",
  userAgent = "",
  reason = "",
  breachFlag = false,
  metadata = {},
}) => {
  try {
    return await SecurityEvent.create({
      eventType,
      severity,
      actorId: asString(actorId),
      actorRole: asString(actorRole).toLowerCase(),
      ipAddress: asString(ipAddress),
      userAgent: asString(userAgent),
      reason: asString(reason),
      breachFlag: breachFlag === true,
      metadata,
    });
  } catch {
    return null;
  }
};

