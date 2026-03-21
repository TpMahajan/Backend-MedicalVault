import mongoose from "mongoose";

const auditLogSchema = new mongoose.Schema(
  {
    actorId: { type: String, required: true, index: true },
    actorRole: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    action: { type: String, required: true, trim: true, maxlength: 120, index: true },
    resourceType: { type: String, required: true, trim: true, maxlength: 120, index: true },
    resourceId: { type: String, default: "", trim: true, maxlength: 120, index: true },
    patientId: { type: String, default: "", index: true },
    statusCode: { type: Number, required: true, min: 100, max: 599 },
    ipAddress: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    requestId: { type: String, default: "", index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    immutable: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    collection: "audit_logs",
  }
);

auditLogSchema.pre(["updateOne", "updateMany", "findOneAndUpdate", "replaceOne"], function () {
  throw new Error("Audit logs are immutable");
});

export const AuditLog = mongoose.model("AuditLog", auditLogSchema);
