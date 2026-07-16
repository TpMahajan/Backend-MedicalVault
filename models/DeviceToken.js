import mongoose from "mongoose";

const deviceTokenSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true, index: true, select: false },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  role: { type: String, required: true, lowercase: true, trim: true },
  platform: { type: String, enum: ["android", "ios", "web", "unknown"], default: "unknown" },
  deviceId: { type: String, default: null, trim: true },
  enabled: { type: Boolean, default: true, index: true },
  lastSeenAt: { type: Date, default: Date.now },
}, { timestamps: true });

deviceTokenSchema.index({ userId: 1, enabled: 1 });
export const DeviceToken = mongoose.model("DeviceToken", deviceTokenSchema);
