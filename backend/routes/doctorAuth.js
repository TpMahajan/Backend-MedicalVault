import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import { v2 as cloudinary } from "cloudinary";
import path from "path";
import { DoctorUser } from "../models/DoctorUser.js";
import { auth } from "../middleware/auth.js";

// ---------------- Cloudinary Config ----------------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ---------------- Storage ----------------
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const baseName = path.parse(file.originalname).name.replace(/\s+/g, "_");
    return {
      folder: "medical-vault/doctor-avatars",
      public_id: `doctor-${req.doctor._id}-${Date.now()}-${baseName}`,
      resource_type: "image",
      transformation: [
        { width: 300, height: 300, crop: "fill", gravity: "face" },
        { quality: "auto", fetch_format: "auto" }
      ],
    };
  },
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
        const publicId = req.doctor.avatar.split('/').pop().split('.')[0];
        await cloudinary.uploader.destroy(`medical-vault/doctor-avatars/${publicId}`);
      } catch (deleteError) {
        console.warn("Could not delete old avatar:", deleteError.message);
      }
    }

    // Update doctor with new avatar URL
    const updatedDoctor = await DoctorUser.findByIdAndUpdate(
      req.doctor._id,
      { avatar: req.file.path },
      { new: true, runValidators: true }
    ).select("-password");

    res.json({
      success: true,
      message: "Avatar uploaded successfully.",
      doctor: updatedDoctor,
      avatarUrl: req.file.path,
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
