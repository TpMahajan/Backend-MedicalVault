import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const AdminUserSchema = new mongoose.Schema(
  {
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
    password: { type: String, required: true, minlength: 6 },
    lastLogin: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
    role: {
      type: String,
      enum: ["ADMIN"],
      default: "ADMIN",
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
    assignedBy: {
      type: String,
      default: () =>
        String(process.env.SUPERADMIN_EMAIL || "superadmin")
          .toLowerCase()
          .trim(),
      lowercase: true,
      trim: true,
    },
    permissions: {
      type: [String],
      default: ["MANAGE_USERS"],
      enum: [
        "MANAGE_USERS",
        "MANAGE_ADS",
        "MANAGE_PRODUCTS",
        "MANAGE_ALERTS",
        "MANAGE_NOTIFICATIONS",
      ],
    },
  },
  {
    timestamps: true,
    collection: "admin_users",
    toJSON: {
      transform: function (doc, ret) {
        delete ret.password;
        return ret;
      },
    },
  }
);

AdminUserSchema.pre("save", function (next) {
  if (this.isModified("status")) {
    this.isActive = this.status !== "BLOCKED";
  } else if (this.isModified("isActive")) {
    this.status = this.isActive === false ? "BLOCKED" : "ACTIVE";
  }
  next();
});

AdminUserSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

AdminUserSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

export const AdminUser = mongoose.model("AdminUser", AdminUserSchema);
