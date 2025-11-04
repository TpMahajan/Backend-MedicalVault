// routes/qrRoutes.js
import express from "express";
import jwt from "jsonwebtoken";
import { auth } from "../middleware/auth.js";
import { User } from "../models/User.js";
import QRCode from "../models/QRCode.js"; // <-- new model

const router = express.Router();

/**
 * Quick check: confirm this router is mounted
 * GET /api/qr/ping
 */
router.get("/ping", (req, res) => res.json({ ok: true, where: "qrRoutes" }));

/**
 * POST /api/qr/generate
 * Auth: required (patient)
 * Creates a short-lived JWT that carries the patient's userId and email.
 * Stores it in DB and expires older QR codes for this patient.
 */
router.post("/generate", auth, async (req, res) => {
  try {
    // Always read latest normalized email from DB
    const me = await User.findById(req.user._id).select("email name");
    if (!me) return res.status(404).json({ ok: false, msg: "User not found" });

    // Expire any old active QR codes for this patient
    await QRCode.updateMany(
      { patientId: req.user._id, status: "active" },
      { status: "expired" }
    );

    // Generate short-lived anonymous-access JWT (15 minutes)
    const payload = {
      userId: req.user._id.toString(),
      uid: req.user._id.toString(), // provide both for backward/forward compatibility
      role: "anonymous",
      typ: "vault_share",
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "15m",
    });

    // Store new QR in DB
    const qrDoc = await QRCode.create({
      patientId: req.user._id,
      token,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 min
      status: "active",
    });

    // Build Web URL for anonymous access via Vercel-hosted web app
    const qrUrl = `https://health-vault-web.vercel.app/patient-details/${req.user._id.toString()}?token=${encodeURIComponent(token)}`;

    return res.json({
      ok: true,
      token,
      qrUrl,
      expiresAt: qrDoc.expiresAt,
    });
  } catch (err) {
    console.error("QR generate error:", err);
    return res.status(500).json({ ok: false, msg: "QR generation failed" });
  }
});

/**
 * GET /api/qr/resolve/:token
 * Public (no auth): resolves QR token and returns user's grouped documents
 */
router.get("/resolve/:token", async (req, res) => {
  try {
    const { token } = req.params;
    if (!token)
      return res.status(400).json({ success: false, msg: "Missing token" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.typ !== "vault_share") {
      return res.status(400).json({ success: false, msg: "Invalid token type" });
    }

    // Check DB to see if this QR is still active
    const qrDoc = await QRCode.findOne({ token, status: "active" });
    if (!qrDoc) {
      return res.status(400).json({ success: false, msg: "QR expired or invalid" });
    }

    // Fetch user's grouped documents
    const { Document } = await import("../models/File.js");
    const targetUid = decoded.uid || decoded.userId;
    const docs = await Document.find({ patientId: targetUid });

    const grouped = {
      reports: docs.filter(d => d.type?.toLowerCase() === "lab report" || d.type?.toLowerCase() === "imaging"),
      prescriptions: docs.filter(d => d.type?.toLowerCase() === "prescription"),
      bills: docs.filter(d => d.type?.toLowerCase() === "bill"),
      insurance: docs.filter(d => d.type?.toLowerCase() === "insurance"),
      others: docs.filter(d =>
        !["lab report", "imaging", "prescription", "bill", "insurance"].includes(d.type?.toLowerCase())
      ),
    };

    return res.json({
      success: true,
      patientId: targetUid,
      counts: Object.fromEntries(Object.entries(grouped).map(([k, v]) => [k, v.length])),
      records: grouped,
    });
  } catch (e) {
    return res
      .status(400)
      .json({ success: false, msg: "Invalid/expired token", error: e.message });
  }
});

/**
 * GET /api/qr/preview?token=...
 * Public (no auth): used by the web portal after scanning to show
 * patient info before the doctor clicks "Request Access".
 */
router.get("/preview", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token)
      return res.status(400).json({ ok: false, msg: "Missing token" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.typ !== "vault_share") {
      return res.status(400).json({ ok: false, msg: "Invalid token type" });
    }

    // Check DB to see if this QR is still active
    const qrDoc = await QRCode.findOne({ token, status: "active" });
    if (!qrDoc) {
      return res.status(400).json({ ok: false, msg: "QR expired or invalid" });
    }

    // Fetch full patient profile
    const targetUid = decoded.uid || decoded.userId;
    const user = await User.findById(targetUid).select(
      "name email profilePicture age gender dateOfBirth bloodType height weight lastVisit nextAppointment emergencyContact medicalHistory medications medicalRecords"
    );

    if (!user)
      return res.status(404).json({ ok: false, msg: "Patient not found" });

    return res.json({
      ok: true,
      patient: user,
      expiresAt: decoded.exp ? decoded.exp * 1000 : null,
    });
  } catch (e) {
    return res
      .status(400)
      .json({ ok: false, msg: "Invalid/expired token", error: e.message });
  }
});

/**
 * GET /api/qr/validate?token=...
 * Public (no auth): returns { valid: boolean, expiresAt?, patientId? }
 */
router.get("/validate", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.json({ valid: false, reason: "missing_token" });

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      return res.json({ valid: false, reason: "jwt_invalid_or_expired" });
    }

    const qrDoc = await QRCode.findOne({ token, status: "active" });
    if (!qrDoc) {
      return res.json({ valid: false, reason: "not_active" });
    }

    return res.json({
      valid: true,
      expiresAt: decoded.exp ? decoded.exp * 1000 : qrDoc.expiresAt,
      patientId: decoded.uid || decoded.userId,
    });
  } catch (e) {
    return res.json({ valid: false, reason: "error", error: e.message });
  }
});

/**
 * POST /api/qr/invalidate
 * Auth: patient. Expires all active QR codes for this patient immediately.
 */
router.post("/invalidate", auth, async (req, res) => {
  try {
    const result = await QRCode.updateMany(
      { patientId: req.user._id, status: "active" },
      { status: "expired" }
    );
    return res.json({ ok: true, expired: result.modifiedCount || 0 });
  } catch (e) {
    return res.status(500).json({ ok: false, msg: "Failed to invalidate", error: e.message });
  }
});

/**
 * POST /api/qr/expire-all
 * Alias of /invalidate
 */
router.post("/expire-all", auth, async (req, res) => {
  try {
    const result = await QRCode.updateMany(
      { patientId: req.user._id, status: "active" },
      { status: "expired" }
    );
    return res.json({ ok: true, expired: result.modifiedCount || 0 });
  } catch (e) {
    return res.status(500).json({ ok: false, msg: "Failed to expire-all", error: e.message });
  }
});

/**
 * POST /api/qr/rotate
 * Auth: patient. Expires old and creates a new QR (same as generate).
 */
router.post("/rotate", auth, async (req, res) => {
  try {
    // expire current actives
    await QRCode.updateMany({ patientId: req.user._id, status: "active" }, { status: "expired" });

    const payload = {
      userId: req.user._id.toString(),
      uid: req.user._id.toString(),
      role: "anonymous",
      typ: "vault_share",
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "15m" });

    const qrDoc = await QRCode.create({
      patientId: req.user._id,
      token,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      status: "active",
    });

    const qrUrl = `https://health-vault-web.vercel.app/patient-details/${req.user._id.toString()}?token=${encodeURIComponent(token)}`;

    return res.json({ ok: true, token, qrUrl, expiresAt: qrDoc.expiresAt });
  } catch (e) {
    return res.status(500).json({ ok: false, msg: "QR rotate failed", error: e.message });
  }
});

export default router;
