import express from "express";
import { AdminUser } from "../models/AdminUser.js";
import { MassIncident } from "../models/MassIncident.js";
import { requireAdminAuth } from "../middleware/adminAuth.js";
import { authLimiter } from "../middleware/rateLimit.js";
import {
  clearAuthCookies,
  hashToken,
  issueAuthTokenSet,
  parseCookies,
  setAuthCookies,
  verifyRefreshToken,
} from "../services/tokenService.js";
import { RefreshToken } from "../models/RefreshToken.js";
import {
  isActorTemporarilyBlocked,
  monitorFailedLogin,
  monitorSuspiciousSession,
} from "../services/securityMonitorService.js";

const router = express.Router();

// POST /api/admin/signup
// Disabled in production-grade mode: Admins can only be created by SuperAdmin APIs.
router.post("/signup", (_req, res) => {
  return res.status(403).json({
    success: false,
    message: "Public admin signup is disabled. Contact SuperAdmin.",
  });
});

const persistRefreshToken = async (req, adminId, refreshToken, refreshMeta) => {
  const decoded = verifyRefreshToken(refreshToken);
  const expiresAt = new Date((decoded.exp || 0) * 1000);
  const existingActiveSession = await RefreshToken.findOne({
    principalId: String(adminId),
    role: "admin",
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: -1 })
    .select("createdByIp deviceInfo userAgent")
    .lean();
  const incomingDevice = String(req.headers["sec-ch-ua-platform"] || req.headers["x-device-info"] || "");
  const incomingIp = req.ip || "";
  if (
    existingActiveSession &&
    ((incomingDevice && existingActiveSession.deviceInfo && incomingDevice !== existingActiveSession.deviceInfo) ||
      (incomingIp && existingActiveSession.createdByIp && incomingIp !== existingActiveSession.createdByIp))
  ) {
    await monitorSuspiciousSession({
      actorEmail: req.body?.email || "",
      actorRole: "admin",
      ipAddress: incomingIp,
      userAgent: req.headers["user-agent"] || "",
      metadata: {
        previousDevice: existingActiveSession.deviceInfo || "",
        previousIp: existingActiveSession.createdByIp || "",
        newDevice: incomingDevice,
        newIp: incomingIp,
      },
    });
  }

  await RefreshToken.create({
    principalId: String(adminId),
    role: "admin",
    tokenHash: hashToken(refreshToken),
    familyId: refreshMeta.familyId,
    jti: refreshMeta.jti,
    expiresAt,
    createdByIp: req.ip || "",
    userAgent: req.headers["user-agent"] || "",
    deviceInfo: String(req.headers["sec-ch-ua-platform"] || req.headers["x-device-info"] || ""),
    lastActiveAt: new Date(),
  });
};

// POST /api/admin/login
router.post("/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const blockState = await isActorTemporarilyBlocked({ actorEmail: email, actorRole: "admin" });
    if (blockState.isBlocked) {
      return res.status(429).json({ success: false, message: "Account temporarily blocked due to suspicious activity" });
    }
    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required" });
    }

    const admin = await AdminUser.findOne({ email: String(email).toLowerCase().trim() });
    if (!admin || admin.isActive === false || admin.status === "BLOCKED") {
      await monitorFailedLogin({
        actorEmail: email,
        actorRole: "admin",
        ipAddress: req.ip || "",
        userAgent: req.headers["user-agent"] || "",
        source: "admin_login",
      });
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const valid = await admin.comparePassword(password);
    if (!valid) {
      await monitorFailedLogin({
        actorEmail: email,
        actorRole: "admin",
        ipAddress: req.ip || "",
        userAgent: req.headers["user-agent"] || "",
        source: "admin_login",
      });
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    admin.lastLogin = new Date();
    await admin.save();

    const { accessToken, refreshToken, refreshMeta } = issueAuthTokenSet({
      principalId: admin._id.toString(),
      role: "admin",
      email: admin.email,
    });

    await persistRefreshToken(req, admin._id, refreshToken, refreshMeta);

    setAuthCookies(res, { accessToken, refreshToken });

    return res.json({
      success: true,
      message: "Login successful",
      admin: {
        id: admin._id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
        permissions: admin.permissions || [],
        isActive: admin.isActive !== false,
      },
      token: accessToken,
      refreshToken,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/me", requireAdminAuth, async (req, res) => {
  const admin = req.admin;
  if (!admin) {
    return res.status(404).json({ success: false, message: "Admin profile not found" });
  }

  return res.json({
    success: true,
    admin: {
      id: admin._id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      permissions: admin.permissions || [],
      isActive: admin.isActive !== false,
      lastLogin: admin.lastLogin || null,
    },
  });
});

router.post("/refresh", async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const provided = String(req.body?.refreshToken || cookies.mv_rt || "").trim();
    if (!provided) return res.status(401).json({ success: false, message: "Refresh token required" });

    const decoded = verifyRefreshToken(provided);
    if (String(decoded.role || "").toLowerCase() !== "admin") {
      return res.status(403).json({ success: false, message: "Invalid refresh token role" });
    }

    const tokenHash = hashToken(provided);
    const stored = await RefreshToken.findOne({ tokenHash, revokedAt: null });
    if (!stored || stored.expiresAt <= new Date()) {
      return res.status(401).json({ success: false, message: "Refresh token expired or revoked" });
    }

    const admin = await AdminUser.findById(stored.principalId);
    if (!admin || admin.isActive === false || admin.status === "BLOCKED") {
      return res.status(403).json({ success: false, message: "Admin account inactive" });
    }

    const { accessToken, refreshToken, refreshMeta } = issueAuthTokenSet({
      principalId: admin._id.toString(),
      role: "admin",
      email: admin.email,
      familyId: decoded.familyId,
    });

    stored.revokedAt = new Date();
    stored.revokedReason = "rotated";
    stored.replacedByTokenHash = hashToken(refreshToken);
    await stored.save();

    await persistRefreshToken(req, admin._id, refreshToken, refreshMeta);
    setAuthCookies(res, { accessToken, refreshToken });

    return res.json({ success: true, token: accessToken, refreshToken });
  } catch {
    return res.status(401).json({ success: false, message: "Invalid refresh token" });
  }
});

router.post("/logout", requireAdminAuth, async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const provided = String(req.body?.refreshToken || cookies.mv_rt || "").trim();
    if (provided) {
      await RefreshToken.updateOne(
        { tokenHash: hashToken(provided), revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: "logout" } }
      );
    }

    clearAuthCookies(res);
    return res.json({ success: true, message: "Logged out successfully" });
  } catch {
    return res.status(500).json({ success: false, message: "Logout failed" });
  }
});

router.get("/mass-incidents", requireAdminAuth, async (_req, res) => {
  try {
    const status = (_req.query.status || "active").toString();
    const incidents = await MassIncident.find({ status })
      .sort({ lastSOSAt: -1 })
      .lean();

    res.json({ success: true, incidents });
  } catch (err) {
    console.error("Fetch mass incidents error:", err);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch mass incidents" });
  }
});

export default router;
