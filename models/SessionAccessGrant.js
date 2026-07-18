import mongoose from "mongoose";

// The authoritative permission snapshot for one doctor-patient Session.
// Every document view/download/upload check consults this record, never
// PatientSessionSharingPreference (which only supplies defaults at approval
// time) and never a long-term relationship/assignment record.
//
// Document scope is materialized at approval time: `selectedCategories`
// records which categories the patient chose (for display/audit), but the
// actual authorization boundary is `selectedDocumentIds` — the exact set of
// documents that existed and were selected when the grant was created or
// last updated. A document uploaded to one of those categories AFTER
// approval is NOT automatically included; it only becomes visible if the
// patient explicitly adds it (PATCH .../access-grant) or the doctor uploads
// it themselves under this session (source_session_upload, which appends its
// own id here at upload time). This is intentionally conservative — see
// SESSION_SHARING docs for the full rationale.
const sessionAccessGrantSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Session",
      required: true,
      unique: true,
      index: true,
    },
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DoctorUser",
      required: true,
      index: true,
    },
    selectedDocumentIds: {
      type: [mongoose.Schema.Types.ObjectId],
      default: [],
    },
    selectedCategories: {
      type: [String],
      enum: ["Report", "Prescription", "Bill", "Insurance"],
      default: [],
    },
    structuredDataScopes: {
      type: [String],
      enum: ["profile", "allergies", "conditions", "medications", "appointments", "emergencyInformation"],
      default: [],
    },
    capabilities: {
      canViewDocuments: { type: Boolean, default: true },
      canDownloadDocuments: { type: Boolean, default: false },
      canUploadDocuments: { type: Boolean, default: false },
    },
    status: {
      type: String,
      enum: ["active", "revoked", "expired"],
      default: "active",
      index: true,
    },
    grantedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true, index: true },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    // Optimistic concurrency: a stale client (e.g. a doctor screen that
    // cached an older grant before a revocation) must never be able to
    // resurrect revoked permissions by replaying an old PATCH. Every mutating
    // write increments this and requires the caller's `expectedVersion` (when
    // supplied) to match the currently-stored value.
    version: { type: Number, default: 1 },
  },
  { timestamps: true, collection: "session_access_grants" }
);

sessionAccessGrantSchema.index({ patientId: 1, status: 1 });
sessionAccessGrantSchema.index({ doctorId: 1, status: 1 });

sessionAccessGrantSchema.methods.isCurrentlyActive = function () {
  return this.status === "active" && this.expiresAt > new Date();
};

export const SessionAccessGrant = mongoose.model(
  "SessionAccessGrant",
  sessionAccessGrantSchema
);
