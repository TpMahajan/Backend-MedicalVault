import express from "express";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";

import { requireSuperAdminAuth } from "../middleware/superAdminAuth.js";
import { User } from "../models/User.js";
import { DoctorUser } from "../models/DoctorUser.js";
import { AdminUser } from "../models/AdminUser.js";
import { Advertisement } from "../models/Advertisement.js";
import { Product } from "../models/Product.js";
import { UIConfig } from "../models/UIConfig.js";
import { Notification } from "../models/Notification.js";
import { SuperAdminActivityLog } from "../models/SuperAdminActivityLog.js";
import { AdvertisementClickLog } from "../models/AdvertisementClickLog.js";
import { clearPublicConfigCache } from "./publicConfig.js";
import { initializeFirebase, sendPushNotification } from "../config/firebase.js";

const router = express.Router();
initializeFirebase();

const SUPERADMIN_EMAIL = String(
  process.env.SUPERADMIN_EMAIL || "superadmin@medicalvault.in"
)
  .trim()
  .toLowerCase();
const SUPERADMIN_PASSWORD = String(
  process.env.SUPERADMIN_PASSWORD || "111111"
).trim();

const LOGIN_LIMITER = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const PERMISSIONS = [
  "MANAGE_USERS",
  "MANAGE_ADS",
  "MANAGE_PRODUCTS",
  "MANAGE_ALERTS",
  "MANAGE_NOTIFICATIONS",
];
const USER_ROLES = ["PATIENT", "DOCTOR", "ADMIN"];
const ALERT_AUDIENCES = ["ALL", "PATIENT", "DOCTOR"];
const ALERT_PLATFORMS = ["ALL", "APP", "WEB"];

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
    role: admin.role || "ADMIN",
    status: admin.status || (admin.isActive === false ? "BLOCKED" : "ACTIVE"),
    permissions: admin.permissions || [],
    assignedBy: admin.assignedBy || SUPERADMIN_EMAIL,
    createdAt: admin.createdAt,
    updatedAt: admin.updatedAt,
    type: "ADMIN",
  };
}

function signSuperAdminToken() {
  return jwt.sign(
    {
      role: "SUPERADMIN",
      email: SUPERADMIN_EMAIL,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "12h" }
  );
}

async function logActivity(req, payload) {
  try {
    await SuperAdminActivityLog.create({
      actorEmail: req.superAdmin?.email || SUPERADMIN_EMAIL,
      action: payload.action,
      targetType: payload.targetType || "",
      targetId: payload.targetId || "",
      details: payload.details || {},
      ipAddress: req.ip || "",
      userAgent: req.headers["user-agent"] || "",
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

    if (email !== SUPERADMIN_EMAIL || password !== SUPERADMIN_PASSWORD) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid SuperAdmin credentials" });
    }

    const token = signSuperAdminToken();
    return res.json({
      success: true,
      token,
      user: {
        email: SUPERADMIN_EMAIL,
        role: "SUPERADMIN",
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

    return res.json({
      success: true,
      count: filtered.length,
      alerts: filtered,
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
    const platform = normalizeAlertPlatform(req.body.platform);
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

    await logActivity(req, {
      action: "BROADCAST_ALERT",
      targetType: "ALERT",
      targetId: alertId,
      details: {
        title: newAlert.title,
        audience,
        platform,
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
    const password = String(req.body.password || "111111").trim();

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

    const adminPermissions = normalizePermissions(req.body.permissions);
    const admin = new AdminUser({
      name,
      email,
      password,
      assignedBy: req.superAdmin.email,
      permissions: adminPermissions.length > 0 ? adminPermissions : ["MANAGE_USERS"],
      role: "ADMIN",
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
      role: "ADMIN",
      status: "ACTIVE",
      assignedBy: req.superAdmin.email,
      permissions: permissions.length > 0 ? permissions : ["MANAGE_USERS"],
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

    admin.permissions = permissions;
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
    if (placement) query.placement = placement;
    const ads = await Advertisement.find(query).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, advertisements: ads });
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

router.post("/advertisements", requireSuperAdminAuth, async (req, res) => {
  try {
    const payload = {
      title: String(req.body.title || "").trim(),
      imageUrl: String(req.body.imageUrl || "").trim(),
      redirectUrl: String(req.body.redirectUrl || "").trim(),
      placement: normalizeRole(req.body.placement),
      isActive: toBoolean(req.body.isActive, true),
      startDate: req.body.startDate,
      endDate: req.body.endDate,
      createdBy: req.superAdmin.email,
      updatedBy: req.superAdmin.email,
    };

    if (!payload.title || !payload.imageUrl || !payload.redirectUrl || !payload.placement) {
      return res.status(400).json({
        success: false,
        message: "title, imageUrl, redirectUrl and placement are required",
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

    await logActivity(req, {
      action: "CREATE_ADVERTISEMENT",
      targetType: "ADVERTISEMENT",
      targetId: ad._id?.toString(),
      details: { placement: ad.placement, title: ad.title },
    });

    return res.status(201).json({ success: true, advertisement: ad });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to create advertisement",
      error: error.message,
    });
  }
});

router.put("/advertisements/:id", requireSuperAdminAuth, async (req, res) => {
  try {
    const ad = await Advertisement.findById(req.params.id);
    if (!ad) {
      return res.status(404).json({ success: false, message: "Advertisement not found" });
    }

    if (req.body.title != null) ad.title = String(req.body.title).trim();
    if (req.body.imageUrl != null) ad.imageUrl = String(req.body.imageUrl).trim();
    if (req.body.redirectUrl != null) ad.redirectUrl = String(req.body.redirectUrl).trim();
    if (req.body.placement != null) ad.placement = normalizeRole(req.body.placement);
    if (req.body.isActive != null) ad.isActive = toBoolean(req.body.isActive, ad.isActive);
    if (req.body.startDate != null) ad.startDate = req.body.startDate;
    if (req.body.endDate != null) ad.endDate = req.body.endDate;
    ad.updatedBy = req.superAdmin.email;

    if (!validateDateOrder(ad.startDate, ad.endDate)) {
      return res.status(400).json({
        success: false,
        message: "Invalid startDate/endDate",
      });
    }

    await ad.save();
    clearPublicConfigCache();

    await logActivity(req, {
      action: "UPDATE_ADVERTISEMENT",
      targetType: "ADVERTISEMENT",
      targetId: ad._id?.toString(),
      details: { placement: ad.placement, isActive: ad.isActive },
    });

    return res.json({ success: true, advertisement: ad });
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
    const ad = await Advertisement.findById(req.params.id);
    if (!ad) {
      return res.status(404).json({ success: false, message: "Advertisement not found" });
    }
    await ad.deleteOne();
    clearPublicConfigCache();

    await logActivity(req, {
      action: "DELETE_ADVERTISEMENT",
      targetType: "ADVERTISEMENT",
      targetId: req.params.id,
      details: { title: ad.title },
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
    const category = String(req.query.category || "").trim();
    const query = {};
    if (category) query.category = category;
    const products = await Product.find(query).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, products });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch products",
      error: error.message,
    });
  }
});

router.post("/products", requireSuperAdminAuth, async (req, res) => {
  try {
    const payload = {
      name: String(req.body.name || "").trim(),
      description: String(req.body.description || "").trim(),
      price: Number(req.body.price || 0),
      imageUrl: String(req.body.imageUrl || "").trim(),
      category: String(req.body.category || "").trim(),
      isActive: toBoolean(req.body.isActive, true),
      createdBy: req.superAdmin.email,
      updatedBy: req.superAdmin.email,
    };

    if (!payload.name || !payload.category) {
      return res.status(400).json({
        success: false,
        message: "name and category are required",
      });
    }

    const product = await Product.create(payload);
    clearPublicConfigCache();

    await logActivity(req, {
      action: "CREATE_PRODUCT",
      targetType: "PRODUCT",
      targetId: product._id?.toString(),
      details: { name: product.name, category: product.category },
    });

    return res.status(201).json({ success: true, product });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to create product",
      error: error.message,
    });
  }
});

router.put("/products/:id", requireSuperAdminAuth, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    if (req.body.name != null) product.name = String(req.body.name).trim();
    if (req.body.description != null) product.description = String(req.body.description).trim();
    if (req.body.price != null) product.price = Number(req.body.price);
    if (req.body.imageUrl != null) product.imageUrl = String(req.body.imageUrl).trim();
    if (req.body.category != null) product.category = String(req.body.category).trim();
    if (req.body.isActive != null) {
      product.isActive = toBoolean(req.body.isActive, product.isActive);
    }
    product.updatedBy = req.superAdmin.email;
    await product.save();
    clearPublicConfigCache();

    await logActivity(req, {
      action: "UPDATE_PRODUCT",
      targetType: "PRODUCT",
      targetId: product._id?.toString(),
      details: { name: product.name, category: product.category },
    });

    return res.json({ success: true, product });
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
    if (req.body.buttonColor != null) payload.buttonColor = String(req.body.buttonColor).trim();
    if (req.body.iconColor != null) payload.iconColor = String(req.body.iconColor).trim();
    if (req.body.cardStyle != null) payload.cardStyle = String(req.body.cardStyle).trim().toUpperCase();
    if (req.body.themeMode != null) payload.themeMode = String(req.body.themeMode).trim().toUpperCase();
    if (Array.isArray(req.body.qrActions)) payload.qrActions = req.body.qrActions;
    if (Array.isArray(req.body.dashboardCards)) payload.dashboardCards = req.body.dashboardCards;
    if (Array.isArray(req.body.dashboardAlerts)) payload.dashboardAlerts = req.body.dashboardAlerts;
    payload.updatedBy = req.superAdmin.email;

    const config = await UIConfig.findOneAndUpdate(
      { key: "GLOBAL" },
      { $set: payload, $setOnInsert: { key: "GLOBAL" } },
      { new: true, upsert: true }
    ).lean();

    clearPublicConfigCache();
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
