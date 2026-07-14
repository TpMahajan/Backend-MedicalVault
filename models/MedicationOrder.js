import mongoose from "mongoose";

const medicationOrderSchema = new mongoose.Schema(
  {
    patientProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PatientProfile",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 160 },
    strength: { type: String, default: "", trim: true, maxlength: 80 },
    dosageForm: { type: String, default: "", trim: true, maxlength: 60 },
    doseQuantity: { type: Number, required: true, min: 0.01, max: 100000 },
    doseUnit: { type: String, required: true, trim: true, maxlength: 40 },
    foodInstruction: {
      type: String,
      enum: ["before_food", "after_food", "with_food", "not_specified"],
      default: "not_specified",
    },
    startDate: { type: Date, required: true, index: true },
    endDate: { type: Date, default: null },
    noEndDate: { type: Boolean, default: true },
    notes: { type: String, default: "", trim: true, maxlength: 2000 },
    prescriptionDocumentId: { type: mongoose.Schema.Types.ObjectId, ref: "Document", default: null },
    status: {
      type: String,
      enum: ["active", "paused", "stopped"],
      default: "active",
      index: true,
    },
    stock: {
      quantity: { type: Number, default: null, min: 0 },
      unit: { type: String, default: "", trim: true, maxlength: 40 },
      lowStockThreshold: { type: Number, default: null, min: 0 },
      refillAt: { type: Date, default: null },
    },
    notificationPolicy: {
      enabled: { type: Boolean, default: true },
      repeatAfterMinutes: { type: Number, default: 30, min: 5, max: 1440 },
      escalationAfterMinutes: { type: Number, default: 120, min: 5, max: 10080 },
    },
    // Durable delivery-claim markers keep the scheduler idempotent across
    // restarts. They are reset when stock/refill settings are deliberately
    // changed, rather than inferred from process memory.
    lowStockNotificationSentAt: { type: Date, default: null },
    refillReminderSentAt: { type: Date, default: null },
    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

medicationOrderSchema.index({ patientProfileId: 1, status: 1, startDate: 1 });

export const MedicationOrder = mongoose.model("MedicationOrder", medicationOrderSchema);
