import mongoose from "mongoose";

const uiActionSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 80 },
    icon: { type: String, default: "info", trim: true, maxlength: 40 },
    actionUrl: { type: String, default: "", trim: true },
    isActive: { type: Boolean, default: true },
  },
  { _id: false }
);

const uiCardSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 100 },
    subtitle: { type: String, default: "", trim: true, maxlength: 160 },
    redirectUrl: { type: String, default: "", trim: true },
    isActive: { type: Boolean, default: true },
  },
  { _id: false }
);

const uiAlertSchema = new mongoose.Schema(
  {
    id: { type: String, trim: true, maxlength: 80 },
    title: { type: String, default: "System Alert", trim: true, maxlength: 120 },
    message: { type: String, required: true, trim: true, maxlength: 300 },
    audience: {
      type: String,
      default: "ALL",
      enum: ["ALL", "PATIENT", "DOCTOR"],
      uppercase: true,
      trim: true,
    },
    platform: {
      type: String,
      default: "ALL",
      enum: ["ALL", "APP", "WEB"],
      uppercase: true,
      trim: true,
    },
    priority: {
      type: String,
      default: "HIGH",
      enum: ["LOW", "MEDIUM", "HIGH"],
      uppercase: true,
      trim: true,
    },
    highlight: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const uiConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: "GLOBAL", unique: true },
    buttonColor: { type: String, default: "#0F9D94", trim: true },
    iconColor: { type: String, default: "#14B8A6", trim: true },
    cardStyle: {
      type: String,
      default: "ROUNDED",
      enum: ["ROUNDED", "GLASS", "SOLID", "MINIMAL"],
      uppercase: true,
      trim: true,
    },
    themeMode: {
      type: String,
      default: "SYSTEM",
      enum: ["LIGHT", "DARK", "SYSTEM"],
      uppercase: true,
      trim: true,
    },
    qrActions: { type: [uiActionSchema], default: [] },
    dashboardCards: { type: [uiCardSchema], default: [] },
    dashboardAlerts: { type: [uiAlertSchema], default: [] },
    updatedBy: { type: String, default: "superadmin@medicalvault.in" },
  },
  {
    timestamps: true,
    collection: "ui_config",
  }
);

export const UIConfig = mongoose.model("UIConfig", uiConfigSchema);
