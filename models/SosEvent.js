import mongoose from "mongoose";

const SosEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      trim: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    profileId: { type: String, trim: true, default: "" },
    userName: { type: String, trim: true, default: "" },
    phone: { type: String, trim: true, default: "" },
    timestamp: { type: Date, default: Date.now },
    source: {
      type: String,
      enum: ["patient_app", "doctor_app", "volunteer", "android", "ios", "web", "other"],
      default: "patient_app",
    },
    location: {
      type: {
        type: String,
        enum: ["Point"],
      },
      coordinates: {
        type: [Number], // [lng, lat]
        default: undefined,
      },
    },
    locationSnapshot: {
      lat: { type: Number },
      lng: { type: Number },
      accuracy: { type: Number },
      mapsUrl: { type: String, trim: true, default: "" },
      unavailable: { type: Boolean, default: false },
    },
    accuracyMeters: { type: Number },
    allergiesSnapshot: {
      type: String,
      default: "",
    },
    severity: {
      type: String,
      enum: ["red", "yellow", "green"],
      default: "red",
    },
    notes: { type: String },
    messagePreview: { type: String, trim: true, default: "" },
    recipients: [
      {
        name: { type: String, trim: true, default: "" },
        phone: { type: String, trim: true, default: "" },
        relation: { type: String, trim: true, default: "" },
        status: { type: String, trim: true, default: "" },
        error: { type: String, trim: true, default: "" },
      },
    ],
    networkMode: {
      type: String,
      enum: ["online", "offline", "unknown"],
      default: "unknown",
    },
    syncStatus: {
      type: String,
      enum: ["pending", "synced", "failed"],
      default: "synced",
    },
    status: {
      type: String,
      enum: ["open", "in_progress", "resolved"],
      default: "open",
    },
  },
  { timestamps: true }
);

// Geospatial + recency indexes to accelerate proximity queries
SosEventSchema.index({ location: "2dsphere" });
SosEventSchema.index({ createdAt: 1 });
SosEventSchema.index({ userId: 1, timestamp: -1 });
SosEventSchema.index({ eventId: 1, userId: 1 }, { unique: true, sparse: true });

export const SosEvent = mongoose.model("SosEvent", SosEventSchema);
