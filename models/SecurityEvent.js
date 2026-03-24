import mongoose from "mongoose";

const securityEventSchema = new mongoose.Schema(
  {
    eventType: {
      type: String,
      enum: ["CRITICAL_SECURITY_EVENT", "DATA_ACCESS_ANOMALY", "BREACH_FLAG"],
      required: true,
      index: true,
    },
    severity: {
      type: String,
      enum: ["LOW", "MEDIUM", "HIGH"],
      default: "MEDIUM",
      index: true,
    },
    actorId: { type: String, default: "", index: true },
    actorRole: { type: String, default: "", index: true },
    ipAddress: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    reason: { type: String, required: true, maxlength: 600 },
    breachFlag: { type: Boolean, default: false, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, collection: "security_events" }
);

export const SecurityEvent = mongoose.model("SecurityEvent", securityEventSchema);

