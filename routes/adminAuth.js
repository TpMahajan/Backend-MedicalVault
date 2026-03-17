import express from "express";
import jwt from "jsonwebtoken";
import { AdminUser } from "../models/AdminUser.js";
import { MassIncident } from "../models/MassIncident.js";
import { requireAdminAuth } from "../middleware/adminAuth.js";

const router = express.Router();

// POST /api/admin/signup
router.post("/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: "Name, email and password are required" });
    }
    const existing = await AdminUser.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(400).json({ success: false, message: "Admin already exists" });
    }
    const admin = new AdminUser({ name, email: email.toLowerCase(), password });
    await admin.save();
    const token = jwt.sign({ adminId: admin._id, role: "admin" }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "7d" });
    res.status(201).json({ success: true, message: "Admin registered successfully", admin: { id: admin._id, name: admin.name, email: admin.email }, token });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/admin/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required" });
    }
    const admin = await AdminUser.findOne({ email: email.toLowerCase() });
    if (!admin) return res.status(400).json({ success: false, message: "Invalid credentials" });
    const valid = await admin.comparePassword(password);
    if (!valid) return res.status(400).json({ success: false, message: "Invalid credentials" });
    admin.lastLogin = new Date();
    await admin.save();
    const token = jwt.sign({ adminId: admin._id, role: "admin" }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "7d" });
    res.json({ success: true, message: "Login successful", admin: { id: admin._id, name: admin.name, email: admin.email }, token });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/mass-incidents", requireAdminAuth, async (req, res) => {
  try {
    const status = (req.query.status || "active").toString();
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
