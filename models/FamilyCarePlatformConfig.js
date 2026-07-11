import mongoose from "mongoose";

const familyCarePlatformConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: "GLOBAL", unique: true, immutable: true },
    enabled: { type: Boolean, default: false },
    developmentAutoEntitle: { type: Boolean, default: false },
    features: {
      medicationV2: { type: Boolean, default: false },
      caregiverAlerts: { type: Boolean, default: false },
      insights: { type: Boolean, default: false },
      emergencyCardV2: { type: Boolean, default: false },
      vaccination: { type: Boolean, default: false },
      insurance: { type: Boolean, default: false },
    },
    limits: {
      maxManagedProfiles: { type: Number, default: 5, min: 0, max: 50 },
      maxCaregiversPerProfile: { type: Number, default: 5, min: 0, max: 50 },
    },
    invitations: {
      windowMinutes: { type: Number, default: 60, min: 1, max: 1440 },
      maxPerWindow: { type: Number, default: 10, min: 1, max: 1000 },
    },
    updatedBy: { type: String, default: "system", trim: true, maxlength: 254 },
  },
  {
    timestamps: true,
    collection: "family_care_platform_config",
  },
);

export const FamilyCarePlatformConfig = mongoose.model(
  "FamilyCarePlatformConfig",
  familyCarePlatformConfigSchema,
);
