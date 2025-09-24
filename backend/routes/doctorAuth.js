import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { DoctorUser } from "../models/DoctorUser.js";
import { auth } from "../middleware/auth.js";

// ---------------- Local Storage Setup ----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, "../uploads/doctor-avatars");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ---------------- Storage ----------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const baseName = path.parse(file.originalname).name.replace(/\s+/g, "_");
    const ext = path.extname(file.originalname);
    const fileName = `doctor-${req.doctor?._id || 'unknown'}-${Date.now()}-${baseName}${ext}`;
    cb(null, fileName);
  }
});

const upload = multer({ 
  storage, 
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

const router = express.Router();

// ================= Signup =================
router.post("/signup", async (req, res) => {
  try {
    const { name, email, mobile, password } = req.body;

    if (!name || !email || !mobile || !password) {
      return res.status(400).json({
        success: false,
        message: "Name, email, mobile number, and password are required.",
      });
    }

    const existingDoctor = await DoctorUser.findOne({ email: email.toLowerCase() });
    if (existingDoctor) {
      return res.status(400).json({
        success: false,
        message: "Doctor with this email already exists.",
      });
    }

    const doctor = new DoctorUser({
      name,
      email: email.toLowerCase(),
      mobile,
      password,
    });

    await doctor.save();

    const token = jwt.sign(
      { userId: doctor._id, role: "doctor" },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.status(201).json({
      success: true,
      message: "Doctor registered successfully.",
      doctor: {
        id: doctor._id,
        name: doctor.name,
        email: doctor.email,
        mobile: doctor.mobile,
        avatar: doctor.avatar,
        specialty: doctor.specialty,
      },
      token,
    });
  } catch (error) {
    console.error("Signup error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error during registration.",
    });
  }
});

// ================= Login =================
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required.",
      });
    }

    const doctor = await DoctorUser.findOne({ email: email.toLowerCase() });
    if (!doctor) {
      return res.status(401).json({ success: false, message: "Invalid email or password." });
    }

    const isPasswordValid = await doctor.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, message: "Invalid email or password." });
    }

    const token = jwt.sign(
      { userId: doctor._id, role: "doctor" },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      message: "Login successful.",
      token,
      doctor: {
        id: doctor._id,
        name: doctor.name,
        email: doctor.email,
        mobile: doctor.mobile,
        avatar: doctor.avatar,
        specialty: doctor.specialty,
        createdAt: doctor.createdAt,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error during login.",
    });
  }
});

// ================= Get Doctor Profile =================
router.get("/profile", auth, async (req, res) => {
  if (!req.doctor) {
    return res.status(404).json({ success: false, message: "Doctor not found." });
  }
  res.json({
    success: true,
    message: "Profile retrieved successfully.",
    doctor: req.doctor,
  });
});

// ================= Update Doctor Profile =================
router.put("/profile", auth, async (req, res) => {
  try {
    if (!req.doctor) {
      return res.status(404).json({ success: false, message: "Doctor not found." });
    }

    const updateData = req.body;
    const updatedDoctor = await DoctorUser.findByIdAndUpdate(req.doctor._id, updateData, {
      new: true,
      runValidators: true,
    }).select("-password");

    res.json({
      success: true,
      message: "Profile updated successfully.",
      doctor: updatedDoctor,
    });
  } catch (error) {
    console.error("Profile update error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error while updating profile.",
    });
  }
});

// ================= Update FCM Token =================
router.put("/fcm-token", auth, async (req, res) => {
  try {
    const { fcmToken } = req.body;

    if (!fcmToken) {
      return res.status(400).json({
        success: false,
        message: "FCM token is required."
      });
    }

    if (!req.doctor) {
      return res.status(404).json({ success: false, message: "Doctor not found." });
    }

    const updatedDoctor = await DoctorUser.findByIdAndUpdate(
      req.doctor._id,
      { fcmToken },
      { new: true, runValidators: true }
    ).select("-password");

    res.json({
      success: true,
      message: "FCM token updated successfully.",
      doctor: updatedDoctor,
    });
  } catch (error) {
    console.error("FCM token update error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error while updating FCM token.",
    });
  }
});

// ================= Upload Doctor Avatar =================
router.post("/profile/avatar", auth, upload.single("avatar"), async (req, res) => {
  try {
    if (!req.doctor) {
      return res.status(404).json({ success: false, message: "Doctor not found." });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: "No image file uploaded." });
    }

    // Delete old avatar if exists
    if (req.doctor.avatar) {
      try {
        const oldFilePath = path.join(__dirname, "../uploads/doctor-avatars", path.basename(req.doctor.avatar));
        if (fs.existsSync(oldFilePath)) {
          fs.unlinkSync(oldFilePath);
        }
      } catch (deleteError) {
        console.warn("Could not delete old avatar:", deleteError.message);
      }
    }

    // Create the public URL for the avatar
    const baseUrl = process.env.BASE_URL || 'https://backend-medicalvault.onrender.com';
    const avatarUrl = `${baseUrl}/uploads/doctor-avatars/${req.file.filename}`;

    // Update doctor with new avatar URL
    const updatedDoctor = await DoctorUser.findByIdAndUpdate(
      req.doctor._id,
      { avatar: avatarUrl },
      { new: true, runValidators: true }
    ).select("-password");

    res.json({
      success: true,
      message: "Avatar uploaded successfully.",
      doctor: updatedDoctor,
      avatarUrl: avatarUrl,
    });
  } catch (error) {
    console.error("Avatar upload error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error while uploading avatar.",
    });
  }
});

export default router;
