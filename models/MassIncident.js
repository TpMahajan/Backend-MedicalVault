import mongoose from "mongoose";

const MassIncidentSchema = new mongoose.Schema(
  {
    center: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number],
        required: true,
      },
    },
    radiusMeters: { type: Number, default: 15 },
    sosCount: { type: Number, default: 0 },
    firstSOSAt: { type: Date, required: true },
    lastSOSAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ["active", "monitoring", "resolved"],
      default: "active",
    },
    label: {
      type: String,
      default: "Possible mass SOS / crowd incident",
      trim: true,
    },
    createdBy: { type: String, default: "system" },
  },
  { timestamps: true }
);

MassIncidentSchema.index({ center: "2dsphere" });
MassIncidentSchema.index({ status: 1, lastSOSAt: 1 });

export const MassIncident = mongoose.model("MassIncident", MassIncidentSchema);

