import mongoose from "mongoose";

export const MEDICATION_DOSE_STATUSES = Object.freeze([
  "pending", "due", "taken", "skipped", "snoozed", "missed", "cancelled",
]);

const medicationDoseEventSchema = new mongoose.Schema(
  {
    medicationOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "MedicationOrder", required: true, index: true },
    medicationScheduleId: { type: mongoose.Schema.Types.ObjectId, ref: "MedicationSchedule", required: true, index: true },
    patientProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "PatientProfile", required: true, index: true },
    scheduledAt: { type: Date, required: true, index: true },
    originalLocalDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    originalLocalTime: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    scheduleTimezone: { type: String, required: true, maxlength: 80 },
    status: { type: String, enum: MEDICATION_DOSE_STATUSES, default: "pending", index: true },
    snoozedUntil: { type: Date, default: null },
    confirmedAt: { type: Date, default: null },
    confirmingUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    actionIdempotencyKey: { type: String, default: "", maxlength: 128 },
    notificationSentAt: { type: Date, default: null },
    repeatReminderSentAt: { type: Date, default: null },
    missedNotificationSentAt: { type: Date, default: null },
    audit: [{
      action: { type: String, required: true, maxlength: 40 },
      actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      at: { type: Date, default: Date.now },
      details: { type: mongoose.Schema.Types.Mixed, default: {} },
    }],
  },
  { timestamps: true },
);

// This is the durable duplicate-prevention boundary for generated doses.
medicationDoseEventSchema.index({ medicationScheduleId: 1, scheduledAt: 1 }, { unique: true });
medicationDoseEventSchema.index({ patientProfileId: 1, scheduledAt: 1, status: 1 });
medicationDoseEventSchema.index({ medicationOrderId: 1, scheduledAt: 1 });

export const MedicationDoseEvent = mongoose.model("MedicationDoseEvent", medicationDoseEventSchema);
