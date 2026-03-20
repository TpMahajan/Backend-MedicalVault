import mongoose from "mongoose";

const superAdminActivityLogSchema = new mongoose.Schema(
  {
    actorEmail: { type: String, required: true, lowercase: true, trim: true },
    action: { type: String, required: true, trim: true, maxlength: 120 },
    targetType: { type: String, default: "", trim: true, maxlength: 60 },
    targetId: { type: String, default: "", trim: true, maxlength: 120 },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    ipAddress: { type: String, default: "" },
    userAgent: { type: String, default: "" },
  },
  {
    timestamps: true,
    collection: "superadmin_activity_logs",
  }
);

superAdminActivityLogSchema.index({ createdAt: -1 });

export const SuperAdminActivityLog = mongoose.model(
  "SuperAdminActivityLog",
  superAdminActivityLogSchema
);
