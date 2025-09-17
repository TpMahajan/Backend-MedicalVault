import mongoose from "mongoose";
import bcrypt from "bcrypt";

const doctorUserSchema = new mongoose.Schema({
  // Required fields for signup
  name: { type: String, required: [true, "Name is required"], trim: true },
  email: {
    type: String,
    required: [true, "Email is required"],
    unique: true,
    lowercase: true,
    trim: true,
    match: [
      /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
      "Please enter a valid email",
    ],
  },
  mobile: {
    type: String,
    required: [true, "Mobile number is required"],
    trim: true,
    match: [/^[\+]?[1-9][\d]{0,15}$/, "Please enter a valid mobile number"],
  },
  password: {
    type: String,
    required: [true, "Password is required"],
    minlength: 6,
  },

  // Profile fields (optional)
  specialty: { type: String, trim: true, default: "" },
  license: { type: String, trim: true, default: "" },
  experience: { type: String, trim: true, default: "" },
  location: { type: String, trim: true, default: "" },
  education: { type: String, trim: true, default: "" },
  bio: { type: String, trim: true, default: "" },
  certifications: [{ type: String, trim: true }],
  languages: [{ type: String, trim: true }],

  // Quick Stats
  totalPatients: { type: Number, default: 0, min: 0 },
  yearsOfExperience: { type: Number, default: 0, min: 0 },

  // Security Settings
  securitySettings: {
    twoFactorAuth: { type: Boolean, default: false },
    sessionTimeout: { type: Number, default: 30, min: 5, max: 480 },
    passwordExpiry: { type: Number, default: 90, min: 30, max: 365 },
    loginNotifications: { type: Boolean, default: true },
  },

  // Password tracking
  passwordChangedAt: { type: Date, default: Date.now },
  lastLoginAt: { type: Date, default: Date.now },
  loginAttempts: { type: Number, default: 0 },
  accountLockedUntil: { type: Date },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Update updatedAt before saving
doctorUserSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

// Hash password before saving
doctorUserSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    this.passwordChangedAt = new Date();
    next();
  } catch (error) {
    next(error);
  }
});

// Compare password
doctorUserSchema.methods.comparePassword = function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Check if password expired
doctorUserSchema.methods.isPasswordExpired = function () {
  const expiryDays = this.securitySettings.passwordExpiry;
  const expiryDate = new Date(this.passwordChangedAt);
  expiryDate.setDate(expiryDate.getDate() + expiryDays);
  return new Date() > expiryDate;
};

// Account lock check
doctorUserSchema.methods.isAccountLocked = function () {
  return this.accountLockedUntil && this.accountLockedUntil > Date.now();
};

// Increment login attempts
doctorUserSchema.methods.incLoginAttempts = function () {
  if (this.accountLockedUntil && this.accountLockedUntil < Date.now()) {
    return this.updateOne({
      $unset: { accountLockedUntil: 1 },
      $set: { loginAttempts: 1 },
    });
  }
  const updates = { $inc: { loginAttempts: 1 } };
  if (this.loginAttempts + 1 >= 5 && !this.isAccountLocked()) {
    updates.$set = { accountLockedUntil: Date.now() + 2 * 60 * 60 * 1000 }; // 2 hours
  }
  return this.updateOne(updates);
};

// Reset login attempts
doctorUserSchema.methods.resetLoginAttempts = function () {
  return this.updateOne({ $unset: { loginAttempts: 1, accountLockedUntil: 1 } });
};

// Update last login
doctorUserSchema.methods.updateLastLogin = function () {
  return this.updateOne({ lastLoginAt: new Date() });
};

// Remove password in JSON
doctorUserSchema.methods.toJSON = function () {
  const userObject = this.toObject();
  delete userObject.password;
  return userObject;
};

export const DoctorUser = mongoose.model(
  "DoctorUser",
  doctorUserSchema,
  "doctor_users"
);
