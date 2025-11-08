import mongoose from "mongoose";

const SosEventSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    source: {
      type: String,
      enum: ["patient_app", "doctor_app", "volunteer", "other"],
      default: "patient_app",
    },
    location: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number], // [lng, lat]
        required: true,
      },
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

export const SosEvent = mongoose.model("SosEvent", SosEventSchema);

