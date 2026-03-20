import mongoose from "mongoose";

const advertisementClickLogSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, trim: true },
    advertisementId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Advertisement",
      required: true,
    },
    placement: { type: String, default: "", trim: true, uppercase: true },
    redirectUrl: { type: String, default: "", trim: true },
    trackedUrl: { type: String, default: "", trim: true },
    platform: {
      type: String,
      default: "unknown",
      enum: ["app", "web", "unknown"],
      lowercase: true,
      trim: true,
    },
    surface: { type: String, default: "", trim: true, uppercase: true },
    sourceApp: { type: String, default: "", trim: true },
    userId: { type: String, default: "", trim: true },
    userType: { type: String, default: "", trim: true },
    sessionId: { type: String, default: "", trim: true },
    ipAddress: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    utmSource: { type: String, default: "", trim: true },
    utmMedium: { type: String, default: "", trim: true },
    utmCampaign: { type: String, default: "", trim: true },
    utmContent: { type: String, default: "", trim: true },
  },
  {
    timestamps: true,
    collection: "advertisement_click_logs",
  }
);

advertisementClickLogSchema.index({ advertisementId: 1, createdAt: -1 });
advertisementClickLogSchema.index({ userId: 1, createdAt: -1 });

export const AdvertisementClickLog = mongoose.model(
  "AdvertisementClickLog",
  advertisementClickLogSchema
);
