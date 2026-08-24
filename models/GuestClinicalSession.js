import mongoose from "mongoose";

export const GUEST_SESSION_STATES = [
  "draft", "invitation_created", "waiting_for_guest", "guest_verifying",
  "guest_join_requested", "patient_review_required", "approved", "active",
  "extension_requested", "revoked", "rejected", "expired", "ended",
  "security_terminated",
];

export const GUEST_VERIFICATION_LEVELS = [
  "medical_vault_verified",
  "registration_verified",
  "email_verified_registration_claimed",
  "email_verified_unverified",
  "unknown_unverified",
];

const guestParticipantSchema = new mongoose.Schema({
  claimedName: { type: String, trim: true, maxlength: 120 },
  emailEncrypted: { type: String, default: "" },
  emailHash: { type: String, default: "", index: true },
  emailMasked: { type: String, default: "" },
  emailVerifiedAt: { type: Date, default: null },
  registrationNumberEncrypted: { type: String, default: "" },
  registrationNumberHash: { type: String, default: "" },
  medicalCouncil: { type: String, trim: true, maxlength: 160, default: "" },
  state: { type: String, trim: true, maxlength: 120, default: "" },
  organisation: { type: String, trim: true, maxlength: 180, default: "" },
  purpose: { type: String, trim: true, maxlength: 500, default: "" },
  verificationLevel: { type: String, enum: GUEST_VERIFICATION_LEVELS, default: "unknown_unverified" },
  termsVersion: { type: String, trim: true, maxlength: 40, default: "guest-privacy-v1" },
  termsAcceptedAt: { type: Date, default: null },
  deviceSessionHash: { type: String, default: "" },
  joinedAt: { type: Date, default: null },
}, { _id: true });

const networkEvidenceSchema = new mongoose.Schema({
  ipEncrypted: { type: String, default: "" },
  ipHash: { type: String, default: "", index: true },
  ipMasked: { type: String, default: "" },
  ipVersion: { type: Number, enum: [4, 6, null], default: null },
  trustedProxyChain: [{ type: String, maxlength: 128 }],
  userAgentSanitized: { type: String, maxlength: 512, default: "" },
  browserFamily: { type: String, maxlength: 80, default: "Unknown" },
  osFamily: { type: String, maxlength: 80, default: "Unknown" },
  deviceCategory: { type: String, maxlength: 40, default: "Unknown" },
  language: { type: String, maxlength: 80, default: "" },
  timezone: { type: String, maxlength: 80, default: "" },
  firstSeenAt: { type: Date, default: null },
  lastSeenAt: { type: Date, default: null },
  joinAt: { type: Date, default: null },
  approvalAt: { type: Date, default: null },
  sessionEndedAt: { type: Date, default: null },
  requestIds: [{ type: String, maxlength: 128 }],
  riskSignals: [{ type: String, maxlength: 160 }],
}, { _id: false });

const permissionsSchema = new mongoose.Schema({
  canView: { type: Boolean, default: true },
  canDownload: { type: Boolean, default: false },
  canChat: { type: Boolean, default: true },
  canAddNotes: { type: Boolean, default: false },
  canUpload: { type: Boolean, default: false },
}, { _id: false });

const guestClinicalSessionSchema = new mongoose.Schema({
  accessMode: { type: String, enum: ["guest_clinician"], default: "guest_clinician", immutable: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  patientProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "PatientProfile", default: null, index: true },
  status: { type: String, enum: GUEST_SESSION_STATES, default: "draft", index: true },
  publicInvitationIdHash: { type: String, required: true, unique: true, index: true },
  joinCodeHash: { type: String, required: true, unique: true, index: true },
  invitationExpiresAt: { type: Date, required: true, index: true },
  activeExpiresAt: { type: Date, default: null, index: true },
  absoluteExpiresAt: { type: Date, required: true },
  joinCodeUsedAt: { type: Date, default: null },
  joinAttempts: { type: Number, default: 0, min: 0 },
  otp: {
    hash: { type: String, default: "" },
    emailHash: { type: String, default: "" },
    expiresAt: { type: Date, default: null },
    attempts: { type: Number, default: 0, min: 0 },
    sentAt: { type: Date, default: null },
  },
  guestParticipant: { type: guestParticipantSchema, default: null },
  networkEvidence: { type: networkEvidenceSchema, default: () => ({}) },
  draftDocumentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Document" }],
  draftCategories: [{ type: String, enum: ["Report", "Prescription", "Bill", "Insurance", "medicines", "allergies", "conditions", "vitals", "appointments", "emergency"] }],
  requestedPermissions: { type: permissionsSchema, default: () => ({}) },
  consentSnapshotId: { type: mongoose.Schema.Types.ObjectId, ref: "GuestClinicalConsent", default: null },
  riskStatus: { type: String, enum: ["low", "medium", "high", "blocked"], default: "low" },
  extensionCount: { type: Number, default: 0, min: 0 },
  revokedAt: { type: Date, default: null },
  revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  endedAt: { type: Date, default: null },
  terminationReason: { type: String, trim: true, maxlength: 240, default: "" },
}, { timestamps: true, collection: "guest_clinical_sessions" });

guestClinicalSessionSchema.index({ patientId: 1, status: 1, activeExpiresAt: 1 });
guestClinicalSessionSchema.index({ invitationExpiresAt: 1, status: 1 });

export const GuestClinicalSession = mongoose.model("GuestClinicalSession", guestClinicalSessionSchema);
