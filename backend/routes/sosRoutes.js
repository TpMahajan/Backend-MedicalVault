import express from "express";
import { auth, optionalAuth } from "../middleware/auth.js";
import SOS from "../models/SOS.js";

const router = express.Router();

// Create SOS message (patient/doctor)
router.post("/", auth, async (req, res) => {
  try {
    const role = req.auth?.role || "patient";
    const patientId = role === "patient" ? (req.user?._id || req.user?.id) : undefined;

    const { profileId, name, age, location } = req.body || {};

    const sos = await SOS.create({
      patientId,
      profileId: profileId?.toString?.() ?? profileId ?? "",
      name: name ?? "",
      age: age?.toString?.() ?? age ?? "",
      location: location ?? "",
      submittedByRole: role,
    });

    return res.status(201).json({ success: true, data: sos });
  } catch (e) {
    console.error("SOS create error:", e);
    return res.status(500).json({ success: false, message: "Failed to create SOS" });
  }
});

// List SOS messages FIFO (admins/doctors) — for now allow doctors
// TEMP: Public listing for prototyping admin UI; will secure later
router.get("/", optionalAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);
    const skip = Math.max(parseInt(req.query.skip || "0", 10), 0);
    const items = await SOS.find({}).sort({ createdAt: 1 }).skip(skip).limit(limit).lean();
    return res.json({ success: true, data: items });
  } catch (e) {
    console.error("SOS list error:", e);
    return res.status(500).json({ success: false, message: "Failed to fetch SOS" });
  }
});

export default router;


