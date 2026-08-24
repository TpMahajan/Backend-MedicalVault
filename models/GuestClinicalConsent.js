import mongoose from "mongoose";

const guestClinicalConsentSchema = new mongoose.Schema({
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: "GuestClinicalSession", required: true, unique: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  patientProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "PatientProfile", default: null },
  guestParticipantId: { type: mongoose.Schema.Types.ObjectId, required: true },
  verificationLevel: { type: String, required: true },
  documentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Document" }],
  dataCategories: [{ type: String }],
  permissions: { type: mongoose.Schema.Types.Mixed, required: true },
  purpose: { type: String, maxlength: 500, default: "" },
  noticeVersion: { type: String, default: "guest-privacy-v1" },
  consentVersion: { type: String, default: "guest-consent-v1" },
  consentedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  requestId: { type: String, default: "" },
  consentHash: { type: String, required: true, index: true },
  revokedAt: { type: Date, default: null },
  revocationReason: { type: String, default: "" },
}, { timestamps: true, collection: "guest_clinical_consents" });

guestClinicalConsentSchema.pre(["updateOne", "updateMany", "findOneAndUpdate", "replaceOne"], function () {
  throw new Error("Guest clinical consents are immutable");
});
guestClinicalConsentSchema.pre(["deleteOne", "deleteMany", "findOneAndDelete", "findByIdAndDelete"], function () {
  throw new Error("Guest clinical consents cannot be deleted");
});

export const GuestClinicalConsent = mongoose.model("GuestClinicalConsent", guestClinicalConsentSchema);
