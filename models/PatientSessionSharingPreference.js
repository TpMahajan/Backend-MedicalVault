import mongoose from "mongoose";

// Reusable defaults that pre-fill (but do not themselves grant) a patient's
// choices on the per-session approval screen. This is NOT an authorization
// record — a doctor's actual access during a session is always governed by
// SessionAccessGrant, which is materialized from these defaults (or an
// explicit override) at approval time. Never check this model to decide
// whether a request is authorized.
//
// The three-state enum for document categories maps to how the approval
// screen should treat that category by default:
//   "share" -> pre-selected/shared unless the patient unchecks it
//   "ask"   -> shown but unselected, patient must actively choose to share
//   "deny"  -> hidden/excluded from the approval screen by default
const categoryPreferenceEnum = ["share", "ask", "deny"];

const patientSessionSharingPreferenceSchema = new mongoose.Schema(
  {
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    // Keyed to the real document categories in models/File.js — do not add
    // categories that don't exist in the product.
    categoryDefaults: {
      Report: { type: String, enum: categoryPreferenceEnum, default: "ask" },
      Prescription: { type: String, enum: categoryPreferenceEnum, default: "ask" },
      Bill: { type: String, enum: categoryPreferenceEnum, default: "deny" },
      Insurance: { type: String, enum: categoryPreferenceEnum, default: "deny" },
    },
    // Keyed to fields that actually exist and are readable from a
    // doctor-patient session today (models/User.js + models/Appointment.js).
    // Booleans, not the 3-state enum: structured data is shown-or-not on the
    // approval screen, not individually document-listed like categories.
    structuredDataDefaults: {
      profile: { type: Boolean, default: true },
      allergies: { type: Boolean, default: true },
      conditions: { type: Boolean, default: true },
      medications: { type: Boolean, default: true },
      appointments: { type: Boolean, default: false },
      emergencyInformation: { type: Boolean, default: true },
    },
    capabilities: {
      allowDoctorDownload: { type: Boolean, default: false },
      allowDoctorUploadToPatient: { type: Boolean, default: true },
    },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, collection: "patient_session_sharing_preferences" }
);

export const PatientSessionSharingPreference = mongoose.model(
  "PatientSessionSharingPreference",
  patientSessionSharingPreferenceSchema
);
