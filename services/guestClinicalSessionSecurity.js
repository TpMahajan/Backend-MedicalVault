import crypto from "crypto";
import jwt from "jsonwebtoken";
import { encryptField } from "../utils/fieldEncryption.js";
import { GuestClinicalAuditEvent } from "../models/GuestClinicalAuditEvent.js";

const ttl = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
export const GUEST_INVITATION_MINUTES = ttl(process.env.GUEST_INVITATION_MINUTES, 10);
export const GUEST_ACTIVE_MINUTES = ttl(process.env.GUEST_ACTIVE_MINUTES, 20);
export const GUEST_MAX_MINUTES = ttl(process.env.GUEST_MAX_MINUTES, 120);
export const GUEST_OTP_MINUTES = Math.min(ttl(process.env.GUEST_OTP_MINUTES, 5), 5);
export const GUEST_OTP_MAX_ATTEMPTS = 5;
export const GUEST_JOIN_MAX_ATTEMPTS = ttl(process.env.GUEST_JOIN_MAX_ATTEMPTS, 8);

const secret = () => {
  const value = String(process.env.GUEST_SESSION_SECRET || process.env.JWT_SECRET || "");
  if (value.length < 32) throw new Error("GUEST_SESSION_SECRET must be at least 32 characters");
  return value;
};
const hmacSecret = () => String(process.env.GUEST_IP_HMAC_SECRET || process.env.GUEST_SESSION_SECRET || process.env.JWT_SECRET || "");
export const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
export const hmac = (value) => crypto.createHmac("sha256", hmacSecret()).update(String(value)).digest("hex");
export const invitationId = () => crypto.randomBytes(32).toString("base64url");
// Human-entered code is separate from the 256-bit invitation reference. Use a
// fixed alphabet/length (about 71 bits) so formatting cannot reduce entropy.
export const joinCode = () => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 12 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
};
export const otpCode = () => String(crypto.randomInt(100000, 1000000));

export const maskEmail = (email) => {
  const [local = "", domain = ""] = String(email || "").trim().toLowerCase().split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1) || "*"}***@${domain}`;
};
export const maskIp = (ip) => {
  const raw = String(ip || "").replace(/^::ffff:/, "");
  if (raw.includes(".")) { const p = raw.split("."); return p.length === 4 ? `${p[0]}.${p[1]}.xxx.xxx` : "masked"; }
  if (raw.includes(":")) { const p = raw.split(":").filter(Boolean); return `${p.slice(0, 2).join(":")}::xxxx`; }
  return "masked";
};
const clientIp = (req) => String(req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
const browserFamily = (ua) => /edg\//i.test(ua) ? "Edge" : /firefox/i.test(ua) ? "Firefox" : /chrome|crios/i.test(ua) ? "Chrome" : /safari/i.test(ua) ? "Safari" : "Unknown";
const osFamily = (ua) => /android/i.test(ua) ? "Android" : /iphone|ipad|ios/i.test(ua) ? "iOS" : /windows/i.test(ua) ? "Windows" : /mac os/i.test(ua) ? "macOS" : /linux/i.test(ua) ? "Linux" : "Unknown";

export const networkEvidence = (req) => {
  const ip = clientIp(req); const ua = String(req.headers["user-agent"] || "").slice(0, 512);
  return {
    ipEncrypted: encryptField(ip), ipHash: hmac(`ip:${ip}`), ipMasked: maskIp(ip),
    ipVersion: ip.includes(":") ? 6 : ip.includes(".") ? 4 : null,
    trustedProxyChain: Array.isArray(req.ips) ? req.ips.slice(-4).map(maskIp) : [],
    userAgentSanitized: ua.replace(/[\r\n]/g, " "), browserFamily: browserFamily(ua), osFamily: osFamily(ua),
    deviceCategory: /mobile|android|iphone/i.test(ua) ? "mobile" : "desktop",
    language: String(req.headers["accept-language"] || "").slice(0, 80), timezone: String(req.headers["x-client-timezone"] || "").slice(0, 80),
    firstSeenAt: new Date(), lastSeenAt: new Date(), requestIds: [String(req.headers["x-request-id"] || crypto.randomUUID())], riskSignals: [],
  };
};

export const signGuestCookie = (payload, expiresIn = "15m") => jwt.sign({ ...payload, aud: "guest-clinical-session", iss: "medical-vault", jti: crypto.randomUUID() }, secret(), { expiresIn });
export const verifyGuestCookie = (token) => jwt.verify(String(token || ""), secret(), { audience: "guest-clinical-session", issuer: "medical-vault" });
export const readCookies = (req) => String(req.headers.cookie || "").split(";").reduce((out, part) => { const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); return out; }, {});

const cookieOptions = (maxAge) => ({ httpOnly: true, secure: String(process.env.COOKIE_SECURE || "true").toLowerCase() === "true", sameSite: "none", path: "/api/public/guest-sessions", maxAge });
export const setGuestCookie = (res, payload, maxAge = 20 * 60 * 1000) => res.cookie("mv_gcs", signGuestCookie(payload), cookieOptions(maxAge));
export const setGuestPreAuthCookie = (res, payload, maxAge = 12 * 60 * 1000) => res.cookie("mv_gcs_pre", signGuestCookie(payload, "12m"), cookieOptions(maxAge));
export const clearGuestCookies = (res) => { const options = cookieOptions(0); res.clearCookie("mv_gcs", options); res.clearCookie("mv_gcs_pre", options); };

export const getGuestCookie = (req, name = "mv_gcs") => { try { return verifyGuestCookie(readCookies(req)[name]); } catch { return null; } };
export const auditGuestEvent = async ({ session, req, actorType, actorId = "", eventType, resourceType = "guest_session", resourceId = "", outcome = "success", metadata = {} }) => {
  const last = await GuestClinicalAuditEvent.findOne({ sessionId: session._id }).sort({ createdAt: -1 }).select("eventHash").lean();
  const previousEventHash = String(last?.eventHash || "");
  const safe = { ...metadata }; delete safe.email; delete safe.otp; delete safe.token; delete safe.ip;
  const payload = JSON.stringify({ previousEventHash, sessionId: String(session._id), actorType, actorId, eventType, resourceType, resourceId, outcome, metadata: safe });
  await GuestClinicalAuditEvent.create({ sessionId: session._id, patientId: session.patientId, actorType, actorId, eventType, resourceType, resourceId, outcome, requestId: String(req?.headers?.["x-request-id"] || ""), ipHash: session.networkEvidence?.ipHash || "", metadata: safe, previousEventHash, eventHash: hmac(payload) });
};

export const verificationLabel = (value) => ({
  medical_vault_verified: "Verified Medical Vault Doctor", registration_verified: "Verified Guest Doctor",
  email_verified_registration_claimed: "Unverified Guest Clinician — Registration Not Confirmed",
  email_verified_unverified: "Unknown Guest — Email Verified Only", unknown_unverified: "Unknown Guest — Identity Not Verified",
}[value] || "Unknown Guest — Identity Not Verified");
