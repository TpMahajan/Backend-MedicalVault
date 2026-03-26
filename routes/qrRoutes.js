import crypto from "crypto";
import express from "express";
import { auth } from "../middleware/auth.js";
import { User } from "../models/User.js";
import QRCode from "../models/QRCode.js";
import { ok, fail } from "../utils/apiResponse.js";

const router = express.Router();

const SHARE_TTL_MS = 15 * 60 * 1000;
const FRONTEND_URL = String(
  process.env.WEB_APP_URL ||
    process.env.FRONTEND_URL ||
    "https://medicalvault-aially.vercel.app"
).replace(/\/+$/, "");

const normalizeRole = (role) => String(role || "").trim().toLowerCase();
const isPrivilegedRole = (role) => role === "admin" || role === "superadmin";

const resolveShareCodeFromRequest = (req) => {
  const fromPath = String(req.params?.token || req.params?.shareCode || "").trim();
  if (fromPath) return fromPath;

  // Backward compatibility: old clients still send `?token=...`.
  const fromQuery = String(req.query?.share || req.query?.token || "").trim();
  return fromQuery;
};

const findActiveShare = async (shareCode) => {
  if (!shareCode) return null;

  return QRCode.findOne({
    token: shareCode,
    status: "active",
    expiresAt: { $gt: new Date() },
  }).lean();
};

const ensurePatientRole = (req, res) => {
  const role = normalizeRole(req.auth?.role);
  if (role !== "patient") {
    res.status(403).json({ success: false, message: "Patient access required" });
    return false;
  }
  return true;
};

/**
 * Quick check: confirm this router is mounted
 * GET /api/qr/ping
 */
router.get("/ping", (_req, res) => res.json({ ok: true, where: "qrRoutes" }));

/**
 * POST /api/qr/generate
 * Auth: patient
 * Creates a short-lived share code and stores it server-side.
 */
router.post("/generate", auth, async (req, res) => {
  try {
    if (!ensurePatientRole(req, res)) return;

    const patientId = String(req.auth.id || "");
    const me = await User.findById(patientId).select("email name");
    if (!me) {
      return res.status(404).json({ ok: false, msg: "User not found" });
    }

    await QRCode.updateMany(
      { patientId: me._id, status: "active" },
      { status: "expired" }
    );

    const shareCode = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SHARE_TTL_MS);

    await QRCode.create({
      patientId: me._id,
      token: shareCode,
      expiresAt,
      status: "active",
    });

    const qrUrl = `${FRONTEND_URL}/patient-details/${me._id.toString()}?share=${encodeURIComponent(shareCode)}`;

    return ok(res, {
      message: "QR generated",
      data: { shareCode, qrUrl, expiresAt },
      // Backward-compatible field names for existing clients.
      legacy: { ok: true, token: shareCode, qrUrl, expiresAt },
    });
  } catch (err) {
    console.error("QR generate error:", err);
    return fail(res, {
      status: 500,
      message: "QR generation failed",
      legacy: { ok: false, msg: "QR generation failed" },
      error: err.message,
    });
  }
});

/**
 * GET /api/qr/resolve/:token
 * Auth: patient (owner) or admin/superadmin
 */
router.get("/resolve/:token", auth, async (req, res) => {
  try {
    const shareCode = resolveShareCodeFromRequest(req);
    if (!shareCode) {
      return res.status(400).json({ success: false, msg: "Missing share code" });
    }

    const qrDoc = await findActiveShare(shareCode);
    if (!qrDoc) {
      return res.status(400).json({ success: false, msg: "QR expired or invalid" });
    }

    const role = normalizeRole(req.auth?.role);
    const requesterId = String(req.auth?.id || "");
    const patientId = String(qrDoc.patientId || "");

    if (!isPrivilegedRole(role) && !(role === "patient" && requesterId === patientId)) {
      return res.status(403).json({ success: false, msg: "Access denied" });
    }

    const { Document } = await import("../models/File.js");
    const docs = await Document.find({ userId: patientId }).lean();

    const grouped = {
      reports: docs.filter((d) => d.category?.toLowerCase() === "report"),
      prescriptions: docs.filter((d) => d.category?.toLowerCase() === "prescription"),
      bills: docs.filter((d) => d.category?.toLowerCase() === "bill"),
      insurance: docs.filter((d) =>
        d.category?.toLowerCase() === "insurance"
      ),
    };

    return ok(res, {
      message: "QR resolved",
      data: {
        patientId,
        counts: Object.fromEntries(
          Object.entries(grouped).map(([k, v]) => [k, v.length])
        ),
        records: grouped,
      },
      legacy: {
        patientId,
        counts: Object.fromEntries(
          Object.entries(grouped).map(([k, v]) => [k, v.length])
        ),
        records: grouped,
      },
    });
  } catch (e) {
    return fail(res, {
      status: 400,
      message: "Invalid/expired share code",
      legacy: { msg: "Invalid/expired share code" },
      error: e.message,
    });
  }
});

/**
 * GET /api/qr/preview?share=...
 * Auth: doctor/admin/superadmin
 */
router.get("/preview", auth, async (req, res) => {
  try {
    const role = normalizeRole(req.auth?.role);
    if (!["doctor", "admin", "superadmin"].includes(role)) {
      return res.status(403).json({ ok: false, msg: "Access denied" });
    }

    const shareCode = resolveShareCodeFromRequest(req);
    if (!shareCode) {
      return res.status(400).json({ ok: false, msg: "Missing share code" });
    }

    const qrDoc = await findActiveShare(shareCode);
    if (!qrDoc) {
      return res.status(400).json({ ok: false, msg: "QR expired or invalid" });
    }

    const user = await User.findById(qrDoc.patientId).select(
      "name age gender bloodType profilePicture"
    );
    if (!user) {
      return res.status(404).json({ ok: false, msg: "Patient not found" });
    }

    return res.json({
      ok: true,
      patient: user,
      expiresAt: qrDoc.expiresAt,
    });
  } catch (e) {
    return res
      .status(400)
      .json({ ok: false, msg: "Invalid/expired share code", error: e.message });
  }
});

/**
 * GET /api/qr/validate?share=...
 * Auth: doctor/admin/superadmin
 */
router.get("/validate", auth, async (req, res) => {
  try {
    const role = normalizeRole(req.auth?.role);
    if (!["doctor", "admin", "superadmin"].includes(role)) {
      return res.status(403).json({ valid: false, reason: "access_denied" });
    }

    const shareCode = resolveShareCodeFromRequest(req);
    if (!shareCode) return res.json({ valid: false, reason: "missing_share_code" });

    const qrDoc = await findActiveShare(shareCode);
    if (!qrDoc) {
      return res.json({ valid: false, reason: "not_active" });
    }

    return res.json({
      valid: true,
      expiresAt: qrDoc.expiresAt,
      patientId: String(qrDoc.patientId),
    });
  } catch (e) {
    return res.json({ valid: false, reason: "error", error: e.message });
  }
});

/**
 * POST /api/qr/invalidate
 * Auth: patient
 */
router.post("/invalidate", auth, async (req, res) => {
  try {
    if (!ensurePatientRole(req, res)) return;

    const result = await QRCode.updateMany(
      { patientId: req.auth.id, status: "active" },
      { status: "expired" }
    );
    return res.json({ ok: true, expired: result.modifiedCount || 0 });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, msg: "Failed to invalidate", error: e.message });
  }
});

/**
 * POST /api/qr/expire-all
 * Alias of /invalidate
 */
router.post("/expire-all", auth, async (req, res) => {
  try {
    if (!ensurePatientRole(req, res)) return;

    const result = await QRCode.updateMany(
      { patientId: req.auth.id, status: "active" },
      { status: "expired" }
    );
    return res.json({ ok: true, expired: result.modifiedCount || 0 });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, msg: "Failed to expire-all", error: e.message });
  }
});

/**
 * POST /api/qr/rotate
 * Auth: patient
 */
router.post("/rotate", auth, async (req, res) => {
  try {
    if (!ensurePatientRole(req, res)) return;

    await QRCode.updateMany(
      { patientId: req.auth.id, status: "active" },
      { status: "expired" }
    );

    const shareCode = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SHARE_TTL_MS);

    await QRCode.create({
      patientId: req.auth.id,
      token: shareCode,
      expiresAt,
      status: "active",
    });

    const qrUrl = `${FRONTEND_URL}/patient-details/${req.auth.id}?share=${encodeURIComponent(shareCode)}`;
    return res.json({
      ok: true,
      shareCode,
      token: shareCode,
      qrUrl,
      expiresAt,
    });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, msg: "QR rotate failed", error: e.message });
  }
});

export default router;
