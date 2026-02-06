import mongoose from "mongoose";

const doctorAvailabilitySchema = new mongoose.Schema(
  {
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DoctorUser",
      required: true,
      index: true,
    },
    dayOfWeek: {
      type: Number,
      required: true,
      min: 0,
      max: 6,
    },
    startTime: { type: String, required: true, trim: true },
    endTime: { type: String, required: true, trim: true },
    slotDuration: { type: Number, default: 15, min: 5, max: 60 },
    isRecurring: { type: Boolean, default: true },
    validFrom: { type: Date },
    validUntil: { type: Date },
    isBlocked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

doctorAvailabilitySchema.index({ doctorId: 1, dayOfWeek: 1 });

export const DoctorAvailability = mongoose.model(
  "DoctorAvailability",
  doctorAvailabilitySchema,
  "doctor_availabilities"
);
