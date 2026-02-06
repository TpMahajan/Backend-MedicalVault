import mongoose from "mongoose";

const appointmentSchema = new mongoose.Schema({
  // Patient information
  patientId: {
    type: String,
    required: [true, "Patient ID is required"],
    ref: "User",
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

  // Mode and video
  mode: {
    type: String,
    enum: ["in-person", "online"],
    default: "in-person",
  },
  videoCallUrl: { type: String, trim: true, default: "" },

  // Appointment status
  status: {
    type: String,
    enum: ["pending", "scheduled", "confirmed", "completed", "cancelled", "rescheduled", "no-show", "missed"],
    default: "scheduled",
  },

  // Notes (legacy + new split)
  notes: { type: String, trim: true, default: "" },
  patientNotes: { type: String, trim: true, default: "" },
  doctorNotesPrivate: { type: String, trim: true, default: "" },
  doctorNotesShared: { type: String, trim: true, default: "" },

  // Reminders
  reminderSent: { type: Boolean, default: false },
  reminder24hSent: { type: Boolean, default: false },
  reminder1hSent: { type: Boolean, default: false },

  // Reschedule
  rescheduleRequestedAt: { type: Date },
  rescheduleReason: { type: String, trim: true },
  originalAppointmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Appointment" },

  // Doctor running late
  doctorRunningLateAt: { type: Date },
  doctorRunningLateMinutes: { type: Number },

  // Audit
  createdBy: {
    type: String,
    enum: ["patient", "doctor", "system"],
    default: "doctor",
  },

  // Timestamps
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Indexes for query performance
appointmentSchema.index({ patientId: 1, appointmentDate: 1 });
appointmentSchema.index({ doctorId: 1, appointmentDate: 1 });
appointmentSchema.index({ status: 1 });

// Auto-update updatedAt
appointmentSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

// ✅ Named export
export const Appointment = mongoose.model("Appointment", appointmentSchema, "appointments");
