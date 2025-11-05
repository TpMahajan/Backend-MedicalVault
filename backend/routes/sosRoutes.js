import express from "express";
import { auth, optionalAuth } from "../middleware/auth.js";
import SOS from "../models/SOS.js";

const router = express.Router();

// Create SOS message (patient/doctor)
router.post("/", auth, async (req, res) => {
  try {
    const role = req.auth?.role || "patient";
    const patientId = role === "patient" ? (req.user?._id || req.user?.id) : undefined;

    const { profileId, name, age, location, mobile } = req.body || {};

    const sos = await SOS.create({
      patientId,
      profileId: profileId?.toString?.() ?? profileId ?? "",
      name: name ?? "",
      age: age?.toString?.() ?? age ?? "",
      mobile: (mobile ?? (role === 'patient' ? (req.user?.mobile || '') : ''))?.toString?.() ?? '',
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
    const unreadOnly = String(req.query.unread || "false").toLowerCase() === 'true';
    const filter = unreadOnly ? { isRead: { $ne: true } } : {};
    const items = await SOS.find(filter).sort({ createdAt: 1 }).skip(skip).limit(limit).lean();
    return res.json({ success: true, data: items });
  } catch (e) {
    console.error("SOS list error:", e);
    return res.status(500).json({ success: false, message: "Failed to fetch SOS" });
  }
});

// Mark a batch of SOS messages as read
router.post("/mark-read", optionalAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ success: false, message: "ids array is required" });
    await SOS.updateMany({ _id: { $in: ids } }, { $set: { isRead: true } });
    return res.json({ success: true });
  } catch (e) {
    console.error("SOS mark-read error:", e);
    return res.status(500).json({ success: false, message: "Failed to mark as read" });
  }
});

export default router;

// Delete/clear an SOS item (temporary open access; secure later)
router.delete("/:id", optionalAuth, async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, message: "Missing id" });
    const result = await SOS.findByIdAndDelete(id);
    if (!result) return res.status(404).json({ success: false, message: "Not found" });
    return res.json({ success: true });
  } catch (e) {
    console.error("SOS delete error:", e);
    return res.status(500).json({ success: false, message: "Failed to delete" });
  }
});


