import mongoose from "mongoose";

const AIUsageSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    role: { type: String, required: true, lowercase: true, trim: true },
    dateKey: { type: String, required: true, index: true },
    endpoint: { type: String, default: "ai.ask", trim: true },
    messageCount: { type: Number, default: 0 },
    tokenInputCount: { type: Number, default: 0 },
    tokenOutputCount: { type: Number, default: 0 },
    estimatedCost: { type: Number, default: 0 },
    resetAt: { type: Date, required: true },
  },
  { timestamps: true },
);

AIUsageSchema.index({ userId: 1, role: 1, dateKey: 1, endpoint: 1 }, { unique: true });
AIUsageSchema.index({ dateKey: 1, endpoint: 1 });

export const AIUsage = mongoose.model("AIUsage", AIUsageSchema);
