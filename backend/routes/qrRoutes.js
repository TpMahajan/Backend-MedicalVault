// routes/qrRoutes.js
import express from "express";
import jwt from "jsonwebtoken";
import { auth } from "../middleware/auth.js";
import User from "../models/User.js";
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

    const payload = {
      typ: "vault_share",
      uid: req.user._id.toString(),
      email: me.email,
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: "10m",
    });

    // Store new QR in DB
    const qrDoc = await QRCode.create({
      patientId: req.user._id,
      token,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 min
      status: "active",
    });

    // Build URL to embed in QR
    const base = (process.env.BASE_URL || "").replace(/\/$/, "");
    const qrUrl = `${base}/portal/access?token=${encodeURIComponent(token)}`;

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
 * GET /api/qr/preview?token=...
 * Public (no auth): used by the web portal after scanning to show
 * patient info before the doctor clicks “Request Access”.
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
    const user = await User.findById(decoded.uid).select(
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

export default router;
