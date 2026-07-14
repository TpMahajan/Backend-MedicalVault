import crypto from "crypto";
import { FamilyCareRateLimitBucket } from "../models/FamilyCareRateLimitBucket.js";
import { getFamilyCareConfig } from "../services/familyCareConfigService.js";

const actorKey = (req) => {
  const actor = String(req.auth?.id || "anonymous");
  return crypto.createHash("sha256").update(actor).digest("hex");
};

const familyCareRateLimiter = ({ kind, defaultMax, defaultWindowMinutes, errorCode, message }) => async (req, res, next) => {
  try {
    const config = await getFamilyCareConfig();
    const limits = kind === "search" ? config?.userSearch : config?.invitations;
    const windowMinutes = Math.max(1, Number(limits?.windowMinutes || defaultWindowMinutes));
    const maxPerWindow = Math.max(1, Number(limits?.maxPerWindow || defaultMax));
    const windowMs = windowMinutes * 60 * 1000;
    const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
    const expiresAt = new Date(windowStart + windowMs);
    const key = `care-${kind}:${actorKey(req)}:${windowStart}`;

    let bucket;
    try {
      bucket = await FamilyCareRateLimitBucket.findOneAndUpdate(
        { key },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean();
    } catch (error) {
      if (error?.code !== 11000) throw error;
      bucket = await FamilyCareRateLimitBucket.findOneAndUpdate(
        { key },
        { $inc: { count: 1 } },
        { new: true },
      ).lean();
    }

    const count = Number(bucket?.count || 0);
    res.setHeader("RateLimit-Limit", String(maxPerWindow));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, maxPerWindow - count)));
    res.setHeader("RateLimit-Reset", String(Math.ceil(expiresAt.getTime() / 1000)));
    if (count > maxPerWindow) {
      return res.status(429).json({
        success: false,
        code: errorCode,
        message,
      });
    }
    return next();
  } catch (error) {
    console.error("Family Care invitation limiter failed:", error.message);
    return res.status(503).json({
      success: false,
      code: "FAMILY_CARE_CONFIG_UNAVAILABLE",
      message: "Family Care configuration is temporarily unavailable",
    });
  }
};

export const familyCareInvitationLimiter = familyCareRateLimiter({
  kind: "invite",
  defaultMax: 10,
  defaultWindowMinutes: 60,
  errorCode: "FAMILY_CARE_INVITE_RATE_LIMITED",
  message: "Too many caregiver invitations. Please try again later.",
});

export const familyCareUserSearchLimiter = familyCareRateLimiter({
  kind: "search",
  defaultMax: 20,
  defaultWindowMinutes: 60,
  errorCode: "FAMILY_CARE_SEARCH_RATE_LIMITED",
  message: "Too many account searches. Please try again later.",
});
