const mongoose = require("mongoose");

const appointmentSchema = new mongoose.Schema({
  // Patient information
  patientId: {
    type: String,
    required: [true, "Patient ID is required"],
    ref: 'Patient'
  },
  patientName: {
    type: String,
    required: [true, "Patient name is required"],
    trim: true,
  },
  patientEmail: {
    type: String,
    trim: true,
  },
  patientPhone: {
    type: String,
    trim: true,
  },
  
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
  
  duration: {
    type: Number,
    default: 30, // minutes
    min: 15,
    max: 120
  },
  
  reason: {
    type: String,
    required: [true, "Reason for visit is required"],
    trim: true,
  },
  
  appointmentType: {
    type: String,
    enum: ["consultation", "follow-up", "emergency", "routine", "specialist"],
    default: "consultation"
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
  
  // Appointment status
  status: {
    type: String,
    enum: ["scheduled", "confirmed", "completed", "cancelled", "rescheduled", "no-show"],
    default: "scheduled",
  },
  
  // Additional notes
  notes: {
    type: String,
    trim: true,
    default: "",
  },
  
  // Reminder settings
  reminderSent: {
    type: Boolean,
    default: false
  },
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Update updatedAt before saving
appointmentSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model("Appointment", appointmentSchema, "appointments");

