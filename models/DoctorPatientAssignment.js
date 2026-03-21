import mongoose from "mongoose";

const doctorPatientAssignmentSchema = new mongoose.Schema(
  {
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DoctorUser",
      required: true,
      index: true,
    },
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["active", "revoked"],
      default: "active",
      index: true,
    },
    source: {
      type: String,
      enum: ["session", "appointment", "manual"],
      default: "session",
    },
    assignedBy: {
      role: { type: String, default: "system" },
      principalId: { type: String, default: "" },
      email: { type: String, default: "" },
    },
    assignedAt: {
      type: Date,
      default: Date.now,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: "doctor_patient_assignments",
  }
);

doctorPatientAssignmentSchema.index(
  { doctorId: 1, patientId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "active" } }
);

export const DoctorPatientAssignment = mongoose.model(
  "DoctorPatientAssignment",
  doctorPatientAssignmentSchema
);
