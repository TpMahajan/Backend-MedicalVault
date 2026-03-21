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

  await RefreshToken.create({
    principalId: String(adminId),
    role: "admin",
    tokenHash: hashToken(refreshToken),
    familyId: refreshMeta.familyId,
    jti: refreshMeta.jti,
    expiresAt,
    createdByIp: req.ip || "",
    userAgent: req.headers["user-agent"] || "",
  });
};

// POST /api/admin/login
router.post("/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required" });
    }

    const admin = await AdminUser.findOne({ email: String(email).toLowerCase().trim() });
    if (!admin || admin.isActive === false || admin.status === "BLOCKED") {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    const valid = await admin.comparePassword(password);
    if (!valid) return res.status(401).json({ success: false, message: "Invalid credentials" });

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
      admin: { id: admin._id, name: admin.name, email: admin.email },
      token: accessToken,
      refreshToken,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
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
