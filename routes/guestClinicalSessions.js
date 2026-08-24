import crypto from "crypto";
import express from "express";
import mongoose from "mongoose";
import { auth } from "../middleware/auth.js";
import { guestClinicalSessionLimiter } from "../middleware/guestClinicalSessionRateLimit.js";
import { GuestClinicalSession } from "../models/GuestClinicalSession.js";
import { GuestClinicalConsent } from "../models/GuestClinicalConsent.js";
import { Document } from "../models/File.js";
import { PatientProfile } from "../models/PatientProfile.js";
import { generateSignedUrl, generateDownloadUrl } from "../utils/s3Utils.js";
import { sendGuestSessionOtpEmail } from "../utils/emailService.js";
import { deliverNotifications } from "../services/notificationDeliveryService.js";
import {
  GUEST_ACTIVE_MINUTES, GUEST_INVITATION_MINUTES, GUEST_JOIN_MAX_ATTEMPTS, GUEST_MAX_MINUTES, GUEST_OTP_MAX_ATTEMPTS, GUEST_OTP_MINUTES,
  auditGuestEvent, getGuestCookie, hmac, invitationId, joinCode, maskEmail, networkEvidence, otpCode, setGuestCookie, setGuestPreAuthCookie, clearGuestCookies, sha256, verificationLabel,
} from "../services/guestClinicalSessionSecurity.js";

const router = express.Router();
const publicRouter = express.Router();
const enabled = () => String(process.env.GUEST_CLINICAL_SESSIONS_ENABLED || "false").toLowerCase() === "true";
const objectId = (id) => mongoose.Types.ObjectId.isValid(String(id || ""));
const text = (value, max = 500) => String(value || "").trim().slice(0, max);
const GENERIC = { success: false, message: "This invitation is unavailable or cannot be completed." };
const allowedCategories = new Set(["Report", "Prescription", "Bill", "Insurance", "medicines", "allergies", "conditions", "vitals", "appointments", "emergency"]);
const terminal = new Set(["revoked", "rejected", "expired", "ended", "security_terminated"]);

const guard = (req, res, next) => enabled() ? next() : res.status(404).json({ success: false, message: "Not found" });
const safeStatus = (session) => {
  if (session.activeExpiresAt && session.activeExpiresAt <= new Date() && ["approved", "active"].includes(session.status)) { session.status = "expired"; session.endedAt = new Date(); }
  if (session.invitationExpiresAt <= new Date() && !["approved", "active", ...terminal].includes(session.status)) session.status = "expired";
  return session;
};
const patientScope = async (req, res, next) => {
  if (req.auth?.role !== "patient") return res.status(403).json({ success: false, message: "Patient access required" });
  next();
};
const requireGuest = async (req, res, next) => {
  const claims = getGuestCookie(req);
  if (!claims?.sid || !claims?.gid) return res.status(401).json(GENERIC);
  const session = await GuestClinicalSession.findById(claims.sid);
  if (!session || !session.guestParticipant || String(session.guestParticipant._id) !== String(claims.gid)) return res.status(401).json(GENERIC);
  await safeStatus(session); if (terminal.has(session.status)) { await session.save(); return res.status(401).json(GENERIC); }
  req.guestClaims = claims; req.guestSession = session; next();
};
const requirePreAuth = (req, res, next) => {
  const claims = getGuestCookie(req, "mv_gcs_pre");
  if (!claims?.sid) return res.status(401).json(GENERIC);
  req.guestPreAuth = claims; next();
};
const serialisePatient = (session) => ({
  id: String(session._id), status: session.status, invitationExpiresAt: session.invitationExpiresAt, activeExpiresAt: session.activeExpiresAt,
  riskStatus: session.riskStatus, requestedPermissions: session.requestedPermissions,
  draftDocumentIds: session.draftDocumentIds.map(String), draftCategories: session.draftCategories,
  guest: session.guestParticipant ? { claimedName: session.guestParticipant.claimedName, emailMasked: session.guestParticipant.emailMasked, registrationNumberProvided: Boolean(session.guestParticipant.registrationNumberEncrypted), medicalCouncil: session.guestParticipant.medicalCouncil, state: session.guestParticipant.state, organisation: session.guestParticipant.organisation, purpose: session.guestParticipant.purpose, verificationLevel: session.guestParticipant.verificationLevel, verificationLabel: verificationLabel(session.guestParticipant.verificationLevel), joinedAt: session.guestParticipant.joinedAt, ipMasked: session.networkEvidence?.ipMasked, browser: session.networkEvidence?.browserFamily, os: session.networkEvidence?.osFamily, deviceCategory: session.networkEvidence?.deviceCategory } : null,
});
const ensureDocsOwned = async ({ patientId, patientProfileId, documentIds }) => {
  const ids = [...new Set((documentIds || []).filter(objectId).map(String))];
  if (!ids.length) return [];
  const docs = await Document.find({ _id: { $in: ids }, userId: String(patientId), ...(patientProfileId ? { patientProfileId } : {}) }).select("_id").lean();
  if (docs.length !== ids.length) throw new Error("One or more selected documents cannot be shared");
  return docs.map((doc) => doc._id);
};
const resolveByReference = async ({ invitationId: publicId, code }) => {
  const hash = publicId ? sha256(text(publicId, 128)) : code ? sha256(text(code, 40).toUpperCase()) : "";
  if (!hash) return null;
  return GuestClinicalSession.findOne(publicId ? { publicInvitationIdHash: hash } : { joinCodeHash: hash });
};

router.use(auth, guard, patientScope);
router.post("/", async (req, res) => {
  try {
    const profileId = text(req.body?.patientProfileId, 40) || null;
    if (profileId && (!objectId(profileId) || !(await PatientProfile.exists({ _id: profileId, primaryOwnerUserId: req.auth.id, status: "active" })))) return res.status(403).json({ success: false, message: "You cannot share this profile." });
    const categories = [...new Set((Array.isArray(req.body?.dataCategories) ? req.body.dataCategories : []).map((x) => text(x, 40)).filter((x) => allowedCategories.has(x)))];
    const documents = await ensureDocsOwned({ patientId: req.auth.id, patientProfileId: profileId, documentIds: req.body?.documentIds });
    const requested = req.body?.permissions || {};
    const permissions = { canView: true, canDownload: requested.canDownload === true, canChat: requested.canChat !== false, canAddNotes: requested.canAddNotes === true, canUpload: requested.canUpload === true };
    const now = new Date(); const requestedMinutes = Number(req.body?.durationMinutes || GUEST_ACTIVE_MINUTES);
    const duration = Math.max(5, Math.min(GUEST_MAX_MINUTES, Number.isFinite(requestedMinutes) ? requestedMinutes : GUEST_ACTIVE_MINUTES));
    const publicId = invitationId(); const code = joinCode();
    const session = await GuestClinicalSession.create({ patientId: req.auth.id, patientProfileId: profileId, status: "waiting_for_guest", publicInvitationIdHash: sha256(publicId), joinCodeHash: sha256(code), invitationExpiresAt: new Date(now.getTime() + GUEST_INVITATION_MINUTES * 60000), absoluteExpiresAt: new Date(now.getTime() + GUEST_MAX_MINUTES * 60000), draftDocumentIds: documents, draftCategories: categories, requestedPermissions: permissions, activeExpiresAt: null, durationMinutes: duration });
    await auditGuestEvent({ session, req, actorType: "patient", actorId: req.auth.id, eventType: "guest_session.created", metadata: { documentCount: documents.length, categoryCount: categories.length } });
    return res.status(201).json({ success: true, session: serialisePatient(session), invitation: { reference: publicId, joinCode: code, expiresAt: session.invitationExpiresAt, guestUrl: `${String(process.env.APP_WEB_URL || process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "")}/guest-session?i=${encodeURIComponent(publicId)}` } });
  } catch (error) { return res.status(400).json({ success: false, message: error.message || "Could not create guest session" }); }
});
router.get("/", async (req, res) => { const rows = await GuestClinicalSession.find({ patientId: req.auth.id }).sort({ createdAt: -1 }).limit(100); res.json({ success: true, sessions: rows.map(serialisePatient) }); });
router.get("/:sessionId", async (req, res) => { if (!objectId(req.params.sessionId)) return res.status(404).json({ success: false }); const session = await GuestClinicalSession.findOne({ _id: req.params.sessionId, patientId: req.auth.id }); if (!session) return res.status(404).json({ success: false }); await safeStatus(session); await session.save(); res.json({ success: true, session: serialisePatient(session) }); });
router.post("/:sessionId/approve", async (req, res) => {
  const session = objectId(req.params.sessionId) && await GuestClinicalSession.findOne({ _id: req.params.sessionId, patientId: req.auth.id });
  if (!session || session.status !== "patient_review_required" || !session.guestParticipant) return res.status(409).json({ success: false, message: "This guest request cannot be approved." });
  const now = new Date(); const expiresAt = new Date(Math.min(now.getTime() + GUEST_ACTIVE_MINUTES * 60000, session.absoluteExpiresAt.getTime()));
  const hashPayload = JSON.stringify({ sessionId: String(session._id), patientId: String(session.patientId), guestParticipantId: String(session.guestParticipant._id), documents: session.draftDocumentIds.map(String).sort(), categories: [...session.draftCategories].sort(), permissions: session.requestedPermissions, expiresAt: expiresAt.toISOString() });
  const consent = await GuestClinicalConsent.create({ sessionId: session._id, patientId: session.patientId, patientProfileId: session.patientProfileId, guestParticipantId: session.guestParticipant._id, verificationLevel: session.guestParticipant.verificationLevel, documentIds: session.draftDocumentIds, dataCategories: session.draftCategories, permissions: session.requestedPermissions, purpose: session.guestParticipant.purpose, consentedAt: now, expiresAt, requestId: text(req.headers["x-request-id"], 120), consentHash: hmac(hashPayload) });
  session.status = "approved"; session.activeExpiresAt = expiresAt; session.consentSnapshotId = consent._id; session.networkEvidence.approvalAt = now; await session.save();
  await auditGuestEvent({ session, req, actorType: "patient", actorId: req.auth.id, eventType: "guest_session.approved", metadata: { consentHash: consent.consentHash } });
  await deliverNotifications({ recipients: [{ userId: req.auth.id, role: "patient" }], title: "Guest session approved", body: "Your approved guest clinical session is active.", type: "guest_session", data: { type: "guest_session_approved", sessionId: String(session._id) } });
  res.json({ success: true, session: serialisePatient(session) });
});
const endPatientSession = (status, eventType) => async (req, res) => { const session = objectId(req.params.sessionId) && await GuestClinicalSession.findOne({ _id: req.params.sessionId, patientId: req.auth.id }); if (!session) return res.status(404).json({ success: false }); if (terminal.has(session.status)) return res.json({ success: true, session: serialisePatient(session) }); session.status = status; session.endedAt = new Date(); session.revokedAt = status === "revoked" ? new Date() : null; session.revokedBy = status === "revoked" ? req.auth.id : null; session.terminationReason = text(req.body?.reason, 240); await session.save(); await auditGuestEvent({ session, req, actorType: "patient", actorId: req.auth.id, eventType }); res.json({ success: true, session: serialisePatient(session) }); };
router.post("/:sessionId/reject", endPatientSession("rejected", "guest_session.rejected")); router.post("/:sessionId/revoke", endPatientSession("revoked", "guest_session.revoked")); router.post("/:sessionId/end", endPatientSession("ended", "guest_session.ended"));
router.get("/:sessionId/audit-receipt", async (req, res) => { const session = objectId(req.params.sessionId) && await GuestClinicalSession.findOne({ _id: req.params.sessionId, patientId: req.auth.id }); if (!session) return res.status(404).json({ success: false }); const consent = session.consentSnapshotId && await GuestClinicalConsent.findById(session.consentSnapshotId).lean(); const events = await (await import("../models/GuestClinicalAuditEvent.js")).GuestClinicalAuditEvent.find({ sessionId: session._id }).select("eventType outcome metadata createdAt eventHash").sort({ createdAt: 1 }).lean(); res.json({ success: true, receipt: { sessionReference: String(session._id).slice(-8), guest: serialisePatient(session).guest, dataCategories: consent?.dataCategories || [], documentsShared: (consent?.documentIds || []).map(String), permissions: consent?.permissions || {}, start: consent?.consentedAt || null, end: session.endedAt || session.activeExpiresAt, terminationReason: session.terminationReason, auditChainChecksum: events.at(-1)?.eventHash || "", events } }); });

publicRouter.use(guard, guestClinicalSessionLimiter);
publicRouter.post("/resolve", async (req, res) => { try { const session = await resolveByReference(req.body || {}); if (!session || terminal.has(session.status) || session.invitationExpiresAt <= new Date()) return res.status(404).json(GENERIC); if (session.joinAttempts >= GUEST_JOIN_MAX_ATTEMPTS) return res.status(429).json(GENERIC); session.joinAttempts += 1; if (["waiting_for_guest", "invitation_created"].includes(session.status)) session.status = "guest_verifying"; await session.save(); setGuestPreAuthCookie(res, { sid: String(session._id), stage: "resolve" }); res.json({ success: true, next: "email_verification" }); } catch { res.status(404).json(GENERIC); } });
publicRouter.post("/request-otp", requirePreAuth, async (req, res) => { const email = text(req.body?.email, 254).toLowerCase(); const session = await GuestClinicalSession.findById(req.guestPreAuth.sid); const now = new Date(); if (!session || !/^\S+@\S+\.\S+$/.test(email) || terminal.has(session.status) || session.invitationExpiresAt <= now) return res.status(400).json(GENERIC); if (session.otp.sentAt && now - session.otp.sentAt < 60000) return res.status(429).json({ success: false, message: "Please wait before requesting another code." }); const code = otpCode(); session.otp = { hash: hmac(`otp:${session._id}:${email}:${code}`), emailHash: hmac(`email:${email}`), expiresAt: new Date(now.getTime() + GUEST_OTP_MINUTES * 60000), attempts: 0, sentAt: now }; await session.save(); try { await sendGuestSessionOtpEmail(email, code); } catch { return res.status(503).json({ success: false, message: "Verification email could not be sent. Please try again." }); } await auditGuestEvent({ session, req, actorType: "guest", eventType: "guest_session.email_otp_requested" }); res.json({ success: true, expiresAt: session.otp.expiresAt }); });
publicRouter.post("/verify-otp", requirePreAuth, async (req, res) => { const email = text(req.body?.email, 254).toLowerCase(); const code = text(req.body?.code, 10); const session = await GuestClinicalSession.findById(req.guestPreAuth.sid); if (!session || !session.otp?.hash || session.otp.expiresAt <= new Date() || session.otp.attempts >= GUEST_OTP_MAX_ATTEMPTS) return res.status(400).json(GENERIC); session.otp.attempts += 1; const valid = crypto.timingSafeEqual(Buffer.from(session.otp.hash), Buffer.from(hmac(`otp:${session._id}:${email}:${code}`))); if (!valid || session.otp.emailHash !== hmac(`email:${email}`)) { await session.save(); return res.status(400).json(GENERIC); } session.otp.hash = ""; await session.save(); setGuestPreAuthCookie(res, { sid: String(session._id), stage: "email_verified", emailHash: hmac(`email:${email}`) }); await auditGuestEvent({ session, req, actorType: "guest", eventType: "guest_session.email_verified" }); res.json({ success: true, next: "identity_declaration" }); });
publicRouter.post("/join-request", requirePreAuth, async (req, res) => { const pre = req.guestPreAuth; if (pre.stage !== "email_verified") return res.status(401).json(GENERIC); const email = text(req.body?.email, 254).toLowerCase(); const name = text(req.body?.claimedName, 120); if (!name || pre.emailHash !== hmac(`email:${email}`) || req.body?.termsAccepted !== true) return res.status(400).json({ success: false, message: "Please complete the required identity and privacy fields." }); const session = await GuestClinicalSession.findById(pre.sid); if (!session || !["guest_verifying", "waiting_for_guest"].includes(session.status)) return res.status(409).json(GENERIC); const registration = text(req.body?.registrationNumber, 160); const device = text(req.body?.deviceSessionId, 120) || crypto.randomUUID(); const evidence = networkEvidence(req); evidence.joinAt = new Date(); session.guestParticipant = { claimedName: name, emailEncrypted: (await import("../utils/fieldEncryption.js")).encryptField(email), emailHash: hmac(`email:${email}`), emailMasked: maskEmail(email), emailVerifiedAt: new Date(), registrationNumberEncrypted: registration ? (await import("../utils/fieldEncryption.js")).encryptField(registration) : "", registrationNumberHash: registration ? hmac(`registration:${registration}`) : "", medicalCouncil: text(req.body?.medicalCouncil, 160), state: text(req.body?.state, 120), organisation: text(req.body?.organisation, 180), purpose: text(req.body?.purpose, 500), verificationLevel: registration ? "email_verified_registration_claimed" : "email_verified_unverified", termsAcceptedAt: new Date(), deviceSessionHash: hmac(`device:${device}`), joinedAt: new Date() }; session.networkEvidence = evidence; session.status = "patient_review_required"; session.joinCodeUsedAt = new Date(); await session.save(); setGuestCookie(res, { sid: String(session._id), gid: String(session.guestParticipant._id), state: "patient_review_required", dv: session.guestParticipant.deviceSessionHash }, 30 * 60 * 1000); await auditGuestEvent({ session, req, actorType: "guest", actorId: String(session.guestParticipant._id), eventType: "guest_session.join_requested" }); await deliverNotifications({ recipients: [{ userId: session.patientId, role: "patient" }], title: "Guest session approval needed", body: "A guest is waiting for your explicit review and approval.", type: "guest_session", data: { type: "guest_session_join_requested", sessionId: String(session._id) } }); res.json({ success: true, status: "waiting_for_patient" }); });
publicRouter.get("/current", requireGuest, async (req, res) => { const session = req.guestSession; if (["approved", "active"].includes(session.status)) { session.status = "active"; await session.save(); setGuestCookie(res, { sid: String(session._id), gid: String(session.guestParticipant._id), state: "active", dv: session.guestParticipant.deviceSessionHash }, Math.max(60000, session.activeExpiresAt - new Date())); } const consent = session.consentSnapshotId && await GuestClinicalConsent.findById(session.consentSnapshotId).lean(); res.set("Cache-Control", "no-store"); res.json({ success: true, state: session.status, expiresAt: session.activeExpiresAt, permissions: ["approved", "active"].includes(session.status) ? consent?.permissions : undefined, documentIds: ["approved", "active"].includes(session.status) ? (consent?.documentIds || []).map(String) : undefined, verification: verificationLabel(session.guestParticipant.verificationLevel) }); });
publicRouter.get("/documents/:documentId/access", requireGuest, async (req, res) => { const session = req.guestSession; if (!objectId(req.params.documentId) || !["approved", "active"].includes(session.status)) return res.status(403).json(GENERIC); const consent = await GuestClinicalConsent.findOne({ _id: session.consentSnapshotId, sessionId: session._id, revokedAt: null, expiresAt: { $gt: new Date() } }).lean(); if (!consent || !consent.documentIds.map(String).includes(String(req.params.documentId))) return res.status(403).json(GENERIC); const doc = await Document.findOne({ _id: req.params.documentId, userId: String(session.patientId), ...(session.patientProfileId ? { patientProfileId: session.patientProfileId } : {}) }).lean(); if (!doc) return res.status(403).json(GENERIC); const download = req.query.download === "true" && consent.permissions?.canDownload === true; const signedUrl = download ? await generateDownloadUrl(doc.s3Key, doc.s3Bucket, 60) : await generateSignedUrl(doc.s3Key, doc.s3Bucket, 60); await auditGuestEvent({ session, req, actorType: "guest", actorId: String(session.guestParticipant._id), eventType: download ? "guest_session.document_downloaded" : "guest_session.document_viewed", resourceType: "document", resourceId: String(doc._id) }); res.set({ "Cache-Control": "private, no-store", Pragma: "no-cache", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" }); res.json({ success: true, signedUrl, disposition: download ? "attachment" : "inline", watermark: `${session.guestParticipant.claimedName} • ${String(session._id).slice(-8)} • Confidential — Guest Session` }); });
publicRouter.post("/logout", (req, res) => { clearGuestCookies(res); res.status(204).end(); });

export { router as guestClinicalSessionRoutes, publicRouter as publicGuestClinicalSessionRoutes };
