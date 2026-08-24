import mongoose from "mongoose";

const schema = new mongoose.Schema({
  sessionId: { type: mongoose.Schema.Types.ObjectId, ref: "GuestClinicalSession", required: true, index: true },
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  actorType: { type: String, required: true, maxlength: 40 },
  actorId: { type: String, default: "", maxlength: 120 },
  eventType: { type: String, required: true, maxlength: 120, index: true },
  resourceType: { type: String, default: "guest_session", maxlength: 80 },
  resourceId: { type: String, default: "", maxlength: 120 },
  outcome: { type: String, default: "success", maxlength: 40 },
  requestId: { type: String, default: "", maxlength: 120 },
  ipHash: { type: String, default: "" },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  previousEventHash: { type: String, default: "" },
  eventHash: { type: String, required: true, index: true },
}, { timestamps: true, collection: "guest_clinical_audit_events" });
schema.pre(["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete", "findByIdAndDelete"], function () {
  throw new Error("Guest clinical audit events are append-only");
});
export const GuestClinicalAuditEvent = mongoose.model("GuestClinicalAuditEvent", schema);
