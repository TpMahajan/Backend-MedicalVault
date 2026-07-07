import mongoose from "mongoose";

const AISettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "GLOBAL", unique: true },
    patientDailyMessageLimit: { type: Number, default: 10, min: 0 },
    doctorDailyMessageLimit: { type: Number, default: 25, min: 0 },
    adminDailyMessageLimit: { type: Number, default: 50, min: 0 },
    maxInputTokensPerRequest: { type: Number, default: 1500, min: 100 },
    maxOutputTokensPerRequest: { type: Number, default: 700, min: 50 },
    maxInputChars: { type: Number, default: 6000, min: 500 },
    maxChatHistoryMessages: { type: Number, default: 6, min: 0 },
    maxDocumentsPerRequest: { type: Number, default: 3, min: 1 },
    allowedModels: {
      type: [String],
      default: ["gpt-4o-mini"],
    },
    defaultModel: { type: String, default: "gpt-4o-mini", trim: true },
    documentVerificationAiEnabled: { type: Boolean, default: true },
    aiAssistantEnabled: { type: Boolean, default: true },
    hardDailyTokenBudget: { type: Number, default: 100000, min: 0 },
    hardDailyCostBudget: { type: Number, default: 10, min: 0 },
    updatedBy: { type: String, trim: true },
  },
  { timestamps: true },
);

export const AISettings = mongoose.model("AISettings", AISettingsSchema);
