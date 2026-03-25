import express from "express";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import multer from "multer";
import multerS3 from "multer-s3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import { requireSuperAdminAuth } from "../middleware/superAdminAuth.js";
import { User } from "../models/User.js";
import { DoctorUser } from "../models/DoctorUser.js";
import {
  AdminUser,
  ADMIN_PERMISSIONS,
  ADMIN_ROLES,
  ROLE_PERMISSION_MAP,
} from "../models/AdminUser.js";
import { SuperAdminCredential } from "../models/SuperAdminCredential.js";
import { Advertisement } from "../models/Advertisement.js";
import { Product } from "../models/Product.js";
import { UIConfig } from "../models/UIConfig.js";
import { Notification } from "../models/Notification.js";
import { Appointment } from "../models/Appointment.js";
import { Session } from "../models/Session.js";
import { Document } from "../models/File.js";
import { SosEvent } from "../models/SosEvent.js";
import { InventoryOrder } from "../models/InventoryOrder.js";
import { SuperAdminActivityLog } from "../models/SuperAdminActivityLog.js";
import { AdvertisementClickLog } from "../models/AdvertisementClickLog.js";
import { clearPublicConfigCache } from "./publicConfig.js";
import { initializeFirebase, sendPushNotification } from "../config/firebase.js";
import s3Client, { BUCKET_NAME } from "../config/s3.js";
import { generateSignedUrl } from "../utils/s3Utils.js";
import {
  parseCookies,
  setAuthCookies,
  clearAuthCookies,
  verifyRefreshToken,
  hashToken,
  issueAuthTokenSet,
} from "../services/tokenService.js";
import { RefreshToken } from "../models/RefreshToken.js";
import { writeAuditLog } from "../middleware/auditLogger.js";
import {
  PUBLIC_AD_SURFACES,
  PUBLIC_ALERT_PLATFORMS,
  broadcastPublicConfigEvent,
} from "../services/publicConfigRealtime.js";

const router = express.Router();
initializeFirebase();

const SUPERADMIN_EMAIL = String(process.env.SUPERADMIN_EMAIL || "")
  .trim()
  .toLowerCase();
const SUPERADMIN_BOOTSTRAP_PASSWORD = String(
  process.env.SUPERADMIN_BOOTSTRAP_PASSWORD || ""
).trim();

const LOGIN_LIMITER = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const PERMISSIONS = [...ADMIN_PERMISSIONS];
const USER_ROLES = ["PATIENT", "DOCTOR", "ADMIN"];
const ALERT_AUDIENCES = ["ALL", "PATIENT", "DOCTOR"];
const ALERT_PLATFORMS = ["ALL", ...PUBLIC_ALERT_PLATFORMS];
const AD_SURFACES = [...PUBLIC_AD_SURFACES];
const hasAWSCredentials =
  !!process.env.AWS_ACCESS_KEY_ID && !!process.env.AWS_SECRET_ACCESS_KEY;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseCsvOrArray(value) {
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((entry) =>
      String(entry || "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    )
    .map((entry) => entry.toUpperCase());
}

function normalizeGeoTargets(input = {}) {
  const targetCountries = [...new Set(parseCsvOrArray(input.targetCountries || input.countries))];
  const targetStates = [...new Set(parseCsvOrArray(input.targetStates || input.states))];
  const targetRegions = [...new Set(parseCsvOrArray(input.targetRegions || input.regions))];
  const hasTargets =
    targetCountries.length > 0 ||
    targetStates.length > 0 ||
    targetRegions.length > 0;

  return {
    geoScope: hasTargets ? "TARGETED" : "GLOBAL",
    targetCountries,
    targetStates,
    targetRegions,
  };
}

function publicServerBaseUrl() {
  const configured = String(
    process.env.PUBLIC_SERVER_BASE_URL || process.env.API_BASE_URL || ""
  ).trim();
  if (!configured) return `http://localhost:${process.env.PORT || 5000}`;
  return configured.replace(/\/api\/?$/i, "");
}

function toAbsoluteUploadsUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("data:image/")) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/uploads/")) return `${publicServerBaseUrl()}${raw}`;
  if (raw.startsWith("uploads/")) return `${publicServerBaseUrl()}/${raw}`;
  return "";
}

function safeImageName(value) {
  const baseName = path.parse(String(value || "image")).name;
  const cleaned = baseName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return cleaned || "image";
}

async function resolveStoredMediaUrl({ imageUrl, imageKey }) {
  const key = String(imageKey || "").trim();
  if (key) {
    const directFromKey = toAbsoluteUploadsUrl(key);
    if (directFromKey) return directFromKey;
    if (hasAWSCredentials) {
      try {
        return await generateSignedUrl(key, BUCKET_NAME);
      } catch {
        // Fall through to url fallback.
      }
    }
  }

  const directUrl = toAbsoluteUploadsUrl(imageUrl);
  if (directUrl) return directUrl;

  const rawUrl = String(imageUrl || "").trim();
  if (rawUrl.startsWith("data:image/")) return rawUrl;
  return /^https?:\/\//i.test(rawUrl) ? rawUrl : "";
}

function normalizeRole(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function normalizePermissions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry || "").trim().toUpperCase())
    .filter((entry) => PERMISSIONS.includes(entry));
}

function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}

function sanitizeRichText(value) {
  const raw = String(value || "");
  return raw
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*(['"]).*?\1/gi, "")
    .replace(/javascript:/gi, "")
    .trim();
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function normalizeTags(value) {
  return [...new Set(
    toArray(value)
      .flatMap((entry) => String(entry || "").split(","))
      .map((entry) => entry.trim())
      .filter(Boolean)
  )];
}

function normalizeCustomFields(value) {
  return toArray(value)
    .map((entry) => ({
      key: String(entry?.key || "").trim(),
      value: entry?.value ?? "",
    }))
    .filter((entry) => entry.key);
}

function normalizeMediaPayload(body = {}) {
  const media = body.media || {};
  const images = toArray(media.images ?? body.images)
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
  const thumbnail = String(media.thumbnail || body.thumbnail || body.imageUrl || "").trim();
  const video = String(media.video || body.video || "").trim();
  return { thumbnail, images, video };
}

function normalizeAlertAudience(value) {
  const audience = String(value || "ALL")
    .trim()
    .toUpperCase();
  return ALERT_AUDIENCES.includes(audience) ? audience : "ALL";
}

function normalizeAlertPlatform(value) {
  const platform = String(value || "ALL")
    .trim()
    .toUpperCase();
  return ALERT_PLATFORMS.includes(platform) ? platform : "ALL";
}

function normalizeAlertPlatforms(value) {
  const raw = Array.isArray(value) ? value : [value];
  const normalized = raw
    .flatMap((entry) =>
      String(entry || "")
        .split(",")
        .map((part) => part.trim().toUpperCase())
        .filter(Boolean)
    )
    .filter((entry) => ALERT_PLATFORMS.includes(entry));

  if (normalized.includes("ALL")) return [...PUBLIC_ALERT_PLATFORMS];
  const unique = [...new Set(normalized.filter((entry) => entry !== "ALL"))];
  return unique.length > 0 ? unique : [...PUBLIC_ALERT_PLATFORMS];
}

function normalizeAdPlacements(value) {
  const raw = Array.isArray(value) ? value : [value];
  const normalized = raw
    .flatMap((entry) =>
      String(entry || "")
        .split(",")
        .map((part) => part.trim().toUpperCase())
        .filter(Boolean)
    )
    .filter((entry) => AD_SURFACES.includes(entry) || entry === "ALL");

  if (normalized.includes("ALL")) return [...AD_SURFACES];
  const unique = [...new Set(normalized.filter((entry) => entry !== "ALL"))];
  return unique;
}

function summarizeAlertPlatform(platforms) {
  const normalized = Array.isArray(platforms) ? platforms : [];
  if (normalized.length >= PUBLIC_ALERT_PLATFORMS.length) return "ALL";
  if (normalized.length === 1) return normalized[0];
  return normalized.join(",");
}

function normalizeDurationMinutes(value, fallback = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(Math.round(parsed), 120));
}

async function fetchAudienceRecipients(audience) {
  const recipients = [];

  if (audience === "ALL" || audience === "PATIENT") {
    const patients = await User.find({
      $or: [
        { status: "ACTIVE" },
        { status: { $exists: false }, isActive: { $ne: false } },
      ],
    })
      .select("_id name fcmToken")
      .lean();

    recipients.push(
      ...patients.map((item) => ({
        id: item._id?.toString(),
        role: "patient",
        name: item.name,
        fcmToken: item.fcmToken || "",
      }))
    );
  }

  if (audience === "ALL" || audience === "DOCTOR") {
    const doctors = await DoctorUser.find({
      $or: [
        { status: "ACTIVE" },
        { status: { $exists: false }, isActive: { $ne: false } },
      ],
    })
      .select("_id name fcmToken")
      .lean();

    recipients.push(
      ...doctors.map((item) => ({
        id: item._id?.toString(),
        role: "doctor",
        name: item.name,
        fcmToken: item.fcmToken || "",
      }))
    );
  }

  return recipients.filter((recipient) => recipient.id);
}

function mapPatient(user) {
  return {
    id: user._id?.toString(),
    name: user.name,
    email: user.email,
    phone: user.mobile || "",
    role: user.role || "PATIENT",
    status: user.status || (user.isActive === false ? "BLOCKED" : "ACTIVE"),
    age: user.age ?? null,
    gender: user.gender ?? null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    type: "PATIENT",
  };
}

function mapDoctor(doctor) {
  return {
    id: doctor._id?.toString(),
    name: doctor.name,
    email: doctor.email,
    phone: doctor.mobile || "",
    role: doctor.role || "DOCTOR",
    status:
      doctor.status || (doctor.isActive === false ? "BLOCKED" : "ACTIVE"),
    specialization: doctor.specialty || "",
    license: doctor.license || "",
    createdAt: doctor.createdAt,
    updatedAt: doctor.updatedAt,
    type: "DOCTOR",
  };
}

function mapAdmin(admin) {
  return {
    id: admin._id?.toString(),
    name: admin.name,
    email: admin.email,
    role: admin.role || "PRODUCT_ADMIN",
    status: admin.status || (admin.isActive === false ? "BLOCKED" : "ACTIVE"),
    permissions: admin.permissions || [],
    accessExpiresAt: admin.accessExpiresAt || null,
    temporaryAccessReason: admin.temporaryAccessReason || "",
    assignedBy: admin.assignedBy || SUPERADMIN_EMAIL || "system",
    createdAt: admin.createdAt,
    updatedAt: admin.updatedAt,
    type: "ADMIN",
  };
}

async function ensureSuperAdminCredential(targetEmail) {
  const normalizedTargetEmail = String(targetEmail || "")
    .trim()
    .toLowerCase();
  if (!normalizedTargetEmail) {
    throw new Error("SuperAdmin email is required");
  }

  let credential = await SuperAdminCredential.findOne({
    email: normalizedTargetEmail,
  });
  if (credential) return credential;

  // Bootstrap is allowed only for configured primary SuperAdmin email.
  if (!SUPERADMIN_EMAIL || normalizedTargetEmail !== SUPERADMIN_EMAIL) {
    return null;
  }

  if (!SUPERADMIN_BOOTSTRAP_PASSWORD) {
    throw new Error(
      "SUPERADMIN_BOOTSTRAP_PASSWORD must be configured before first SuperAdmin login"
    );
  }

  const passwordHash = await bcrypt.hash(SUPERADMIN_BOOTSTRAP_PASSWORD, 12);
  credential = await SuperAdminCredential.create({
    email: SUPERADMIN_EMAIL,
    passwordHash,
    mustChangePassword: false,
  });
  return credential;
}

async function persistRefreshTokenForSuperAdmin(req, principalEmail, refreshToken, refreshMeta) {
  const decoded = verifyRefreshToken(refreshToken);
  const expiresAt = new Date((decoded.exp || 0) * 1000);
  await RefreshToken.create({
    principalId: principalEmail,
    role: "superadmin",
    tokenHash: hashToken(refreshToken),
    familyId: refreshMeta.familyId,
    jti: refreshMeta.jti,
    expiresAt,
    createdByIp: req.ip || "",
    userAgent: req.headers["user-agent"] || "",
  });
}

async function logActivity(req, payload) {
  try {
    await SuperAdminActivityLog.create({
      actorEmail: req.superAdmin?.email || SUPERADMIN_EMAIL || "system",
      action: payload.action,
      targetType: payload.targetType || "",
      targetId: payload.targetId || "",
      details: payload.details || {},
      ipAddress: req.ip || "",
      userAgent: req.headers["user-agent"] || "",
    });
    await writeAuditLog({
      req,
      action: String(payload.action || "SUPERADMIN_ACTION"),
      resourceType: String(payload.targetType || "SUPERADMIN"),
      resourceId: String(payload.targetId || ""),
      statusCode: 200,
      metadata: { details: payload.details || {} },
    });
  } catch (error) {
    console.error("SuperAdmin activity log failed:", error.message);
  }
}

async function findEntityByRole(role, id) {
  if (role === "PATIENT") {
    const user = await User.findById(id);
    return { modelRole: role, entity: user };
  }
  if (role === "DOCTOR") {
    const doctor = await DoctorUser.findById(id);
    return { modelRole: role, entity: doctor };
  }
  if (role === "ADMIN") {
    const admin = await AdminUser.findById(id);
    return { modelRole: role, entity: admin };
  }
  return { modelRole: role, entity: null };
}

function validateDateOrder(startDate, endDate) {
  if (!startDate || !endDate) return false;
  const s = new Date(startDate);
  const e = new Date(endDate);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return false;
  return s <= e;
}

function applyLegacyStatusFilter(query, statusFilter) {
  if (!statusFilter) return query;
  const isActiveEquivalent = statusFilter === "ACTIVE";
  query.$or = [
    { status: statusFilter },
    { status: { $exists: false }, isActive: isActiveEquivalent },
  ];
  return query;
}

const DAY_IN_MS = 24 * 60 * 60 * 1000;
const HOUR_IN_MS = 60 * 60 * 1000;

function startOfUtcDay(value = new Date()) {
  const date = new Date(value);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

function buildDailyBuckets(days = 7, now = new Date()) {
  const normalizedDays = Math.max(1, Math.round(Number(days) || 1));
  const firstDay = new Date(
    startOfUtcDay(now).getTime() - (normalizedDays - 1) * DAY_IN_MS
  );
  return Array.from({ length: normalizedDays }, (_, index) => {
    const start = new Date(firstDay.getTime() + index * DAY_IN_MS);
    return {
      key: start.toISOString().slice(0, 10),
      start,
      end: new Date(start.getTime() + DAY_IN_MS),
    };
  });
}

function buildHourlyBuckets(hours = 24, now = new Date()) {
  const normalizedHours = Math.max(1, Math.round(Number(hours) || 1));
  const roundedNow = new Date(now);
  roundedNow.setUTCMinutes(0, 0, 0);
  const firstHour = new Date(
    roundedNow.getTime() - (normalizedHours - 1) * HOUR_IN_MS
  );
  return Array.from({ length: normalizedHours }, (_, index) => {
    const start = new Date(firstHour.getTime() + index * HOUR_IN_MS);
    return {
      key: `${start.toISOString().slice(0, 13)}:00`,
      start,
      end: new Date(start.getTime() + HOUR_IN_MS),
    };
  });
}

function indexByKey(rows = [], valueField = "count") {
  return rows.reduce((accumulator, entry) => {
    if (entry?._id == null) return accumulator;
    accumulator[String(entry._id)] = Number(entry[valueField] || 0);
    return accumulator;
  }, {});
}

function percent(value, total) {
  const numerator = Number(value || 0);
  const denominator = Number(total || 0);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function buildLegacyStatusQuery(status = "ACTIVE") {
  const normalizedStatus = String(status || "")
    .trim()
    .toUpperCase();
  if (!normalizedStatus) return {};
  const isActiveEquivalent = normalizedStatus === "ACTIVE";
  return {
    $or: [
      { status: normalizedStatus },
      { status: { $exists: false }, isActive: isActiveEquivalent },
    ],
  };
}

function toDateSafe(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

const advertisementImageStorage = hasAWSCredentials
  ? multerS3({
      s3: s3Client,
      bucket: BUCKET_NAME,
      contentType: multerS3.AUTO_CONTENT_TYPE,
      key: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const base = safeImageName(file.originalname);
        cb(null, `superadmin/advertisements/${Date.now()}-${base}${ext}`);
      },
      metadata: (req, file, cb) => {
        cb(null, {
          uploadedBy: req.superAdmin?.email || SUPERADMIN_EMAIL || "system",
          fieldName: file.fieldname,
        });
      },
    })
  : multer.diskStorage({
      destination: (req, file, cb) => {
        const uploadDir = path.join(
          __dirname,
          "../uploads/superadmin/advertisements"
        );
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
      },
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const base = safeImageName(file.originalname);
        cb(null, `${Date.now()}-${base}${ext}`);
      },
    });

const advertisementImageUpload = multer({
  storage: advertisementImageStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype?.startsWith("image/")) {
      cb(null, true);
      return;
    }
    cb(new Error("Only image files are allowed"), false);
  },
});

// ---------------- AUTH ----------------
router.post("/auth/login", LOGIN_LIMITER, async (req, res) => {
  try {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body.password || "").trim();

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const credential = await ensureSuperAdminCredential(email);
    if (!credential) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid SuperAdmin credentials" });
    }

    const passwordMatches = await bcrypt.compare(password, credential.passwordHash);
    if (!passwordMatches) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid SuperAdmin credentials" });
    }

    const principalEmail = String(credential.email || email)
      .trim()
      .toLowerCase();
    const { accessToken, refreshToken, refreshMeta } = issueAuthTokenSet({
      principalId: principalEmail,
      role: "superadmin",
      email: principalEmail,
    });

    await persistRefreshTokenForSuperAdmin(
      req,
      principalEmail,
      refreshToken,
      refreshMeta
    );
    credential.lastLoginAt = new Date();
    await credential.save();

    setAuthCookies(res, { accessToken, refreshToken });
    return res.json({
      success: true,
      token: accessToken,
      refreshToken,
      mustChangePassword: credential.mustChangePassword === true,
      user: {
        email: principalEmail,
        role: "SUPERADMIN",
        mustChangePassword: credential.mustChangePassword === true,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "SuperAdmin login failed",
      error: error.message,
    });
  }
});

router.post("/auth/refresh", async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const providedRefreshToken = String(
      req.body?.refreshToken || cookies.mv_rt || ""
    ).trim();
    if (!providedRefreshToken) {
      return res.status(401).json({ success: false, message: "Refresh token is required" });
    }

    const decoded = verifyRefreshToken(providedRefreshToken);
    if (String(decoded.role || "").toLowerCase() !== "superadmin") {
      return res.status(403).json({ success: false, message: "Invalid refresh token role" });
    }
    const principalEmail = String(decoded.email || decoded.sub || "")
      .trim()
      .toLowerCase();
    if (!principalEmail) {
      return res.status(403).json({ success: false, message: "Invalid refresh token principal" });
    }

    const existing = await RefreshToken.findOne({
      tokenHash: hashToken(providedRefreshToken),
      revokedAt: null,
    });
    if (!existing || existing.expiresAt <= new Date()) {
      return res.status(401).json({ success: false, message: "Refresh token is expired or revoked" });
    }

    const credential = await SuperAdminCredential.findOne({ email: principalEmail });
    if (!credential) {
      return res.status(401).json({ success: false, message: "Invalid refresh token principal" });
    }
    const { accessToken, refreshToken, refreshMeta } = issueAuthTokenSet({
      principalId: principalEmail,
      role: "superadmin",
      email: principalEmail,
      familyId: decoded.familyId,
    });

    existing.revokedAt = new Date();
    existing.revokedReason = "rotated";
    existing.replacedByTokenHash = hashToken(refreshToken);
    await existing.save();

    await persistRefreshTokenForSuperAdmin(
      req,
      principalEmail,
      refreshToken,
      refreshMeta
    );

    setAuthCookies(res, { accessToken, refreshToken });
    return res.json({
      success: true,
      token: accessToken,
      refreshToken,
      mustChangePassword: credential.mustChangePassword === true,
    });
  } catch (error) {
    return res.status(401).json({ success: false, message: "Invalid refresh token" });
  }
});

router.post("/auth/change-password", requireSuperAdminAuth, async (req, res) => {
  try {
    const currentPassword = String(req.body.currentPassword || "").trim();
    const newPassword = String(req.body.newPassword || "").trim();

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password and new password are required",
      });
    }

    if (newPassword.length < 12) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 12 characters long",
      });
    }

    const credential = await SuperAdminCredential.findOne({
      email: req.superAdmin.email,
    });
    if (!credential) {
      return res.status(404).json({
        success: false,
        message: "SuperAdmin credential not found",
      });
    }
    const currentMatches = await bcrypt.compare(currentPassword, credential.passwordHash);
    if (!currentMatches) {
      return res.status(401).json({ success: false, message: "Current password is incorrect" });
    }

    credential.passwordHash = await bcrypt.hash(newPassword, 12);
    credential.mustChangePassword = false;
    credential.passwordChangedAt = new Date();
    await credential.save();

    await logActivity(req, {
      action: "CHANGE_PASSWORD",
      targetType: "SUPERADMIN",
      targetId: credential._id?.toString(),
      details: {},
    });

    return res.json({ success: true, message: "Password changed successfully" });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to change password",
      error: error.message,
    });
  }
});

router.post("/auth/logout", requireSuperAdminAuth, async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const providedRefreshToken = String(
      req.body?.refreshToken || cookies.mv_rt || ""
    ).trim();

    if (providedRefreshToken) {
      await RefreshToken.updateOne(
        { tokenHash: hashToken(providedRefreshToken), revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: "logout" } }
      );
    }

    clearAuthCookies(res);
    return res.json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Logout failed" });
  }
});

router.get("/auth/me", requireSuperAdminAuth, async (req, res) => {
  return res.json({
    success: true,
    user: {
      email: req.superAdmin.email,
      role: "SUPERADMIN",
    },
  });
});

// ---------------- DASHBOARD ----------------
router.get("/dashboard/stats", requireSuperAdminAuth, async (req, res) => {
  try {
    const now = new Date();

    const [patientCount, doctorCount, adminCount, activeAdsCount, productCount, recentActivity] =
      await Promise.all([
        User.countDocuments({ role: { $in: ["PATIENT", null] } }),
        DoctorUser.countDocuments({}),
        AdminUser.countDocuments({}),
        Advertisement.countDocuments({
          isActive: true,
          startDate: { $lte: now },
          endDate: { $gte: now },
        }),
        Product.countDocuments({}),
        SuperAdminActivityLog.find({})
          .sort({ createdAt: -1 })
          .limit(12)
          .lean(),
      ]);

    return res.json({
      success: true,
      stats: {
        totalUsers: patientCount + doctorCount + adminCount,
        doctors: doctorCount,
        patients: patientCount,
        admins: adminCount,
        activeAds: activeAdsCount,
        products: productCount,
      },
      recentActivity,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch dashboard stats",
      error: error.message,
    });
  }
});

router.get("/analytics", requireSuperAdminAuth, async (req, res) => {
  try {
    const now = new Date();
    const last24Hours = new Date(now.getTime() - 24 * HOUR_IN_MS);
    const last7Days = new Date(now.getTime() - 7 * DAY_IN_MS);
    const last30Days = new Date(now.getTime() - 30 * DAY_IN_MS);

    const dailyBuckets = buildDailyBuckets(7, now);
    const hourlyBuckets = buildHourlyBuckets(24, now);
    const daySeriesStart = dailyBuckets[0]?.start || last7Days;
    const hourSeriesStart = hourlyBuckets[0]?.start || last24Hours;

    const patientRoleFilter = { role: { $in: ["PATIENT", null] } };
    const superAdminNotificationMatch = {
      type: "system",
      "data.type": "SUPERADMIN_NOTIFICATION",
      "data.broadcastId": { $exists: true, $ne: "" },
    };

    const [
      patientCount,
      doctorCount,
      adminCount,
      activePatients,
      activeDoctors,
      activeAdmins,
      blockedPatients,
      blockedDoctors,
      blockedAdmins,
      newPatients24h,
      newDoctors24h,
      newAdmins24h,
      newPatients7d,
      newDoctors7d,
      newAdmins7d,
      appointmentsTotal,
      appointmentsUpcoming,
      appointmentsCompleted7d,
      appointmentStatusRows,
      sessionsTotal,
      sessionsActive,
      sessionsAccepted7d,
      sessionStatusRows,
      documentsTotal,
      documentsUploaded7d,
      totalAds,
      activeAds,
      totalProducts,
      activeProducts,
      adClicks24h,
      adClicks7d,
      adClicksByPlatformRows,
      adClicksBySurfaceRows,
      topAdsRows,
      orderSummaryRows,
      globalConfig,
      notifications24h,
      notifications7d,
      notificationsRead7d,
      notificationBroadcasts24hRows,
      notificationBroadcasts7dRows,
      notificationByRoleRows,
      sosOpenCount,
      sos24h,
      sosResolved7d,
      activityActionRows,
      registrationPatientsRows,
      registrationDoctorsRows,
      registrationAdminsRows,
      appointmentsDailyRows,
      sessionsDailyRows,
      notificationsDailyRows,
      adClicksDailyRows,
      sosDailyRows,
      notificationsHourlyRows,
    ] = await Promise.all([
      User.countDocuments(patientRoleFilter),
      DoctorUser.countDocuments({}),
      AdminUser.countDocuments({}),
      User.countDocuments({
        ...patientRoleFilter,
        ...buildLegacyStatusQuery("ACTIVE"),
      }),
      DoctorUser.countDocuments(buildLegacyStatusQuery("ACTIVE")),
      AdminUser.countDocuments(buildLegacyStatusQuery("ACTIVE")),
      User.countDocuments({
        ...patientRoleFilter,
        ...buildLegacyStatusQuery("BLOCKED"),
      }),
      DoctorUser.countDocuments(buildLegacyStatusQuery("BLOCKED")),
      AdminUser.countDocuments(buildLegacyStatusQuery("BLOCKED")),
      User.countDocuments({
        ...patientRoleFilter,
        createdAt: { $gte: last24Hours },
      }),
      DoctorUser.countDocuments({ createdAt: { $gte: last24Hours } }),
      AdminUser.countDocuments({ createdAt: { $gte: last24Hours } }),
      User.countDocuments({
        ...patientRoleFilter,
        createdAt: { $gte: last7Days },
      }),
      DoctorUser.countDocuments({ createdAt: { $gte: last7Days } }),
      AdminUser.countDocuments({ createdAt: { $gte: last7Days } }),
      Appointment.countDocuments({}),
      Appointment.countDocuments({
        appointmentDate: { $gte: now },
        status: { $in: ["scheduled", "confirmed", "rescheduled"] },
      }),
      Appointment.countDocuments({
        status: "completed",
        updatedAt: { $gte: last7Days },
      }),
      Appointment.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Session.countDocuments({}),
      Session.countDocuments({
        status: "accepted",
        isActive: true,
        expiresAt: { $gte: now },
      }),
      Session.countDocuments({
        status: "accepted",
        createdAt: { $gte: last7Days },
      }),
      Session.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Document.countDocuments({}),
      Document.countDocuments({
        $or: [
          { createdAt: { $gte: last7Days } },
          { uploadedAt: { $gte: last7Days } },
        ],
      }),
      Advertisement.countDocuments({}),
      Advertisement.countDocuments({
        isActive: true,
        startDate: { $lte: now },
        endDate: { $gte: now },
      }),
      Product.countDocuments({}),
      Product.countDocuments({ isActive: true }),
      AdvertisementClickLog.countDocuments({ createdAt: { $gte: last24Hours } }),
      AdvertisementClickLog.countDocuments({ createdAt: { $gte: last7Days } }),
      AdvertisementClickLog.aggregate([
        { $match: { createdAt: { $gte: last7Days } } },
        { $group: { _id: "$platform", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      AdvertisementClickLog.aggregate([
        { $match: { createdAt: { $gte: last7Days } } },
        { $group: { _id: "$surface", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      AdvertisementClickLog.aggregate([
        { $match: { createdAt: { $gte: last7Days } } },
        { $group: { _id: "$advertisementId", clicks: { $sum: 1 } } },
        { $sort: { clicks: -1 } },
        { $limit: 5 },
        {
          $lookup: {
            from: "advertisements",
            localField: "_id",
            foreignField: "_id",
            as: "advertisement",
          },
        },
        {
          $unwind: {
            path: "$advertisement",
            preserveNullAndEmptyArrays: true,
          },
        },
      ]),
      InventoryOrder.aggregate([
        {
          $group: {
            _id: null,
            totalOrders: { $sum: 1 },
            completedOrders: {
              $sum: {
                $cond: [{ $eq: ["$orderStatus", "COMPLETED"] }, 1, 0],
              },
            },
            pendingOrders: {
              $sum: {
                $cond: [{ $eq: ["$orderStatus", "PENDING"] }, 1, 0],
              },
            },
            grossSales: {
              $sum: {
                $cond: [{ $gt: ["$total", 0] }, "$total", 0],
              },
            },
          },
        },
      ]),
      UIConfig.findOne({ key: "GLOBAL" })
        .select("dashboardAlerts")
        .lean(),
      Notification.countDocuments({
        ...superAdminNotificationMatch,
        createdAt: { $gte: last24Hours },
      }),
      Notification.countDocuments({
        ...superAdminNotificationMatch,
        createdAt: { $gte: last7Days },
      }),
      Notification.countDocuments({
        ...superAdminNotificationMatch,
        createdAt: { $gte: last7Days },
        read: true,
      }),
      Notification.aggregate([
        {
          $match: {
            ...superAdminNotificationMatch,
            createdAt: { $gte: last24Hours },
          },
        },
        { $group: { _id: "$data.broadcastId" } },
      ]),
      Notification.aggregate([
        {
          $match: {
            ...superAdminNotificationMatch,
            createdAt: { $gte: last7Days },
          },
        },
        { $group: { _id: "$data.broadcastId" } },
      ]),
      Notification.aggregate([
        {
          $match: {
            ...superAdminNotificationMatch,
            createdAt: { $gte: last7Days },
          },
        },
        {
          $group: {
            _id: "$recipientRole",
            total: { $sum: 1 },
            read: {
              $sum: {
                $cond: [{ $eq: ["$read", true] }, 1, 0],
              },
            },
          },
        },
        { $sort: { total: -1 } },
      ]),
      SosEvent.countDocuments({ status: { $in: ["open", "in_progress"] } }),
      SosEvent.countDocuments({ createdAt: { $gte: last24Hours } }),
      SosEvent.countDocuments({
        status: "resolved",
        updatedAt: { $gte: last7Days },
      }),
      SuperAdminActivityLog.aggregate([
        { $match: { createdAt: { $gte: last30Days } } },
        { $group: { _id: "$action", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),
      User.aggregate([
        {
          $match: {
            ...patientRoleFilter,
            createdAt: { $gte: daySeriesStart },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$createdAt",
                timezone: "UTC",
              },
            },
            count: { $sum: 1 },
          },
        },
      ]),
      DoctorUser.aggregate([
        { $match: { createdAt: { $gte: daySeriesStart } } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$createdAt",
                timezone: "UTC",
              },
            },
            count: { $sum: 1 },
          },
        },
      ]),
      AdminUser.aggregate([
        { $match: { createdAt: { $gte: daySeriesStart } } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$createdAt",
                timezone: "UTC",
              },
            },
            count: { $sum: 1 },
          },
        },
      ]),
      Appointment.aggregate([
        { $match: { createdAt: { $gte: daySeriesStart } } },
        {
          $group: {
            _id: {
              day: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$createdAt",
                  timezone: "UTC",
                },
              },
              status: "$status",
            },
            count: { $sum: 1 },
          },
        },
      ]),
      Session.aggregate([
        { $match: { createdAt: { $gte: daySeriesStart } } },
        {
          $group: {
            _id: {
              day: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$createdAt",
                  timezone: "UTC",
                },
              },
              status: "$status",
            },
            count: { $sum: 1 },
          },
        },
      ]),
      Notification.aggregate([
        {
          $match: {
            ...superAdminNotificationMatch,
            createdAt: { $gte: daySeriesStart },
          },
        },
        {
          $group: {
            _id: {
              day: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$createdAt",
                  timezone: "UTC",
                },
              },
              broadcastId: "$data.broadcastId",
            },
            sent: { $sum: 1 },
            read: {
              $sum: {
                $cond: [{ $eq: ["$read", true] }, 1, 0],
              },
            },
          },
        },
        {
          $group: {
            _id: "$_id.day",
            sent: { $sum: "$sent" },
            read: { $sum: "$read" },
            broadcasts: { $sum: 1 },
          },
        },
      ]),
      AdvertisementClickLog.aggregate([
        { $match: { createdAt: { $gte: daySeriesStart } } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$createdAt",
                timezone: "UTC",
              },
            },
            count: { $sum: 1 },
          },
        },
      ]),
      SosEvent.aggregate([
        { $match: { createdAt: { $gte: daySeriesStart } } },
        {
          $group: {
            _id: {
              day: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$createdAt",
                  timezone: "UTC",
                },
              },
              status: "$status",
            },
            count: { $sum: 1 },
          },
        },
      ]),
      Notification.aggregate([
        {
          $match: {
            ...superAdminNotificationMatch,
            createdAt: { $gte: hourSeriesStart },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%dT%H:00",
                date: "$createdAt",
                timezone: "UTC",
              },
            },
            sent: { $sum: 1 },
            read: {
              $sum: {
                $cond: [{ $eq: ["$read", true] }, 1, 0],
              },
            },
          },
        },
      ]),
    ]);

    const alerts = Array.isArray(globalConfig?.dashboardAlerts)
      ? globalConfig.dashboardAlerts
      : [];
    const alertAudienceCounts = {};
    let activeAlertCount = 0;
    let alertsPublished24h = 0;
    let alertsPublished7d = 0;

    for (const alert of alerts) {
      if (!alert || alert.isActive === false) continue;
      const publishedAt =
        toDateSafe(alert.createdAt) || toDateSafe(alert.startAt) || null;
      const expiry = toDateSafe(alert.endAt);
      const isActiveNow = !expiry || expiry >= now;
      if (isActiveNow) activeAlertCount += 1;
      if (publishedAt && publishedAt >= last24Hours) alertsPublished24h += 1;
      if (publishedAt && publishedAt >= last7Days) alertsPublished7d += 1;
      const audience = normalizeAlertAudience(alert.audience || "ALL");
      alertAudienceCounts[audience] = (alertAudienceCounts[audience] || 0) + 1;
    }

    const registrationPatientsMap = indexByKey(registrationPatientsRows);
    const registrationDoctorsMap = indexByKey(registrationDoctorsRows);
    const registrationAdminsMap = indexByKey(registrationAdminsRows);
    const adClicksDailyMap = indexByKey(adClicksDailyRows);

    const appointmentsByDay = appointmentsDailyRows.reduce((accumulator, row) => {
      const day = String(row?._id?.day || "");
      const status = String(row?._id?.status || "unknown");
      if (!day) return accumulator;
      if (!accumulator[day]) accumulator[day] = {};
      accumulator[day][status] = Number(row?.count || 0);
      return accumulator;
    }, {});

    const sessionsByDay = sessionsDailyRows.reduce((accumulator, row) => {
      const day = String(row?._id?.day || "");
      const status = String(row?._id?.status || "unknown");
      if (!day) return accumulator;
      if (!accumulator[day]) accumulator[day] = {};
      accumulator[day][status] = Number(row?.count || 0);
      return accumulator;
    }, {});

    const notificationsByDay = notificationsDailyRows.reduce(
      (accumulator, row) => {
        if (!row?._id) return accumulator;
        accumulator[String(row._id)] = {
          sent: Number(row.sent || 0),
          read: Number(row.read || 0),
          broadcasts: Number(row.broadcasts || 0),
        };
        return accumulator;
      },
      {}
    );

    const sosByDay = sosDailyRows.reduce((accumulator, row) => {
      const day = String(row?._id?.day || "");
      const status = String(row?._id?.status || "unknown");
      if (!day) return accumulator;
      if (!accumulator[day]) accumulator[day] = {};
      accumulator[day][status] = Number(row?.count || 0);
      return accumulator;
    }, {});

    const notificationsByHour = notificationsHourlyRows.reduce(
      (accumulator, row) => {
        if (!row?._id) return accumulator;
        accumulator[String(row._id)] = {
          sent: Number(row.sent || 0),
          read: Number(row.read || 0),
        };
        return accumulator;
      },
      {}
    );

    const registrationsLast7Days = dailyBuckets.map(({ key }) => {
      const patients = Number(registrationPatientsMap[key] || 0);
      const doctors = Number(registrationDoctorsMap[key] || 0);
      const admins = Number(registrationAdminsMap[key] || 0);
      return {
        date: key,
        patients,
        doctors,
        admins,
        total: patients + doctors + admins,
      };
    });

    const appointmentsLast7Days = dailyBuckets.map(({ key }) => {
      const bucket = appointmentsByDay[key] || {};
      const scheduled =
        Number(bucket.scheduled || 0) +
        Number(bucket.confirmed || 0) +
        Number(bucket.rescheduled || 0);
      const completed = Number(bucket.completed || 0);
      const cancelled =
        Number(bucket.cancelled || 0) + Number(bucket["no-show"] || 0);
      const total = Object.values(bucket).reduce(
        (sum, value) => sum + Number(value || 0),
        0
      );
      return {
        date: key,
        scheduled,
        completed,
        cancelled,
        total,
      };
    });

    const sessionsLast7Days = dailyBuckets.map(({ key }) => {
      const bucket = sessionsByDay[key] || {};
      const pending = Number(bucket.pending || 0);
      const accepted = Number(bucket.accepted || 0);
      const declined = Number(bucket.declined || 0);
      const ended = Number(bucket.ended || 0);
      return {
        date: key,
        pending,
        accepted,
        declined,
        ended,
        total: pending + accepted + declined + ended,
      };
    });

    const notificationsLast7Days = dailyBuckets.map(({ key }) => {
      const bucket = notificationsByDay[key] || {
        sent: 0,
        read: 0,
        broadcasts: 0,
      };
      return {
        date: key,
        sent: Number(bucket.sent || 0),
        read: Number(bucket.read || 0),
        broadcasts: Number(bucket.broadcasts || 0),
      };
    });

    const adClicksLast7Days = dailyBuckets.map(({ key }) => ({
      date: key,
      clicks: Number(adClicksDailyMap[key] || 0),
    }));

    const sosLast7Days = dailyBuckets.map(({ key }) => {
      const bucket = sosByDay[key] || {};
      const open =
        Number(bucket.open || 0) + Number(bucket.in_progress || 0);
      const resolved = Number(bucket.resolved || 0);
      const total = Object.values(bucket).reduce(
        (sum, value) => sum + Number(value || 0),
        0
      );
      return {
        date: key,
        open,
        resolved,
        total,
      };
    });

    const notificationsLast24Hours = hourlyBuckets.map(({ key }) => {
      const bucket = notificationsByHour[key] || { sent: 0, read: 0 };
      return {
        hour: key,
        sent: Number(bucket.sent || 0),
        read: Number(bucket.read || 0),
      };
    });

    const totalUsers = patientCount + doctorCount + adminCount;
    const totalActiveUsers = activePatients + activeDoctors + activeAdmins;
    const totalBlockedUsers = blockedPatients + blockedDoctors + blockedAdmins;

    const orderSummary = orderSummaryRows[0] || {};
    const notificationBroadcasts24h = notificationBroadcasts24hRows.length;
    const notificationBroadcasts7d = notificationBroadcasts7dRows.length;

    const appointmentStatus = appointmentStatusRows.map((row) => ({
      status: String(row?._id || "unknown"),
      count: Number(row?.count || 0),
    }));
    const sessionStatus = sessionStatusRows.map((row) => ({
      status: String(row?._id || "unknown"),
      count: Number(row?.count || 0),
    }));
    const adClicksByPlatform = adClicksByPlatformRows.map((row) => ({
      platform: String(row?._id || "unknown").toLowerCase(),
      count: Number(row?.count || 0),
    }));
    const adClicksBySurface = adClicksBySurfaceRows.map((row) => ({
      surface: String(row?._id || "UNKNOWN"),
      count: Number(row?.count || 0),
    }));
    const notificationsByRole = notificationByRoleRows.map((row) => {
      const total = Number(row?.total || 0);
      const read = Number(row?.read || 0);
      const unread = Math.max(0, total - read);
      return {
        role: String(row?._id || "unknown"),
        total,
        read,
        unread,
        readRate: percent(read, total),
      };
    });
    const alertsByAudience = Object.entries(alertAudienceCounts)
      .map(([audience, count]) => ({
        audience,
        count: Number(count || 0),
      }))
      .sort((left, right) => right.count - left.count);

    const topAds = topAdsRows.map((row) => ({
      advertisementId: row?._id ? String(row._id) : "",
      title: String(row?.advertisement?.title || "Untitled Ad"),
      placement: String(row?.advertisement?.placement || "UNKNOWN"),
      clicks: Number(row?.clicks || 0),
    }));

    const actionMix = activityActionRows.map((row) => ({
      action: String(row?._id || "UNKNOWN"),
      count: Number(row?.count || 0),
    }));

    return res.json({
      success: true,
      generatedAt: now.toISOString(),
      refreshIntervalSeconds: 15,
      kpis: {
        users: {
          total: totalUsers,
          patients: patientCount,
          doctors: doctorCount,
          admins: adminCount,
          active: totalActiveUsers,
          blocked: totalBlockedUsers,
          newLast24h: newPatients24h + newDoctors24h + newAdmins24h,
          newLast7d: newPatients7d + newDoctors7d + newAdmins7d,
        },
        clinical: {
          appointmentsTotal,
          appointmentsUpcoming,
          appointmentsCompletedLast7d: appointmentsCompleted7d,
          sessionsTotal,
          sessionsActive,
          sessionsAcceptedLast7d: sessionsAccepted7d,
          documentsTotal,
          documentsUploadedLast7d: documentsUploaded7d,
        },
        communications: {
          activeAlerts: activeAlertCount,
          alertsPublishedLast24h: alertsPublished24h,
          alertsPublishedLast7d: alertsPublished7d,
          notificationsSentLast24h: notifications24h,
          notificationsSentLast7d: notifications7d,
          notificationBroadcastsLast24h: notificationBroadcasts24h,
          notificationBroadcastsLast7d: notificationBroadcasts7d,
          notificationReadRateLast7d: percent(notificationsRead7d, notifications7d),
        },
        commerce: {
          adsTotal: totalAds,
          adsActive: activeAds,
          adClicksLast24h: adClicks24h,
          adClicksLast7d: adClicks7d,
          productsTotal: totalProducts,
          productsActive: activeProducts,
          ordersTotal: Number(orderSummary.totalOrders || 0),
          ordersCompleted: Number(orderSummary.completedOrders || 0),
          ordersPending: Number(orderSummary.pendingOrders || 0),
          grossSales: Number(orderSummary.grossSales || 0),
        },
        safety: {
          sosOpen: sosOpenCount,
          sosRaisedLast24h: sos24h,
          sosResolvedLast7d: sosResolved7d,
        },
      },
      trends: {
        registrationsLast7Days,
        appointmentsLast7Days,
        sessionsLast7Days,
        notificationsLast7Days,
        notificationsLast24Hours,
        adClicksLast7Days,
        sosLast7Days,
      },
      breakdowns: {
        appointmentStatus,
        sessionStatus,
        notificationsByRole,
        adClicksByPlatform,
        adClicksBySurface,
        alertsByAudience,
      },
      top: {
        advertisements: topAds,
        activityActions: actionMix,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch analytics",
      error: error.message,
    });
  }
});

router.get("/activities", requireSuperAdminAuth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 30), 200);
    const activities = await SuperAdminActivityLog.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return res.json({ success: true, activities });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch activities",
      error: error.message,
    });
  }
});

// ---------------- ALERTS ----------------
router.get("/alerts", requireSuperAdminAuth, async (req, res) => {
  try {
    const includeExpired = toBoolean(req.query.includeExpired, false);
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
    const now = new Date();

    const config = await UIConfig.findOne({ key: "GLOBAL" }).lean();
    const alerts = Array.isArray(config?.dashboardAlerts)
      ? config.dashboardAlerts
      : [];

    const filtered = alerts
      .filter((alert) => {
        const isActive = alert?.isActive !== false;
        if (!isActive) return false;
        if (includeExpired) return true;
        const endAt = new Date(alert?.endAt || 0);
        return Number.isNaN(endAt.getTime()) || endAt >= now;
      })
      .sort((left, right) => {
        const a = new Date(left?.createdAt || left?.startAt || 0).getTime();
        const b = new Date(right?.createdAt || right?.startAt || 0).getTime();
        return b - a;
      })
      .slice(0, limit);

    const normalizedAlerts = filtered.map((alert) => {
      const platforms = normalizeAlertPlatforms(
        alert?.platforms ?? alert?.platform
      );
      return {
        ...alert,
        platforms,
        platform: summarizeAlertPlatform(platforms),
      };
    });

    return res.json({
      success: true,
      count: normalizedAlerts.length,
      alerts: normalizedAlerts,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch alerts",
      error: error.message,
    });
  }
});

router.post("/alerts/broadcast", requireSuperAdminAuth, async (req, res) => {
  try {
    const title = String(req.body.title || "System Alert").trim();
    const message = String(req.body.message || req.body.body || "").trim();
    const audience = normalizeAlertAudience(req.body.audience);
    const platforms = normalizeAlertPlatforms(
      req.body.platforms ?? req.body.platform
    );
    const platform = summarizeAlertPlatform(platforms);
    const durationMinutes = normalizeDurationMinutes(req.body.durationMinutes);
    const highlight = toBoolean(req.body.highlight, true);
    const priority = String(req.body.priority || "HIGH")
      .trim()
      .toUpperCase();
    const normalizedPriority = ["LOW", "MEDIUM", "HIGH"].includes(priority)
      ? priority
      : "HIGH";

    if (!message) {
      return res.status(400).json({
        success: false,
        message: "message is required",
      });
    }

    const now = new Date();
    const endAt = new Date(now.getTime() + durationMinutes * 60 * 1000);
    const alertId = `alert_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    const newAlert = {
      id: alertId,
      title: title || "System Alert",
      message,
      audience,
      platform,
      platforms,
      priority: normalizedPriority,
      highlight,
      isActive: true,
      startAt: now,
      endAt,
      createdAt: now,
    };

    const existingConfig = await UIConfig.findOne({ key: "GLOBAL" });
    const config =
      existingConfig ||
      (await UIConfig.create({ key: "GLOBAL", dashboardAlerts: [] }));
    const currentAlerts = Array.isArray(config.dashboardAlerts)
      ? config.dashboardAlerts
      : [];

    const retainedAlerts = currentAlerts.filter((alert) => {
      if (!alert || alert.isActive === false) return false;
      const expiry = new Date(alert.endAt || 0);
      if (Number.isNaN(expiry.getTime())) return true;
      // Keep recent history for panel visibility while preventing unbounded growth.
      return expiry.getTime() >= now.getTime() - 7 * 24 * 60 * 60 * 1000;
    });

    config.dashboardAlerts = [newAlert, ...retainedAlerts].slice(0, 80);
    config.updatedBy = req.superAdmin.email;
    await config.save();
    clearPublicConfigCache();
    broadcastPublicConfigEvent({
      type: "alerts.updated",
      platforms,
      surfaces: [],
      reason: "SUPERADMIN_ALERT_BROADCAST",
    });

    await logActivity(req, {
      action: "BROADCAST_ALERT",
      targetType: "ALERT",
      targetId: alertId,
      details: {
        title: newAlert.title,
        audience,
        platform,
        platforms,
        durationMinutes,
        highlight,
        priority: normalizedPriority,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Alert published successfully",
      alert: newAlert,
      stats: {
        durationMinutes,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to publish alert",
      error: error.message,
    });
  }
});

// ---------------- NOTIFICATIONS ----------------
router.get("/notifications", requireSuperAdminAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);

    const notifications = await Notification.aggregate([
      {
        $match: {
          type: "system",
          "data.type": "SUPERADMIN_NOTIFICATION",
          "data.broadcastId": { $exists: true, $ne: "" },
        },
      },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$data.broadcastId",
          title: { $first: "$title" },
          message: { $first: "$body" },
          audience: { $first: "$data.audience" },
          platform: { $first: "$data.platform" },
          priority: { $first: "$data.priority" },
          deepLink: { $first: "$data.deepLink" },
          createdAt: { $first: "$createdAt" },
          senderId: { $first: "$senderId" },
          recipients: { $sum: 1 },
          readCount: {
            $sum: {
              $cond: [{ $eq: ["$read", true] }, 1, 0],
            },
          },
        },
      },
      { $sort: { createdAt: -1 } },
      { $limit: limit },
    ]);

    return res.json({
      success: true,
      count: notifications.length,
      notifications: notifications.map((entry) => ({
        id: entry._id,
        title: entry.title,
        message: entry.message,
        audience: entry.audience || "ALL",
        platform: entry.platform || "ALL",
        priority: entry.priority || "HIGH",
        deepLink: entry.deepLink || "",
        senderId: entry.senderId || SUPERADMIN_EMAIL,
        createdAt: entry.createdAt,
        stats: {
          recipients: entry.recipients || 0,
          readCount: entry.readCount || 0,
          unreadCount: Math.max(
            0,
            Number(entry.recipients || 0) - Number(entry.readCount || 0)
          ),
        },
      })),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch notification broadcasts",
      error: error.message,
    });
  }
});

router.post(
  "/notifications/broadcast",
  requireSuperAdminAuth,
  async (req, res) => {
    try {
      const title = String(req.body.title || "System Notification").trim();
      const message = String(req.body.message || req.body.body || "").trim();
      const audience = normalizeAlertAudience(req.body.audience);
      const platform = normalizeAlertPlatform(req.body.platform);
      const priority = String(req.body.priority || "HIGH")
        .trim()
        .toUpperCase();
      const normalizedPriority = ["LOW", "MEDIUM", "HIGH"].includes(priority)
        ? priority
        : "HIGH";
      const deepLink = String(req.body.deepLink || "").trim();

      if (!message) {
        return res.status(400).json({
          success: false,
          message: "message is required",
        });
      }

      const now = new Date();
      const broadcastId = `notification_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const recipientDocs = await fetchAudienceRecipients(audience);

      const notificationsPayload = recipientDocs.map((recipient) => ({
        title: title || "System Notification",
        body: message,
        type: "system",
        data: {
          type: "SUPERADMIN_NOTIFICATION",
          broadcastId,
          audience,
          platform,
          priority: normalizedPriority,
          deepLink,
          createdAt: now.toISOString(),
        },
        recipientId: recipient.id,
        recipientRole: recipient.role,
        senderId: req.superAdmin.email,
        senderRole: "admin",
      }));

      const createdNotifications = notificationsPayload.length
        ? await Notification.insertMany(notificationsPayload)
        : [];

      if (createdNotifications.length > 0) {
        const { broadcastNotification } = await import(
          "../controllers/notificationController.js"
        );
        await Promise.all(
          createdNotifications.map((notification) =>
            broadcastNotification(notification)
          )
        );
      }

      const pushRecipients = recipientDocs.filter(
        (recipient) => recipient.fcmToken && recipient.fcmToken.trim() !== ""
      );
      let pushSuccess = 0;
      let pushFailed = 0;
      await Promise.all(
        pushRecipients.map(async (recipient) => {
          try {
            const result = await sendPushNotification(
              recipient.fcmToken,
              {
                title: title || "System Notification",
                body: message,
              },
              {
                type: "SUPERADMIN_NOTIFICATION",
                broadcastId,
                audience,
                platform,
                priority: normalizedPriority,
                deepLink,
              }
            );
            if (result?.success) {
              pushSuccess += 1;
            } else {
              pushFailed += 1;
            }
          } catch {
            pushFailed += 1;
          }
        })
      );

      await logActivity(req, {
        action: "BROADCAST_NOTIFICATION",
        targetType: "NOTIFICATION",
        targetId: broadcastId,
        details: {
          title: title || "System Notification",
          audience,
          platform,
          priority: normalizedPriority,
          recipients: recipientDocs.length,
        },
      });

      return res.status(201).json({
        success: true,
        message: "Notification sent successfully",
        notification: {
          id: broadcastId,
          title: title || "System Notification",
          message,
          audience,
          platform,
          priority: normalizedPriority,
          deepLink,
          createdAt: now,
        },
        stats: {
          recipients: recipientDocs.length,
          notificationsCreated: createdNotifications.length,
          pushEligible: pushRecipients.length,
          pushSuccess,
          pushFailed,
        },
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to send notification",
        error: error.message,
      });
    }
  }
);

// ---------------- USER MANAGEMENT ----------------
router.get("/users", requireSuperAdminAuth, async (req, res) => {
  try {
    const role = normalizeRole(req.query.role || "ALL");
    const status = normalizeStatus(req.query.status || "");

    if (role !== "ALL" && !USER_ROLES.includes(role)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid role filter" });
    }

    const roleFilter = role === "ALL" ? USER_ROLES : [role];
    const statusFilter = status && ["ACTIVE", "BLOCKED"].includes(status) ? status : null;

    const payload = [];

    if (roleFilter.includes("PATIENT")) {
      const query = applyLegacyStatusFilter({}, statusFilter);
      const patients = await User.find(query).sort({ createdAt: -1 }).lean();
      payload.push(...patients.map(mapPatient));
    }
    if (roleFilter.includes("DOCTOR")) {
      const query = applyLegacyStatusFilter({}, statusFilter);
      const doctors = await DoctorUser.find(query).sort({ createdAt: -1 }).lean();
      payload.push(...doctors.map(mapDoctor));
    }
    if (roleFilter.includes("ADMIN")) {
      const query = applyLegacyStatusFilter({}, statusFilter);
      const admins = await AdminUser.find(query).sort({ createdAt: -1 }).lean();
      payload.push(...admins.map(mapAdmin));
    }

    payload.sort((left, right) => {
      const a = new Date(left.createdAt || 0).getTime();
      const b = new Date(right.createdAt || 0).getTime();
      return b - a;
    });

    return res.json({ success: true, users: payload });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch users",
      error: error.message,
    });
  }
});

router.post("/users", requireSuperAdminAuth, async (req, res) => {
  try {
    const role = normalizeRole(req.body.role);
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    const phone = String(req.body.phone || req.body.mobile || "").trim();
    const password = String(req.body.password || "").trim();

    if (!USER_ROLES.includes(role)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid role for user creation" });
    }
    if (!name || !email) {
      return res
        .status(400)
        .json({ success: false, message: "Name and email are required" });
    }
    if (!password || password.length < 12) {
      return res.status(400).json({
        success: false,
        message: "A strong password (minimum 12 characters) is required",
      });
    }

    if (role === "PATIENT") {
      if (!phone) {
        return res.status(400).json({
          success: false,
          message: "Phone is required for patient",
        });
      }

      const patient = new User({
        name,
        email,
        password,
        mobile: phone,
        role: "PATIENT",
        status: "ACTIVE",
        age: req.body.age ?? null,
        gender: req.body.gender ?? null,
      });
      await patient.save();

      await logActivity(req, {
        action: "CREATE_USER",
        targetType: "PATIENT",
        targetId: patient._id?.toString(),
        details: { email: patient.email },
      });

      return res.status(201).json({ success: true, user: mapPatient(patient) });
    }

    if (role === "DOCTOR") {
      if (!phone) {
        return res.status(400).json({
          success: false,
          message: "Phone is required for doctor",
        });
      }

      const doctor = new DoctorUser({
        name,
        email,
        password,
        mobile: phone,
        specialty: String(req.body.specialization || req.body.specialty || "").trim(),
        license: String(req.body.license || "").trim(),
        role: "DOCTOR",
        status: "ACTIVE",
      });
      await doctor.save();

      await logActivity(req, {
        action: "CREATE_USER",
        targetType: "DOCTOR",
        targetId: doctor._id?.toString(),
        details: { email: doctor.email },
      });

      return res.status(201).json({ success: true, user: mapDoctor(doctor) });
    }

    const requestedAdminRole = normalizeRole(req.body.adminRole || req.body.admin_role || req.body.role);
    const adminRole = ADMIN_ROLES.includes(requestedAdminRole)
      ? requestedAdminRole
      : "PRODUCT_ADMIN";
    const adminPermissions = normalizePermissions(req.body.permissions);
    const admin = new AdminUser({
      name,
      email,
      password,
      assignedBy: req.superAdmin.email,
      role: adminRole,
      permissions:
        adminPermissions.length > 0
          ? adminPermissions
          : ROLE_PERMISSION_MAP[adminRole] || ROLE_PERMISSION_MAP.PRODUCT_ADMIN,
      status: "ACTIVE",
    });
    await admin.save();

    await logActivity(req, {
      action: "CREATE_USER",
      targetType: "ADMIN",
      targetId: admin._id?.toString(),
      details: { email: admin.email, permissions: admin.permissions },
    });

    return res.status(201).json({ success: true, user: mapAdmin(admin) });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to create user",
      error: error.message,
    });
  }
});

router.put("/users/:role/:id", requireSuperAdminAuth, async (req, res) => {
  try {
    const role = normalizeRole(req.params.role);
    const { entity } = await findEntityByRole(role, req.params.id);
    if (!entity) {
      return res
        .status(404)
        .json({ success: false, message: `${role} not found` });
    }

    if (req.body.name != null) entity.name = String(req.body.name).trim();
    if (req.body.email != null) entity.email = String(req.body.email).trim().toLowerCase();
    if (req.body.phone != null || req.body.mobile != null) {
      const phone = String(req.body.phone || req.body.mobile || "").trim();
      if (role === "PATIENT" || role === "DOCTOR") entity.mobile = phone;
    }
    if (req.body.password != null && String(req.body.password).trim().length >= 6) {
      entity.password = String(req.body.password).trim();
    }

    if (role === "PATIENT") {
      if (req.body.age != null) entity.age = req.body.age;
      if (req.body.gender != null) entity.gender = req.body.gender;
    }

    if (role === "DOCTOR") {
      if (req.body.specialization != null) {
        entity.specialty = String(req.body.specialization).trim();
      }
      if (req.body.license != null) entity.license = String(req.body.license).trim();
    }

    if (role === "ADMIN") {
      if (req.body.adminRole != null || req.body.role != null) {
        const nextRole = normalizeRole(req.body.adminRole || req.body.role);
        if (ADMIN_ROLES.includes(nextRole)) {
          entity.role = nextRole;
        }
      }
      if (Array.isArray(req.body.permissions)) {
        const permissions = normalizePermissions(req.body.permissions);
        entity.permissions = permissions.length > 0 ? permissions : entity.permissions;
      }
    }

    if (req.body.status != null) {
      const status = normalizeStatus(req.body.status);
      if (["ACTIVE", "BLOCKED"].includes(status)) {
        entity.status = status;
      }
    }

    await entity.save();

    await logActivity(req, {
      action: "UPDATE_USER",
      targetType: role,
      targetId: entity._id?.toString(),
      details: { fields: Object.keys(req.body || {}) },
    });

    const mapped =
      role === "PATIENT" ? mapPatient(entity) : role === "DOCTOR" ? mapDoctor(entity) : mapAdmin(entity);
    return res.json({ success: true, user: mapped });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update user",
      error: error.message,
    });
  }
});

router.patch("/users/:role/:id/status", requireSuperAdminAuth, async (req, res) => {
  try {
    const role = normalizeRole(req.params.role);
    const status = normalizeStatus(req.body.status);
    if (!["ACTIVE", "BLOCKED"].includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: "Status must be ACTIVE or BLOCKED" });
    }

    const { entity } = await findEntityByRole(role, req.params.id);
    if (!entity) {
      return res
        .status(404)
        .json({ success: false, message: `${role} not found` });
    }

    entity.status = status;
    await entity.save();

    await logActivity(req, {
      action: "CHANGE_USER_STATUS",
      targetType: role,
      targetId: entity._id?.toString(),
      details: { status },
    });

    const mapped =
      role === "PATIENT" ? mapPatient(entity) : role === "DOCTOR" ? mapDoctor(entity) : mapAdmin(entity);
    return res.json({ success: true, user: mapped });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update user status",
      error: error.message,
    });
  }
});

router.delete("/users/:role/:id", requireSuperAdminAuth, async (req, res) => {
  try {
    const role = normalizeRole(req.params.role);
    if (!USER_ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: "Invalid user role" });
    }

    const { entity } = await findEntityByRole(role, req.params.id);
    if (!entity) {
      return res
        .status(404)
        .json({ success: false, message: `${role} not found` });
    }

    await entity.deleteOne();

    await logActivity(req, {
      action: "DELETE_USER",
      targetType: role,
      targetId: req.params.id,
    });

    return res.json({ success: true, message: `${role} deleted successfully` });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to delete user",
      error: error.message,
    });
  }
});

// ---------------- ADMIN MANAGEMENT ----------------
router.get("/admins", requireSuperAdminAuth, async (req, res) => {
  try {
    const admins = await AdminUser.find({}).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, admins: admins.map(mapAdmin) });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch admins",
      error: error.message,
    });
  }
});

router.post("/admins", requireSuperAdminAuth, async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body.password || "").trim();
    const requestedAdminRole = normalizeRole(req.body.adminRole || req.body.admin_role || req.body.role);
    const adminRole = ADMIN_ROLES.includes(requestedAdminRole)
      ? requestedAdminRole
      : "PRODUCT_ADMIN";
    const permissions = normalizePermissions(req.body.permissions);

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "Name, email and password are required",
      });
    }

    const admin = new AdminUser({
      name,
      email,
      password,
      role: adminRole,
      status: "ACTIVE",
      assignedBy: req.superAdmin.email,
      permissions:
        permissions.length > 0
          ? permissions
          : ROLE_PERMISSION_MAP[adminRole] || ROLE_PERMISSION_MAP.PRODUCT_ADMIN,
      accessExpiresAt: req.body.accessExpiresAt ? new Date(req.body.accessExpiresAt) : null,
      temporaryAccessReason: String(req.body.temporaryAccessReason || "").trim(),
    });
    await admin.save();

    await logActivity(req, {
      action: "CREATE_ADMIN",
      targetType: "ADMIN",
      targetId: admin._id?.toString(),
      details: { email, permissions: admin.permissions },
    });

    return res.status(201).json({ success: true, admin: mapAdmin(admin) });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to create admin",
      error: error.message,
    });
  }
});

router.patch("/admins/:id/permissions", requireSuperAdminAuth, async (req, res) => {
  try {
    const permissions = normalizePermissions(req.body.permissions);
    if (permissions.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one valid permission is required",
      });
    }

    const admin = await AdminUser.findById(req.params.id);
    if (!admin) {
      return res.status(404).json({ success: false, message: "Admin not found" });
    }

    if (req.body.role != null || req.body.adminRole != null) {
      const nextRole = normalizeRole(req.body.role || req.body.adminRole);
      if (ADMIN_ROLES.includes(nextRole)) {
        admin.role = nextRole;
      }
    }

    admin.permissions = permissions;
    if (typeof req.body.accessExpiresAt !== "undefined") {
      admin.accessExpiresAt = req.body.accessExpiresAt ? new Date(req.body.accessExpiresAt) : null;
    }
    if (typeof req.body.temporaryAccessReason !== "undefined") {
      admin.temporaryAccessReason = String(req.body.temporaryAccessReason || "").trim();
    }
    await admin.save();

    await logActivity(req, {
      action: "UPDATE_ADMIN_PERMISSIONS",
      targetType: "ADMIN",
      targetId: admin._id?.toString(),
      details: { permissions },
    });

    return res.json({ success: true, admin: mapAdmin(admin) });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update admin permissions",
      error: error.message,
    });
  }
});

router.patch("/admins/:id/status", requireSuperAdminAuth, async (req, res) => {
  try {
    const status = normalizeStatus(req.body.status);
    if (!["ACTIVE", "BLOCKED"].includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: "Status must be ACTIVE or BLOCKED" });
    }

    const admin = await AdminUser.findById(req.params.id);
    if (!admin) {
      return res.status(404).json({ success: false, message: "Admin not found" });
    }

    admin.status = status;
    await admin.save();

    await logActivity(req, {
      action: "UPDATE_ADMIN_STATUS",
      targetType: "ADMIN",
      targetId: admin._id?.toString(),
      details: { status },
    });

    return res.json({ success: true, admin: mapAdmin(admin) });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update admin status",
      error: error.message,
    });
  }
});

// ---------------- ADVERTISEMENTS ----------------
router.get("/advertisements", requireSuperAdminAuth, async (req, res) => {
  try {
    const placement = normalizeRole(req.query.placement || "");
    const query = {};
    if (placement) {
      query.$or = [{ placement }, { placements: placement }];
    }
    const ads = await Advertisement.find(query).sort({ createdAt: -1 }).lean();
    const advertisements = await Promise.all(
      ads.map(async (ad) => ({
        ...ad,
        imageUrl: await resolveStoredMediaUrl({
          imageUrl: ad.imageUrl,
          imageKey: ad.imageKey,
        }),
      }))
    );
    return res.json({ success: true, advertisements });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch advertisements",
      error: error.message,
    });
  }
});

router.get(
  "/advertisements/:id/clicks",
  requireSuperAdminAuth,
  async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid advertisement id",
        });
      }

      const limit = Math.min(Number(req.query.limit || 100), 500);
      const clicks = await AdvertisementClickLog.find({
        advertisementId: req.params.id,
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

      return res.json({
        success: true,
        clicks,
        total: clicks.length,
      });
    } catch (error) {
      return res.status(500).json({
        success: false,
        message: "Failed to fetch advertisement clicks",
        error: error.message,
      });
    }
  }
);

router.post(
  "/advertisements/upload-image",
  requireSuperAdminAuth,
  (req, res) => {
    advertisementImageUpload.single("image")(req, res, async (error) => {
      if (error) {
        return res.status(400).json({
          success: false,
          message: error.message || "Image upload failed",
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Image file is required",
        });
      }

      try {
        let imageKey = "";
        let imageUrl = "";

        if (hasAWSCredentials) {
          imageKey = String(req.file.key || "").trim();
          if (!imageKey) {
            return res.status(500).json({
              success: false,
              message: "Failed to determine uploaded image key",
            });
          }
          imageUrl = await generateSignedUrl(imageKey, BUCKET_NAME);
        } else {
          const relativePath = `/uploads/superadmin/advertisements/${req.file.filename}`;
          imageKey = relativePath;
          imageUrl = `${publicServerBaseUrl()}${relativePath}`;
        }

        await logActivity(req, {
          action: "UPLOAD_ADVERTISEMENT_IMAGE",
          targetType: "ADVERTISEMENT_IMAGE",
          targetId: imageKey,
          details: { storage: hasAWSCredentials ? "S3" : "LOCAL" },
        });

        return res.status(201).json({
          success: true,
          imageKey,
          imageUrl,
          storage: hasAWSCredentials ? "S3" : "LOCAL",
        });
      } catch (uploadError) {
        return res.status(500).json({
          success: false,
          message: "Failed to process uploaded image",
          error: uploadError.message,
        });
      }
    });
  }
);

router.post("/advertisements", requireSuperAdminAuth, async (req, res) => {
  try {
    const placements = normalizeAdPlacements(
      req.body.placements ?? req.body.placement
    );
    const geoTargets = normalizeGeoTargets(req.body);
    const payload = {
      title: String(req.body.title || "").trim(),
      imageUrl: String(req.body.imageUrl || "").trim(),
      imageKey: String(req.body.imageKey || "").trim(),
      redirectUrl: String(req.body.redirectUrl || "").trim(),
      placement: placements[0] || "",
      placements,
      ...geoTargets,
      isActive: toBoolean(req.body.isActive, true),
      startDate: req.body.startDate,
      endDate: req.body.endDate,
      createdBy: req.superAdmin.email,
      updatedBy: req.superAdmin.email,
    };

    if (
      !payload.title ||
      (!payload.imageUrl && !payload.imageKey) ||
      !payload.redirectUrl ||
      !payload.placement ||
      placements.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "title, redirectUrl, at least one placement, and either imageUrl or imageKey are required",
      });
    }
    if (!validateDateOrder(payload.startDate, payload.endDate)) {
      return res.status(400).json({
        success: false,
        message: "Invalid startDate/endDate",
      });
    }

    const ad = await Advertisement.create(payload);
    clearPublicConfigCache();
    broadcastPublicConfigEvent({
      type: "ads.updated",
      surfaces: ad.placements || [ad.placement].filter(Boolean),
      platforms: [],
      reason: "SUPERADMIN_ADVERTISEMENT_CREATED",
    });

    await logActivity(req, {
      action: "CREATE_ADVERTISEMENT",
      targetType: "ADVERTISEMENT",
      targetId: ad._id?.toString(),
      details: {
        placements: ad.placements || [ad.placement],
        title: ad.title,
        geoScope: ad.geoScope,
      },
    });

    const advertisement = {
      ...ad.toObject(),
      imageUrl: await resolveStoredMediaUrl({
        imageUrl: ad.imageUrl,
        imageKey: ad.imageKey,
      }),
    };

    return res.status(201).json({ success: true, advertisement });
  } catch (error) {
    if (error?.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        message: error.message || "Invalid advertisement payload",
      });
    }
    return res.status(500).json({
      success: false,
      message: "Failed to create advertisement",
      error: error.message,
    });
  }
});

router.put("/advertisements/:id", requireSuperAdminAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid advertisement id",
      });
    }

    const ad = await Advertisement.findById(req.params.id);
    if (!ad) {
      return res.status(404).json({ success: false, message: "Advertisement not found" });
    }

    if (req.body.title != null) ad.title = String(req.body.title).trim();
    if (req.body.imageUrl != null) ad.imageUrl = String(req.body.imageUrl).trim();
    if (req.body.imageKey != null) ad.imageKey = String(req.body.imageKey).trim();
    if (req.body.redirectUrl != null) ad.redirectUrl = String(req.body.redirectUrl).trim();
    if (req.body.placements != null || req.body.placement != null) {
      const placements = normalizeAdPlacements(
        req.body.placements ?? req.body.placement
      );
      if (placements.length === 0) {
        return res.status(400).json({
          success: false,
          message: "At least one valid placement is required",
        });
      }
      ad.placements = placements;
      ad.placement = placements[0];
    }
    if (
      req.body.targetCountries != null ||
      req.body.targetStates != null ||
      req.body.targetRegions != null ||
      req.body.countries != null ||
      req.body.states != null ||
      req.body.regions != null
    ) {
      const geoTargets = normalizeGeoTargets(req.body);
      ad.geoScope = geoTargets.geoScope;
      ad.targetCountries = geoTargets.targetCountries;
      ad.targetStates = geoTargets.targetStates;
      ad.targetRegions = geoTargets.targetRegions;
    }
    if (req.body.isActive != null) ad.isActive = toBoolean(req.body.isActive, ad.isActive);
    if (req.body.startDate != null) ad.startDate = req.body.startDate;
    if (req.body.endDate != null) ad.endDate = req.body.endDate;
    ad.updatedBy = req.superAdmin.email;

    if (!String(ad.imageUrl || "").trim() && !String(ad.imageKey || "").trim()) {
      return res.status(400).json({
        success: false,
        message: "Either imageUrl or imageKey is required",
      });
    }

    if (!validateDateOrder(ad.startDate, ad.endDate)) {
      return res.status(400).json({
        success: false,
        message: "Invalid startDate/endDate",
      });
    }

    await ad.save();
    clearPublicConfigCache();
    broadcastPublicConfigEvent({
      type: "ads.updated",
      surfaces: ad.placements || [ad.placement].filter(Boolean),
      platforms: [],
      reason: "SUPERADMIN_ADVERTISEMENT_UPDATED",
    });

    await logActivity(req, {
      action: "UPDATE_ADVERTISEMENT",
      targetType: "ADVERTISEMENT",
      targetId: ad._id?.toString(),
      details: {
        placements: ad.placements || [ad.placement],
        isActive: ad.isActive,
        geoScope: ad.geoScope,
      },
    });

    const advertisement = {
      ...ad.toObject(),
      imageUrl: await resolveStoredMediaUrl({
        imageUrl: ad.imageUrl,
        imageKey: ad.imageKey,
      }),
    };

    return res.json({ success: true, advertisement });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update advertisement",
      error: error.message,
    });
  }
});

router.delete("/advertisements/:id", requireSuperAdminAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid advertisement id",
      });
    }

    const ad = await Advertisement.findById(req.params.id);
    if (!ad) {
      return res.status(404).json({ success: false, message: "Advertisement not found" });
    }
    const surfaces = ad.placements || [ad.placement].filter(Boolean);
    await ad.deleteOne();
    clearPublicConfigCache();
    broadcastPublicConfigEvent({
      type: "ads.updated",
      surfaces,
      platforms: [],
      reason: "SUPERADMIN_ADVERTISEMENT_DELETED",
    });

    await logActivity(req, {
      action: "DELETE_ADVERTISEMENT",
      targetType: "ADVERTISEMENT",
      targetId: req.params.id,
      details: { title: ad.title, placements: surfaces },
    });

    return res.json({ success: true, message: "Advertisement deleted" });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to delete advertisement",
      error: error.message,
    });
  }
});

// ---------------- PRODUCTS ----------------
router.get("/products", requireSuperAdminAuth, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const category = String(req.query.category || "").trim();
    const subCategory = String(req.query.subCategory || "").trim();
    const availability = String(req.query.availability || "").trim().toUpperCase();
    const isActive =
      req.query.isActive == null ? null : toBoolean(req.query.isActive, true);
    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);

    const query = {};
    if (category) query.category = category;
    if (subCategory) query.subCategory = subCategory;
    if (availability) query["inventory.availability"] = availability;
    if (typeof isActive === "boolean") query.isActive = isActive;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { shortDescription: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
        { tags: { $regex: search, $options: "i" } },
        { sku: { $regex: search, $options: "i" } },
      ];
    }

    const [products, total] = await Promise.all([
      Product.find(query)
        .select(
          "name shortDescription category subCategory tags mrp sellingPrice discountPercent inventory media.thumbnail imageUrl isActive sku brand updatedAt createdAt geoScope targetCountries targetStates targetRegions"
        )
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Product.countDocuments(query),
    ]);

    const normalizedProducts = await Promise.all(
      products.map(async (product) => ({
        ...product,
        imageUrl: await resolveStoredMediaUrl({
          imageUrl: product.imageUrl,
          imageKey: product.imageKey,
        }),
      }))
    );
    return res.json({
      success: true,
      products: normalizedProducts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch products",
      error: error.message,
    });
  }
});

router.get("/products/:id", requireSuperAdminAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid product id",
      });
    }
    const product = await Product.findById(req.params.id).lean();
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    const resolved = {
      ...product,
      imageUrl: await resolveStoredMediaUrl({
        imageUrl: product.imageUrl,
        imageKey: product.imageKey,
      }),
    };
    return res.json({ success: true, product: resolved });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch product",
      error: error.message,
    });
  }
});

router.post("/products", requireSuperAdminAuth, async (req, res) => {
  try {
    const geoTargets = normalizeGeoTargets(req.body);
    const media = normalizeMediaPayload(req.body);
    const name = String(req.body.name || "").trim();
    const category = String(req.body.category || "").trim();
    const mrp = Number(req.body.mrp ?? req.body.price ?? 0);
    const sellingPrice = Number(req.body.sellingPrice ?? req.body.price ?? 0);

    if (!name || !category) {
      return res.status(400).json({
        success: false,
        message: "name and category are required",
      });
    }
    if (!Number.isFinite(mrp) || !Number.isFinite(sellingPrice) || mrp < 0 || sellingPrice < 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid pricing values",
      });
    }
    if (sellingPrice > mrp && mrp > 0) {
      return res.status(400).json({
        success: false,
        message: "sellingPrice cannot exceed MRP",
      });
    }

    const payload = {
      name,
      shortDescription: String(req.body.shortDescription || req.body.description || "")
        .trim()
        .slice(0, 400),
      fullDescription: sanitizeRichText(req.body.fullDescription || ""),
      description: String(req.body.description || req.body.shortDescription || "").trim(),
      mrp,
      sellingPrice,
      price: sellingPrice,
      imageUrl: String(req.body.imageUrl || "").trim(),
      imageKey: String(req.body.imageKey || "").trim(),
      media,
      category,
      subCategory: String(req.body.subCategory || "").trim(),
      tags: normalizeTags(req.body.tags),
      inventory: {
        stock: Math.max(0, Number(req.body.stock ?? req.body.inventory?.stock ?? 0)),
        availability: String(
          req.body.availability || req.body.inventory?.availability || "IN_STOCK"
        )
          .trim()
          .toUpperCase(),
      },
      brand: String(req.body.brand || "").trim(),
      sku: String(req.body.sku || "").trim().toUpperCase(),
      expiryDate: req.body.expiryDate ? new Date(req.body.expiryDate) : null,
      prescriptionRequired: toBoolean(req.body.prescriptionRequired, false),
      customFields: normalizeCustomFields(req.body.customFields),
      ...geoTargets,
      isActive: toBoolean(req.body.isActive, true),
      createdBy: req.superAdmin.email,
      updatedBy: req.superAdmin.email,
    };

    const product = await Product.create(payload);
    clearPublicConfigCache();

    await logActivity(req, {
      action: "CREATE_PRODUCT",
      targetType: "PRODUCT",
      targetId: product._id?.toString(),
      details: {
        name: product.name,
        category: product.category,
        geoScope: product.geoScope,
      },
    });

    const responseProduct = {
      ...product.toObject(),
      imageUrl: await resolveStoredMediaUrl({
        imageUrl: product.imageUrl,
        imageKey: product.imageKey,
      }),
    };

    return res.status(201).json({ success: true, product: responseProduct });
  } catch (error) {
    if (error?.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        message: error.message || "Invalid product payload",
      });
    }
    return res.status(500).json({
      success: false,
      message: "Failed to create product",
      error: error.message,
    });
  }
});

router.put("/products/:id", requireSuperAdminAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid product id",
      });
    }
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    if (req.body.name != null) product.name = String(req.body.name).trim();
    if (req.body.shortDescription != null) {
      product.shortDescription = String(req.body.shortDescription).trim().slice(0, 400);
    }
    if (req.body.fullDescription != null) {
      product.fullDescription = sanitizeRichText(req.body.fullDescription);
    }
    if (req.body.description != null) product.description = String(req.body.description).trim();
    if (req.body.mrp != null) product.mrp = Number(req.body.mrp);
    if (req.body.sellingPrice != null) product.sellingPrice = Number(req.body.sellingPrice);
    if (req.body.price != null && req.body.sellingPrice == null) {
      product.sellingPrice = Number(req.body.price);
    }
    if (req.body.imageUrl != null) product.imageUrl = String(req.body.imageUrl).trim();
    if (req.body.imageKey != null) product.imageKey = String(req.body.imageKey).trim();
    if (
      req.body.media != null ||
      req.body.thumbnail != null ||
      req.body.images != null ||
      req.body.video != null
    ) {
      const media = normalizeMediaPayload(req.body);
      product.media = {
        ...(product.media || {}),
        ...media,
      };
    }
    if (req.body.category != null) product.category = String(req.body.category).trim();
    if (req.body.subCategory != null) product.subCategory = String(req.body.subCategory).trim();
    if (req.body.tags != null) product.tags = normalizeTags(req.body.tags);
    if (req.body.brand != null) product.brand = String(req.body.brand).trim();
    if (req.body.sku != null) product.sku = String(req.body.sku).trim().toUpperCase();
    if (req.body.expiryDate != null) {
      product.expiryDate = req.body.expiryDate ? new Date(req.body.expiryDate) : null;
    }
    if (req.body.prescriptionRequired != null) {
      product.prescriptionRequired = toBoolean(
        req.body.prescriptionRequired,
        product.prescriptionRequired
      );
    }
    if (req.body.customFields != null) {
      product.customFields = normalizeCustomFields(req.body.customFields);
    }
    if (req.body.stock != null || req.body.inventory?.stock != null) {
      const stock = Math.max(0, Number(req.body.stock ?? req.body.inventory?.stock ?? 0));
      product.inventory = {
        ...(product.inventory || {}),
        stock,
      };
    }
    if (req.body.availability != null || req.body.inventory?.availability != null) {
      const availability = String(
        req.body.availability || req.body.inventory?.availability || "IN_STOCK"
      )
        .trim()
        .toUpperCase();
      product.inventory = {
        ...(product.inventory || {}),
        availability,
      };
    }
    if (
      req.body.targetCountries != null ||
      req.body.targetStates != null ||
      req.body.targetRegions != null ||
      req.body.countries != null ||
      req.body.states != null ||
      req.body.regions != null
    ) {
      const geoTargets = normalizeGeoTargets(req.body);
      product.geoScope = geoTargets.geoScope;
      product.targetCountries = geoTargets.targetCountries;
      product.targetStates = geoTargets.targetStates;
      product.targetRegions = geoTargets.targetRegions;
    }
    if (req.body.isActive != null) {
      product.isActive = toBoolean(req.body.isActive, product.isActive);
    }
    if (
      Number.isFinite(Number(product.mrp)) &&
      Number.isFinite(Number(product.sellingPrice)) &&
      Number(product.sellingPrice) > Number(product.mrp) &&
      Number(product.mrp) > 0
    ) {
      return res.status(400).json({
        success: false,
        message: "sellingPrice cannot exceed MRP",
      });
    }
    product.updatedBy = req.superAdmin.email;
    await product.save();
    clearPublicConfigCache();

    await logActivity(req, {
      action: "UPDATE_PRODUCT",
      targetType: "PRODUCT",
      targetId: product._id?.toString(),
      details: {
        name: product.name,
        category: product.category,
        geoScope: product.geoScope,
      },
    });

    const responseProduct = {
      ...product.toObject(),
      imageUrl: await resolveStoredMediaUrl({
        imageUrl: product.imageUrl,
        imageKey: product.imageKey,
      }),
    };

    return res.json({ success: true, product: responseProduct });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update product",
      error: error.message,
    });
  }
});

router.delete("/products/:id", requireSuperAdminAuth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid product id",
      });
    }
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    await product.deleteOne();
    clearPublicConfigCache();

    await logActivity(req, {
      action: "DELETE_PRODUCT",
      targetType: "PRODUCT",
      targetId: req.params.id,
      details: { name: product.name },
    });

    return res.json({ success: true, message: "Product deleted" });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to delete product",
      error: error.message,
    });
  }
});

// ---------------- UI CONFIG ----------------
router.get("/ui-config", requireSuperAdminAuth, async (req, res) => {
  try {
    let config = await UIConfig.findOne({ key: "GLOBAL" }).lean();
    if (!config) {
      const created = await UIConfig.create({ key: "GLOBAL" });
      config = created.toObject();
    }
    return res.json({ success: true, config });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch UI config",
      error: error.message,
    });
  }
});

router.put("/ui-config", requireSuperAdminAuth, async (req, res) => {
  try {
    const payload = {};
    const hasDashboardAlerts = Array.isArray(req.body.dashboardAlerts);
    if (req.body.buttonColor != null) payload.buttonColor = String(req.body.buttonColor).trim();
    if (req.body.iconColor != null) payload.iconColor = String(req.body.iconColor).trim();
    if (req.body.cardStyle != null) payload.cardStyle = String(req.body.cardStyle).trim().toUpperCase();
    if (req.body.themeMode != null) payload.themeMode = String(req.body.themeMode).trim().toUpperCase();
    if (Array.isArray(req.body.qrActions)) payload.qrActions = req.body.qrActions;
    if (Array.isArray(req.body.dashboardCards)) payload.dashboardCards = req.body.dashboardCards;
    if (hasDashboardAlerts) payload.dashboardAlerts = req.body.dashboardAlerts;
    payload.updatedBy = req.superAdmin.email;

    const config = await UIConfig.findOneAndUpdate(
      { key: "GLOBAL" },
      { $set: payload, $setOnInsert: { key: "GLOBAL" } },
      { new: true, upsert: true }
    ).lean();

    clearPublicConfigCache();
    if (hasDashboardAlerts) {
      broadcastPublicConfigEvent({
        type: "alerts.updated",
        platforms: [...PUBLIC_ALERT_PLATFORMS],
        surfaces: [],
        reason: "UI_CONFIG_ALERTS_UPDATED",
      });
    }
    broadcastPublicConfigEvent({
      type: "ui-config.updated",
      platforms: [...PUBLIC_ALERT_PLATFORMS],
      surfaces: [...AD_SURFACES],
      reason: "UI_CONFIG_UPDATED",
    });
    await logActivity(req, {
      action: "UPDATE_UI_CONFIG",
      targetType: "UI_CONFIG",
      targetId: config?._id?.toString(),
      details: payload,
    });

    return res.json({ success: true, config });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to update UI config",
      error: error.message,
    });
  }
});

export default router;
