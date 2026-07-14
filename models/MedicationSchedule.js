import mongoose from "mongoose";

export const MEDICATION_SCHEDULE_TYPES = Object.freeze([
  "once_daily",
  "twice_daily",
  "three_times_daily",
  "specific_times",
  "specific_weekdays",
  "every_x_hours",
  "alternate_days",
  "weekly",
  "as_needed",
  "custom",
]);

const medicationScheduleSchema = new mongoose.Schema(
  {
    medicationOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MedicationOrder",
      required: true,
      index: true,
    },
    patientProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PatientProfile",
      required: true,
      index: true,
    },
    scheduleType: { type: String, enum: MEDICATION_SCHEDULE_TYPES, required: true },
    // Local HH:mm values; the related IANA zone is mandatory and is never
    // inferred from the server's locale.
    localTimes: [{ type: String, trim: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ }],
    weekdays: [{ type: Number, min: 0, max: 6 }], // Sunday = 0, matching Intl.
    intervalHours: { type: Number, default: null, min: 1, max: 720 },
    timezone: { type: String, required: true, trim: true, maxlength: 80 },
    fixedToProfileTimezone: { type: Boolean, default: true },
    activeStartDate: { type: Date, required: true },
    activeEndDate: { type: Date, default: null },
    status: { type: String, enum: ["active", "paused", "stopped"], default: "active", index: true },
    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

medicationScheduleSchema.index({ medicationOrderId: 1, status: 1 });
medicationScheduleSchema.index({ patientProfileId: 1, status: 1, activeStartDate: 1 });

export const MedicationSchedule = mongoose.model("MedicationSchedule", medicationScheduleSchema);
