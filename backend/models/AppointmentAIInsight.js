import mongoose from "mongoose";

const appointmentAIInsightSchema = new mongoose.Schema(
  {
    appointmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Appointment",
      required: true,
      unique: true,
      index: true,
    },
    summary: { type: String, trim: true, default: "" },
    visitExplanation: { type: String, trim: true, default: "" },
    suggestedFollowUpDays: { type: Number },
    missedRiskScore: { type: Number, min: 0, max: 1 },
    repeatedSymptomsDetected: { type: Boolean, default: false },
    criticalVisitNoFollowUpAlert: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const AppointmentAIInsight = mongoose.model(
  "AppointmentAIInsight",
  appointmentAIInsightSchema,
  "appointment_ai_insights"
);
