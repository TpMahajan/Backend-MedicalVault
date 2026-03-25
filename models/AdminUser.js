import mongoose from "mongoose";
import bcrypt from "bcryptjs";

export const ADMIN_ROLES = [
  "SUPER_ADMIN",
  "PRODUCT_ADMIN",
  "SOS_ADMIN",
  "SUPPORT_ADMIN",
  "USER_ADMIN",
];

export const ADMIN_PERMISSIONS = [
  "MANAGE_PRODUCTS",
  "MANAGE_ORDERS",
  "VIEW_SOS",
  "HANDLE_SOS",
  "VIEW_TICKETS",
  "REPLY_TICKETS",
  "VIEW_AUDIT_LOGS",
  "VIEW_SECURITY_ALERTS",
];

export const ROLE_PERMISSION_MAP = {
  SUPER_ADMIN: [...ADMIN_PERMISSIONS],
  PRODUCT_ADMIN: ["MANAGE_PRODUCTS", "MANAGE_ORDERS"],
  SOS_ADMIN: ["VIEW_SOS", "HANDLE_SOS"],
  SUPPORT_ADMIN: ["VIEW_TICKETS", "REPLY_TICKETS"],
  USER_ADMIN: ["VIEW_AUDIT_LOGS", "VIEW_SECURITY_ALERTS"],
};

const normalizePermissions = (input) => {
  if (!Array.isArray(input)) return [];
  return [...new Set(
    input
      .map((entry) => String(entry || "").trim().toUpperCase())
      .filter((entry) => ADMIN_PERMISSIONS.includes(entry))
  )];
};

const normalizeRole = (value) => {
  const role = String(value || "").trim().toUpperCase();
  if (role === "ADMIN") return "PRODUCT_ADMIN";
  return ADMIN_ROLES.includes(role) ? role : "PRODUCT_ADMIN";
};

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
      enum: ADMIN_ROLES,
      default: "PRODUCT_ADMIN",
      set: normalizeRole,
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
      default: ROLE_PERMISSION_MAP.PRODUCT_ADMIN,
      enum: ADMIN_PERMISSIONS,
    },
    accessExpiresAt: { type: Date, default: null, index: true },
    temporaryAccessReason: { type: String, default: "", trim: true, maxlength: 240 },
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

AdminUserSchema.pre("validate", function (next) {
  this.role = normalizeRole(this.role);
  const roleDefaults = ROLE_PERMISSION_MAP[this.role] || [];
  const current = normalizePermissions(this.permissions);
  this.permissions =
    this.role === "SUPER_ADMIN"
      ? roleDefaults
      : [...new Set([...roleDefaults, ...current])];
  next();
});

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
