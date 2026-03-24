import mongoose from "mongoose";

const securityAlertSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["MULTIPLE_FAILED_LOGINS", "SUSPICIOUS_ACTIVITY"],
      required: true,
      index: true,
    },
    severity: {
      type: String,
      enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
      default: "MEDIUM",
      index: true,
    },
    actorEmail: { type: String, default: "", trim: true, lowercase: true, index: true },
    actorRole: { type: String, default: "", trim: true, lowercase: true, index: true },
    ipAddress: { type: String, default: "", trim: true, index: true },
    userAgent: { type: String, default: "", trim: true },
    reason: { type: String, required: true, trim: true, maxlength: 500 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    resolved: { type: Boolean, default: false, index: true },
    resolvedBy: { type: String, default: "" },
    resolvedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: "security_alerts",
  }
);

export const SecurityAlert = mongoose.model("SecurityAlert", securityAlertSchema);

