import mongoose from "mongoose";
import bcrypt from "bcryptjs";

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
    password: { type: String, required: function() { return !this.googleId; }, minlength: 6 },
    mobile: { type: String, required: function() { return !this.googleId; }, trim: true },
    googleId: { type: String, unique: true, sparse: true }, // No default - will be undefined for regular users
    aadhaar: { type: String, default: null },

    // 🔹 Profile update fields
    dateOfBirth: { type: String, default: null }, // format: YYYY-MM-DD
    age: { type: Number, default: null },
    gender: { type: String, default: null },
    bloodType: { type: String, default: null },
    height: { type: String, default: null },
    weight: { type: String, default: null },
    lastVisit: { type: String, default: null },
    nextAppointment: { type: String, default: null },

    emergencyContact: {
      name: { type: String, default: null },
      relationship: { type: String, default: null },
      phone: { type: String, default: null },
    },

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

    // 🔹 System fields
    fcmToken: { type: String, default: null },
    isActive: { type: Boolean, default: true },
    lastLogin: { type: Date, default: null },
    profilePicture: { type: String, default: null },
    
    // 🔹 Profile Switching fields
    linkedProfiles: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    // 🔹 Password reset fields
    resetToken: { type: String, default: null },
    resetTokenExpiry: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform: function (doc, ret) {
        delete ret.password;
        return ret;
      },
    },
  }
);

// 🔐 Hash password before saving
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

// 🔐 Compare password
UserSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// ✅ Named export (consistent with DoctorUser, File, Appointment)
export const User = mongoose.model("User", UserSchema);
