import mongoose from "mongoose";

const appointmentSchema = new mongoose.Schema({
  // Patient information
  patientId: { type: String, required: true, ref: "User" },
  patientName: { type: String, required: true, trim: true },
  patientEmail: { type: String, trim: true },
  patientPhone: { type: String, trim: true },

  // Appointment details
  appointmentDate: { type: Date, required: true },
  appointmentTime: { type: String, required: true, trim: true },
  duration: { type: Number, default: 30, min: 15, max: 120 },
  reason: { type: String, required: true, trim: true },
  appointmentType: {
    type: String,
    enum: ["consultation", "follow-up", "emergency", "routine", "specialist"],
    default: "consultation",
  },

  // Doctor reference
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: "DoctorUser", required: true },
  doctorName: { type: String, required: true, trim: true },

  // Status
  status: {
    type: String,
    enum: ["scheduled", "confirmed", "completed", "cancelled", "rescheduled", "no-show"],
    default: "scheduled",
  },

  notes: { type: String, trim: true, default: "" },
  reminderSent: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

appointmentSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

export const Appointment = mongoose.model("Appointment", appointmentSchema, "appointments");
