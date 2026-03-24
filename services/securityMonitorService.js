import { SecurityAlert } from "../models/SecurityAlert.js";

const FAILED_LOGIN_THRESHOLD = Number(process.env.FAILED_LOGIN_THRESHOLD || 5);
const FAILED_LOGIN_WINDOW_MINUTES = Number(
  process.env.FAILED_LOGIN_WINDOW_MINUTES || 15
);

const normalize = (value) => String(value || "").trim().toLowerCase();
const TEMP_BLOCK_MINUTES = Number(process.env.SECURITY_TEMP_BLOCK_MINUTES || 15);

export const recordSecurityAlert = async ({
  type,
  severity = "MEDIUM",
  actorEmail = "",
  actorRole = "",
  ipAddress = "",
  userAgent = "",
  reason = "",
  metadata = {},
}) => {
  try {
    return await SecurityAlert.create({
      type,
      severity,
      actorEmail: normalize(actorEmail),
      actorRole: normalize(actorRole),
      ipAddress: String(ipAddress || "").trim(),
      userAgent: String(userAgent || "").trim(),
      reason: String(reason || "").trim(),
      metadata,
    });
  } catch (error) {
    console.error("Security alert write failed:", error.message);
    return null;
  }
};

export const monitorFailedLogin = async ({
  actorEmail = "",
  actorRole = "",
  ipAddress = "",
  userAgent = "",
  source = "auth",
}) => {
  try {
    const normalizedEmail = normalize(actorEmail);
    if (!normalizedEmail && !ipAddress) return null;

    const since = new Date(Date.now() - FAILED_LOGIN_WINDOW_MINUTES * 60 * 1000);
    const filter = {
      type: "MULTIPLE_FAILED_LOGINS",
      createdAt: { $gte: since },
      ...(normalizedEmail ? { actorEmail: normalizedEmail } : {}),
      ...(ipAddress ? { ipAddress: String(ipAddress) } : {}),
    };

    const recentCount = await SecurityAlert.countDocuments(filter);
    const nextCount = recentCount + 1;
    if (nextCount < FAILED_LOGIN_THRESHOLD) {
      return null;
    }

    const mediumAlert = await recordSecurityAlert({
      type: "MULTIPLE_FAILED_LOGINS",
      severity: "MEDIUM",
      actorEmail: normalizedEmail,
      actorRole,
      ipAddress,
      userAgent,
      reason: `Detected ${nextCount} failed login attempts within ${FAILED_LOGIN_WINDOW_MINUTES} minutes.`,
      metadata: {
        source,
        threshold: FAILED_LOGIN_THRESHOLD,
        windowMinutes: FAILED_LOGIN_WINDOW_MINUTES,
      },
    });

    if (nextCount >= FAILED_LOGIN_THRESHOLD * 2) {
      const blockUntil = new Date(Date.now() + TEMP_BLOCK_MINUTES * 60 * 1000);
      await recordSecurityAlert({
        type: "SUSPICIOUS_ACTIVITY",
        severity: "HIGH",
        actorEmail: normalizedEmail,
        actorRole,
        ipAddress,
        userAgent,
        reason: "Suspicious brute-force pattern detected. Temporary account block enforced.",
        metadata: {
          source,
          escalation: "TEMP_ACCOUNT_BLOCK",
          blockUntil: blockUntil.toISOString(),
          failedAttempts: nextCount,
          windowMinutes: FAILED_LOGIN_WINDOW_MINUTES,
        },
      });
      return { alert: mediumAlert, blockedUntil: blockUntil.toISOString(), isBlocked: true };
    }
    return { alert: mediumAlert, isBlocked: false };
  } catch (error) {
    console.error("Failed login monitor error:", error.message);
    return null;
  }
};

export const isActorTemporarilyBlocked = async ({ actorEmail = "", actorRole = "" }) => {
  const normalizedEmail = normalize(actorEmail);
  if (!normalizedEmail) return { isBlocked: false };
  const nowIso = new Date().toISOString();
  const recentHighAlert = await SecurityAlert.findOne({
    type: "SUSPICIOUS_ACTIVITY",
    severity: "HIGH",
    actorEmail: normalizedEmail,
    ...(actorRole ? { actorRole: normalize(actorRole) } : {}),
    "metadata.blockUntil": { $gt: nowIso },
  })
    .sort({ createdAt: -1 })
    .lean();
  return {
    isBlocked: !!recentHighAlert,
    blockedUntil: recentHighAlert?.metadata?.blockUntil || null,
  };
};

export const monitorSuspiciousSession = async ({
  actorEmail = "",
  actorRole = "",
  ipAddress = "",
  userAgent = "",
  event = "NEW_DEVICE_OR_LOCATION",
  metadata = {},
}) =>
  recordSecurityAlert({
    type: "SUSPICIOUS_ACTIVITY",
    severity: "HIGH",
    actorEmail,
    actorRole,
    ipAddress,
    userAgent,
    reason: "Suspicious session pattern detected",
    metadata: {
      event,
      ...metadata,
    },
  });

