import mongoose from "mongoose";
import { decryptField, encryptField } from "../utils/fieldEncryption.js";

const patientProfileSchema = new mongoose.Schema(
  {
    identityUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    primaryOwnerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    profileType: {
      type: String,
      enum: ["self", "managed", "linked"],
      required: true,
    },
    displayName: { type: String, required: true, trim: true, maxlength: 120 },
    profilePhotoKey: { type: String, default: null, trim: true },
    dateOfBirth: { type: Date, default: null },
    gender: { type: String, default: null, trim: true, maxlength: 40 },
    bloodGroup: { type: String, default: null, trim: true, maxlength: 12 },
    height: { type: Number, default: null, min: 0, max: 300 },
    weight: { type: Number, default: null, min: 0, max: 1000 },
    timezone: { type: String, default: "Asia/Kolkata", trim: true, maxlength: 80 },
    preferredLanguage: { type: String, default: "en", trim: true, maxlength: 20 },
    medicalSummary: {
      allergies: [{ type: String, trim: true, maxlength: 240 }],
      conditions: [{ type: String, trim: true, maxlength: 240 }],
      currentConcerns: [{ type: String, trim: true, maxlength: 500 }],
      lifestyleNotes: [{ type: String, trim: true, maxlength: 500 }],
    },
    emergencyPreferences: {
      hospitalPreference: { type: String, default: "", trim: true, maxlength: 240 },
      doctorName: { type: String, default: "", trim: true, maxlength: 120 },
      doctorPhone: { type: String, default: "", set: encryptField, get: decryptField },
      organDonorStatus: {
        type: String,
        enum: ["", "yes", "no", "unknown"],
        default: "unknown",
      },
      emergencyNotes: { type: String, default: "", trim: true, maxlength: 1000 },
    },
    emergencyContact: {
      name: { type: String, default: "", trim: true, maxlength: 120 },
      relationship: { type: String, default: "", trim: true, maxlength: 60 },
      // 32 characters is the plaintext limit enforced by the Family Care
      // controller. AES-GCM storage expands that value, so this schema limit
      // must accommodate the encrypted envelope rather than reject it.
      phone: { type: String, default: "", trim: true, maxlength: 256, set: encryptField, get: decryptField },
    },
    identifiers: {
      abhaIdEncrypted: { type: String, default: "", set: encryptField, get: decryptField },
      externalPatientIds: [
        {
          system: { type: String, required: true, trim: true, maxlength: 80 },
          value: { type: String, required: true, trim: true, maxlength: 160 },
        },
      ],
    },
    consent: {
      status: {
        type: String,
        enum: ["not_required", "pending", "granted", "declined", "revoked"],
        default: "pending",
      },
      capturedAt: { type: Date, default: null },
      capturedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      version: { type: String, default: "1.0", trim: true, maxlength: 40 },
    },
    status: {
      type: String,
      enum: ["pending", "active", "archived", "deceased", "creation_failed"],
      default: "active",
      index: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    migrationKey: { type: String, default: null, unique: true, sparse: true },
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
  },
);

patientProfileSchema.index(
  { identityUserId: 1, profileType: 1 },
  {
    unique: true,
    partialFilterExpression: { identityUserId: { $type: "objectId" }, profileType: "self" },
  },
);
patientProfileSchema.index({ primaryOwnerUserId: 1, status: 1 });

export const PatientProfile = mongoose.model("PatientProfile", patientProfileSchema);
