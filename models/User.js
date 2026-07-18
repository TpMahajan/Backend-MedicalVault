import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { decryptField, encryptField } from "../utils/fieldEncryption.js";

// GeoJSON Point sub-schema (avoids the "type" keyword collision when nested).
const GeoPointSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], required: true }, // [lng, lat]
  },
  { _id: false },
);

const UserSchema = new mongoose.Schema(
  {
    // 🔹 Signup/Login fields
    name: { type: String, required: true, trim: true, maxlength: 50 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [
        /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
        "Please enter a valid email",
      ],
    },
    password: { type: String, required: function () { return !this.googleId; }, minlength: 6 },
    mobile: { type: String, required: function () { return !this.googleId; }, trim: true },
    googleId: { type: String, unique: true, sparse: true }, // No default - will be undefined for regular users
    loginType: { type: String, enum: ["email", "google"], default: "email" }, // Track login method
    emailVerified: { type: Boolean, default: false }, // Email verification status
    aadhaar: { type: String, default: null, set: encryptField, get: decryptField },
    role: {
      type: String,
      enum: ["PATIENT", "DOCTOR", "ADMIN", "SUPERADMIN"],
      default: "PATIENT",
      uppercase: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ["ACTIVE", "BLOCKED"],
      default: "ACTIVE",
      uppercase: true,
      trim: true,
    },

    // 🔹 Profile update fields
    dateOfBirth: { type: String, default: null }, // format: YYYY-MM-DD
    age: { type: Number, default: null },
    gender: { type: String, default: null },
    bloodType: { type: String, default: null },
    height: { type: String, default: null },
    weight: { type: String, default: null },
    lastVisit: { type: String, default: null },
    nextAppointment: { type: String, default: null },
    sessionCount: { type: Number, default: 0 },

    emergencyContact: {
      name: { type: String, default: null },
      relationship: { type: String, default: null },
      phone: { type: String, default: null, set: encryptField, get: decryptField },
    },

    allergies: {
      type: String,
      default: "",
      trim: true,
      set: encryptField,
      get: decryptField,
    },
    consents: [
      {
        consentType: {
          type: String,
          enum: ["PRIVACY_POLICY", "TERMS_OF_SERVICE"],
          required: true,
        },
        version: { type: String, required: true, trim: true },
        acceptedAt: { type: Date, default: Date.now, required: true },
        ipAddress: { type: String, default: "" },
        userAgent: { type: String, default: "" },
      },
    ],

    medicalHistory: [
      {
        condition: { type: String },
        diagnosed: { type: String }, // e.g. "2020-01-15"
        status: { type: String }, // Active, Controlled, Inactive
      },
    ],

    medications: [
      {
        name: String,
        dosage: String,
        frequency: String,
        prescribed: String, // e.g. "2024-01-15"
      },
    ],

    medicalRecords: [{ type: mongoose.Schema.Types.ObjectId, ref: "Document" }],

    // 🔹 Location (opt-in, for nearby lost-person alerts). GeoJSON Point [lng, lat].
    // Absent unless the user explicitly shares location; 2dsphere v2 skips absent field.
    lastKnownLocation: { type: GeoPointSchema, default: undefined },
    lastKnownLocationAddress: { type: String, default: null },
    lastKnownLocationUpdatedAt: { type: Date, default: null },
    // User must explicitly opt in before location is used for nearby alerts.
    locationSharingEnabled: { type: Boolean, default: false },
    // Soft opt-out from lost-person alerts even if location sharing is on.
    lostPersonAlertsOptOut: { type: Boolean, default: false },

    // 🔹 System fields
    fcmToken: { type: String, default: null },
    isActive: { type: Boolean, default: true },
    tokenVersion: { type: Number, default: 0, min: 0 },
    lastLogin: { type: Date, default: null },
    currentSessionId: { type: String, default: "", trim: true },
    currentDeviceId: { type: String, default: "", trim: true },
    lastActiveAt: { type: Date, default: null, index: true },
    allowMultipleSessions: { type: Boolean, default: false },
    profilePicture: { type: String, default: null },

    // 🔹 Dashboard display preferences (per-account, synced across devices)
    dashboardPreferences: {
      showTopDoctors: { type: Boolean, default: true },
    },

    // Account-level web and mobile preferences. These are deliberately kept
    // separate from health-data sharing controls so a cosmetic/notification
    // choice can never widen clinical data access.
    preferences: {
      language: { type: String, default: "en", trim: true, maxlength: 16 },
      timezone: { type: String, default: "Asia/Kolkata", trim: true, maxlength: 80 },
      theme: { type: String, default: "light", enum: ["light", "dark"] },
      notifications: {
        appointmentReminders: { type: Boolean, default: true },
        medicationUpdates: { type: Boolean, default: true },
        emergencyAlerts: { type: Boolean, default: true },
        accountAlerts: { type: Boolean, default: true },
      },
      privacy: {
        analytics: { type: Boolean, default: true },
        marketing: { type: Boolean, default: false },
      },
      appearance: {
        compactMode: { type: Boolean, default: false },
        showAvatars: { type: Boolean, default: true },
        animations: { type: Boolean, default: true },
      },
    },
    securitySettings: {
      sessionTimeout: { type: Number, default: 30, min: 5, max: 480 },
      loginNotifications: { type: Boolean, default: true },
    },

    // 🔹 Profile Switching fields
    linkedProfiles: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    // Family Care is additive to legacy linkedProfiles. A User is the login
    // identity; PatientProfile is the health-data subject.
    selfPatientProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PatientProfile",
      default: null,
      index: true,
    },
    entitlements: {
      familyCare: {
        enabled: { type: Boolean, default: false },
        planCode: { type: String, default: "", trim: true, maxlength: 80 },
        status: {
          type: String,
          enum: ["trial", "active", "expired", "suspended"],
          default: "expired",
        },
        trialEndsAt: { type: Date, default: null },
        subscriptionEndsAt: { type: Date, default: null },
        limits: {
          maxManagedProfiles: { type: Number, default: 5, min: 0, max: 50 },
          maxCaregiversPerProfile: { type: Number, default: 5, min: 0, max: 50 },
        },
      },
    },

    // These are enforced on the backend before a different account can request
    // access to this user's healthcare profile. They are intentionally separate
    // from legacy linkedProfiles and default to fail closed.
    familyProfileAccessControls: {
      allowProfileAccessRequests: { type: Boolean, default: false },
      requestPolicy: {
        type: String,
        enum: ["anyone_with_medical_vault_id", "contacts_only", "existing_connections_only", "nobody"],
        default: "nobody",
      },
      requireApprovalForEveryRequest: { type: Boolean, default: true },
      defaultRequestedPermissions: {
        profileRead: { type: Boolean, default: true },
        profileEdit: { type: Boolean, default: false },
        documentsView: { type: Boolean, default: false },
        documentsUpload: { type: Boolean, default: false },
        appointmentsView: { type: Boolean, default: false },
        appointmentsManage: { type: Boolean, default: false },
        medicationsView: { type: Boolean, default: false },
        medicationsManage: { type: Boolean, default: false },
        dosesConfirm: { type: Boolean, default: false },
        emergencyView: { type: Boolean, default: false },
        caregiverNotificationsReceive: { type: Boolean, default: false },
        profileContextSwitch: { type: Boolean, default: true },
        caregiversManage: { type: Boolean, default: false },
      },
    },
    familyCareNotificationPreferences: {
      enabled: { type: Boolean, default: true },
      medicineDue: { type: Boolean, default: true },
      repeatReminder: { type: Boolean, default: true },
      medicineMissed: { type: Boolean, default: true },
      caregiverMissedDoseAlert: { type: Boolean, default: true },
      takenConfirmation: { type: Boolean, default: false },
      skippedConfirmation: { type: Boolean, default: false },
      refillReminder: { type: Boolean, default: true },
      lowStockReminder: { type: Boolean, default: true },
      quietHours: {
        enabled: { type: Boolean, default: false },
        start: { type: String, default: "22:00" },
        end: { type: String, default: "07:00" },
        timezone: { type: String, default: "Asia/Kolkata" },
      },
      profileOverrides: [{
        patientProfileId: { type: mongoose.Schema.Types.ObjectId, ref: "PatientProfile", required: true },
        enabled: { type: Boolean, default: true },
        medicineDue: { type: Boolean, default: true },
        repeatReminder: { type: Boolean, default: true },
        medicineMissed: { type: Boolean, default: true },
        caregiverMissedDoseAlert: { type: Boolean, default: true },
        takenConfirmation: { type: Boolean, default: false },
        skippedConfirmation: { type: Boolean, default: false },
        refillReminder: { type: Boolean, default: true },
        lowStockReminder: { type: Boolean, default: true },
        quietHours: {
          enabled: { type: Boolean, default: false },
          start: { type: String, default: "22:00" },
          end: { type: String, default: "07:00" },
          timezone: { type: String, default: "Asia/Kolkata" },
        },
      }],
    },

    // 🔹 Password reset fields
    resetToken: { type: String, default: null },
    resetTokenHash: { type: String, default: null },
    resetTokenExpiry: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      getters: true,
      transform: function (doc, ret) {
        delete ret.password;
        return ret;
      },
    },
    toObject: { getters: true },
  }
);

// 🔐 Hash password before saving
UserSchema.pre("save", function (next) {
  if (this.isModified("status")) {
    this.isActive = this.status !== "BLOCKED";
  } else if (this.isModified("isActive")) {
    this.status = this.isActive === false ? "BLOCKED" : "ACTIVE";
  }
  next();
});

UserSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  try {
    console.log("User model - hashing password:", { userId: this._id, passwordLength: this.password?.length });
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    console.log("User model - password hashed successfully:", { userId: this._id });
    next();
  } catch (error) {
    console.error("User model - password hashing error:", error);
    next(error);
  }
});

// 🌍 Geospatial index for nearby lost-person alerts (sparse: skips users
// who have not shared a location).
UserSchema.index({ lastKnownLocation: "2dsphere" });

// 🔐 Compare password
UserSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// ✅ Named export (consistent with DoctorUser, File, Appointment)
export const User = mongoose.model("User", UserSchema);
