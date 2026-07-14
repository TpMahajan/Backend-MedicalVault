import mongoose from "mongoose";

const appointmentSchema = new mongoose.Schema({
  // Patient information
  patientId: {
    type: String,
    required: [true, "Patient ID is required"],
    ref: "User",
  },
  patientProfileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "PatientProfile",
    default: null,
    index: true,
  },
  createdByUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
  managedByCaregiverUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
  },
  patientName: {
    type: String,
    required: [true, "Patient name is required"],
    trim: true,
  },
  patientEmail: { type: String, trim: true },
  patientPhone: { type: String, trim: true },

  // Appointment details
  appointmentDate: {
    type: Date,
    required: [true, "Appointment date is required"],
  },
  appointmentTime: {
    type: String,
    required: [true, "Appointment time is required"],
    trim: true,
  },
  duration: { type: Number, default: 30, min: 15, max: 120 },
  reason: {
    type: String,
    required: [true, "Reason for visit is required"],
    trim: true,
  },
  appointmentType: {
    type: String,
    enum: ["consultation", "follow-up", "emergency", "routine", "specialist"],
    default: "consultation",
  },
  mode: { type: String, enum: ["in-person", "online"], default: "in-person" },

  // Doctor reference
  doctorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "DoctorUser",
    required: [true, "Doctor ID is required"],
  },
  doctorName: {
    type: String,
    required: [true, "Doctor name is required"],
    trim: true,
  },
  doctorSpecialization: { type: String, trim: true, default: "" },
  hospitalClinicName: { type: String, trim: true, default: "" },

  // Appointment status
  status: {
    type: String,
    enum: ["pending", "scheduled", "confirmed", "completed", "cancelled", "rescheduled", "no-show"],
    default: "scheduled",
  },

  // Additional notes
  notes: { type: String, trim: true, default: "" },

  // Reminder
  reminderSent: { type: Boolean, default: false },

  // Timestamps
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Auto-update updatedAt
appointmentSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

appointmentSchema.index({ patientProfileId: 1, appointmentDate: 1 });

// ✅ Named export
export const Appointment = mongoose.model("Appointment", appointmentSchema, "appointments");
