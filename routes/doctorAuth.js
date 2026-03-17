import express from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import multerS3 from "multer-s3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { DoctorUser } from "../models/DoctorUser.js";
import { auth } from "../middleware/auth.js";
import s3Client, { BUCKET_NAME, REGION } from "../config/s3.js";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { generateSignedUrl } from "../utils/s3Utils.js";

// Helper: build avatar URL (handles both S3 keys and local paths)
const buildSignedAvatarUrl = async (avatarValue) => {
  try {
    if (!avatarValue) return null;

    // If it's already a full URL, return it
    const looksLikeUrl = /^https?:\/\//i.test(avatarValue);
    if (looksLikeUrl) return avatarValue;

    // If it starts with /uploads, it's a local path
    if (avatarValue.startsWith('/uploads/')) {
      const baseUrl = process.env.API_BASE_URL || 'http://localhost:5000';
      return `${baseUrl}${avatarValue}`;
    }

    // Otherwise it's an S3 key - only try to sign if we have credentials
    if (hasAWSCredentials) {
      const signed = await generateSignedUrl(avatarValue, BUCKET_NAME);
      return signed;
    }

    return null;
  } catch (e) {
    console.warn('Error building avatar URL:', e.message);
    return null;
  }
};

// ---------------- Storage (S3 or Local Fallback) ----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Check if AWS credentials are configured
const hasAWSCredentials = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY;

// Configure storage based on AWS credentials availability
const storage = hasAWSCredentials
  ? multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: (req, file, cb) => {
      const baseName = path.parse(file.originalname).name.replace(/\s+/g, "_");
      const ext = path.extname(file.originalname).toLowerCase();
      const doctorId = req.doctor?._id?.toString() || "unknown";
      const fileName = `doctor-avatars/${doctorId}/${Date.now()}-${baseName}${ext}`;
      cb(null, fileName);
    },
    metadata: (req, file, cb) => {
      cb(null, { fieldName: file.fieldname, uploadedBy: req.doctor?._id?.toString() || "unknown" });
    }
  })
  : multer.diskStorage({
    destination: (req, file, cb) => {
      const doctorId = req.doctor?._id?.toString() || "unknown";
      const uploadDir = path.join(__dirname, "../uploads/doctor-avatars", doctorId);
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const baseName = path.parse(file.originalname).name.replace(/\s+/g, "_");
      const ext = path.extname(file.originalname).toLowerCase();
      const fileName = `${Date.now()}-${baseName}${ext}`;
      cb(null, fileName);
    }
  });

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype?.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"), false);
  }
});

console.log(`📸 Avatar upload configured: ${hasAWSCredentials ? 'AWS S3' : 'Local Storage'}`);

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
        avatar: null,
        avatarUrl: null,
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

    // Build signed avatar URL for convenience
    const avatarUrl = await buildSignedAvatarUrl(doctor.avatar);

    res.json({
      success: true,
      message: "Login successful.",
      token,
      doctor: {
        id: doctor._id,
        name: doctor.name,
        email: doctor.email,
        mobile: doctor.mobile,
        // Prefer a display-ready URL; also include avatarUrl explicitly
        avatar: avatarUrl,
        avatarUrl: avatarUrl,
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
  try {
    if (!req.doctor) {
      return res.status(404).json({ success: false, message: "Doctor not found." });
    }

    const avatarUrl = await buildSignedAvatarUrl(req.doctor.avatar);
    const doctorData = req.doctor.toObject();

    // Calculate actual statistics
    try {
      // Import User model to count patients
      const User = require('../models/User');
      const Appointment = require('../models/Appointment');

      // Count total patients associated with this doctor
      const totalPatients = await User.countDocuments({ doctorId: req.doctor._id });

      // Count total appointments/sessions
      const totalSessions = await Appointment.countDocuments({ doctorId: req.doctor._id });

      // Calculate years of experience
      let yearsOfExperience = 0;
      if (doctorData.experience) {
        // Try to extract number from experience field (e.g., "5 years" -> 5)
        const match = doctorData.experience.match(/(\d+)/);
        if (match) {
          yearsOfExperience = parseInt(match[1]);
        }
      }

      // Add calculated stats to doctor data
      doctorData.totalPatients = totalPatients;
      doctorData.totalSessions = totalSessions;
      doctorData.yearsOfExperience = yearsOfExperience;

    } catch (statsError) {
      console.error('Error calculating statistics:', statsError);
      // If stats calculation fails, use defaults
      doctorData.totalPatients = doctorData.totalPatients || 0;
      doctorData.totalSessions = doctorData.totalSessions || 0;
      doctorData.yearsOfExperience = doctorData.yearsOfExperience || 0;
    }

    // Ensure preferences object exists with defaults
    if (!doctorData.preferences) {
      doctorData.preferences = {
        language: 'en',
        timezone: 'America/New_York',
        theme: 'auto',
        notifications: {
          newPatients: true,
          appointmentReminders: true,
          labResults: false,
          medicationUpdates: true,
          emergencyAlerts: true,
        },
        privacy: {
          dataSharing: false,
          analytics: true,
          marketing: false,
          thirdParty: false,
        },
        appearance: {
          compactMode: false,
          showAvatars: true,
          animations: true,
        },
      };
    }

    res.json({
      success: true,
      message: "Profile retrieved successfully.",
      doctor: { ...doctorData, avatarUrl },
    });
  } catch (error) {
    console.error("Profile fetch error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error while fetching profile.",
    });
  }
});

// ================= Update Doctor Profile =================
router.put("/profile", auth, async (req, res) => {
  try {
    if (!req.doctor) {
      return res.status(404).json({ success: false, message: "Doctor not found." });
    }

    const updateData = { ...req.body };

    // Remove preferences from main updateData and handle separately
    const { preferences, ...profileData } = updateData;

    const updateQuery = { ...profileData };

    // Handle preferences using dot notation for MongoDB
    if (preferences) {
      // Update top-level preference fields
      if (preferences.language !== undefined) {
        updateQuery['preferences.language'] = preferences.language;
      }
      if (preferences.timezone !== undefined) {
        updateQuery['preferences.timezone'] = preferences.timezone;
      }
      if (preferences.theme !== undefined) {
        updateQuery['preferences.theme'] = preferences.theme;
      }

      // Handle nested notifications object
      if (preferences.notifications) {
        Object.keys(preferences.notifications).forEach(key => {
          updateQuery[`preferences.notifications.${key}`] = preferences.notifications[key];
        });
      }

      // Handle nested privacy object
      if (preferences.privacy) {
        Object.keys(preferences.privacy).forEach(key => {
          updateQuery[`preferences.privacy.${key}`] = preferences.privacy[key];
        });
      }

      // Handle nested appearance object
      if (preferences.appearance) {
        Object.keys(preferences.appearance).forEach(key => {
          updateQuery[`preferences.appearance.${key}`] = preferences.appearance[key];
        });
      }
    }

    const updatedDoctor = await DoctorUser.findByIdAndUpdate(req.doctor._id, { $set: updateQuery }, {
      new: true,
      runValidators: true,
    }).select("-password");

    const avatarUrl = await buildSignedAvatarUrl(updatedDoctor.avatar);

    res.json({
      success: true,
      message: "Profile updated successfully.",
      doctor: { ...updatedDoctor.toObject(), avatarUrl },
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

// ================= Get Security Settings =================
router.get("/security-settings", auth, async (req, res) => {
  try {
    if (!req.doctor) {
      return res.status(404).json({ success: false, message: "Doctor not found." });
    }

    // Calculate password expiry info
    const passwordInfo = {
      lastChanged: req.doctor.passwordChangedAt,
      expiresIn: req.doctor.securitySettings.passwordExpiry,
      isExpired: req.doctor.isPasswordExpired(),
      daysUntilExpiry: (() => {
        const expiryDate = new Date(req.doctor.passwordChangedAt);
        expiryDate.setDate(expiryDate.getDate() + req.doctor.securitySettings.passwordExpiry);
        const daysLeft = Math.ceil((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
        return daysLeft > 0 ? daysLeft : 0;
      })(),
    };

    res.json({
      success: true,
      securitySettings: req.doctor.securitySettings,
      passwordInfo: passwordInfo,
    });
  } catch (error) {
    console.error("Get security settings error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error while fetching security settings.",
    });
  }
});

// ================= Update Security Settings =================
router.put("/security-settings", auth, async (req, res) => {
  try {
    if (!req.doctor) {
      return res.status(404).json({ success: false, message: "Doctor not found." });
    }

    const { twoFactorAuth, sessionTimeout, passwordExpiry, loginNotifications } = req.body;

    // Validate input
    const updateData = {};
    if (typeof twoFactorAuth === 'boolean') {
      updateData['securitySettings.twoFactorAuth'] = twoFactorAuth;
    }
    if (typeof sessionTimeout === 'number' && sessionTimeout >= 5 && sessionTimeout <= 480) {
      updateData['securitySettings.sessionTimeout'] = sessionTimeout;
    }
    if (typeof passwordExpiry === 'number' && passwordExpiry >= 30 && passwordExpiry <= 365) {
      updateData['securitySettings.passwordExpiry'] = passwordExpiry;
    }
    if (typeof loginNotifications === 'boolean') {
      updateData['securitySettings.loginNotifications'] = loginNotifications;
    }

    const updatedDoctor = await DoctorUser.findByIdAndUpdate(
      req.doctor._id,
      { $set: updateData },
      { new: true, runValidators: true }
    ).select("-password");

    // Calculate password expiry info
    const passwordInfo = {
      lastChanged: updatedDoctor.passwordChangedAt,
      expiresIn: updatedDoctor.securitySettings.passwordExpiry,
      isExpired: updatedDoctor.isPasswordExpired(),
      daysUntilExpiry: (() => {
        const expiryDate = new Date(updatedDoctor.passwordChangedAt);
        expiryDate.setDate(expiryDate.getDate() + updatedDoctor.securitySettings.passwordExpiry);
        const daysLeft = Math.ceil((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
        return daysLeft > 0 ? daysLeft : 0;
      })(),
    };

    res.json({
      success: true,
      message: "Security settings updated successfully.",
      securitySettings: updatedDoctor.securitySettings,
      passwordInfo: passwordInfo,
    });
  } catch (error) {
    console.error("Update security settings error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error while updating security settings.",
    });
  }
});

// ================= Upload Doctor Avatar =================
// Multer error-safe wrapper so we always return JSON (not HTML) on errors
const avatarUploader = (req, res, next) => {
  upload.single("avatar")(req, res, (err) => {
    if (err) {
      const status = err.message?.includes("image") ? 400 : 500;
      return res.status(status).json({ success: false, message: err.message || "Upload failed" });
    }
    next();
  });
};

router.post("/profile/avatar", auth, avatarUploader, async (req, res) => {
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
        if (hasAWSCredentials) {
          // S3 deletion
          const url = req.doctor.avatar;
          const s3Host = `.s3.${REGION}.amazonaws.com/`;
          if (url.includes(s3Host)) {
            const key = url.split(s3Host)[1];
            if (key) {
              await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
            }
          } else if (!url.startsWith("http")) {
            // It's an S3 key
            await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: url }));
          }
        } else {
          // Local file deletion
          const url = req.doctor.avatar;
          if (url.includes("/uploads/doctor-avatars/")) {
            const relativePath = url.replace(/^.*\/uploads\//, "");
            const oldFilePath = path.join(__dirname, "../uploads", relativePath);
            if (fs.existsSync(oldFilePath)) {
              fs.unlinkSync(oldFilePath);
            }
          }
        }
      } catch (deleteError) {
        console.warn("Could not delete old avatar:", deleteError.message);
      }
    }

    let avatarKey, avatarUrl;

    if (hasAWSCredentials) {
      // S3 storage - store the S3 key in DB
      avatarKey = req.file.key;
      // Generate signed URL for immediate use
      avatarUrl = await buildSignedAvatarUrl(avatarKey);
      if (!avatarUrl) avatarUrl = `https://${BUCKET_NAME}.s3.${REGION}.amazonaws.com/${avatarKey}`;
    } else {
      // Local storage - store relative path in DB
      const doctorId = req.doctor._id.toString();
      avatarKey = `/uploads/doctor-avatars/${doctorId}/${req.file.filename}`;
      avatarUrl = `${process.env.API_BASE_URL || 'http://localhost:5000'}${avatarKey}`;
    }

    // Update doctor with new avatar
    const updatedDoctor = await DoctorUser.findByIdAndUpdate(
      req.doctor._id,
      { avatar: avatarKey },
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

// ================= Delete Doctor Avatar =================
router.delete("/profile/avatar", auth, async (req, res) => {
  try {
    if (!req.doctor) {
      return res.status(404).json({ success: false, message: "Doctor not found." });
    }

    if (!req.doctor.avatar) {
      return res.status(400).json({ success: false, message: "No avatar to delete." });
    }

    // Delete photo from storage
    try {
      if (hasAWSCredentials) {
        // S3 deletion
        const avatarKey = req.doctor.avatar;
        await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: avatarKey }));
      } else {
        // Local file deletion
        const url = req.doctor.avatar;
        if (url.includes("/uploads/doctor-avatars/")) {
          const relativePath = url.replace(/^.*\/uploads\//, "");
          const oldFilePath = path.join(__dirname, "../uploads", relativePath);
          if (fs.existsSync(oldFilePath)) {
            fs.unlinkSync(oldFilePath);
          }
        }
      }
    } catch (deleteError) {
      console.warn("Could not delete avatar file:", deleteError.message);
    }

    // Update doctor record
    const updatedDoctor = await DoctorUser.findByIdAndUpdate(
      req.doctor._id,
      { avatar: null },
      { new: true }
    ).select("-password");

    res.json({
      success: true,
      message: "Avatar removed successfully.",
      doctor: updatedDoctor
    });
  } catch (error) {
    console.error("Avatar deletion error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error while deleting avatar.",
    });
  }
});

// ================= Get All Patients for Doctor =================
// GET /api/doctors/patients
router.get("/patients", auth, async (req, res) => {
  try {
    if (req.auth?.role !== "doctor") {
      return res.status(403).json({
        success: false,
        message: "Only doctors can access this endpoint.",
      });
    }

    // Use doctorId directly from authenticated JWT token context.
    const doctorId = req.auth?.id?.toString();
    if (!doctorId) {
      return res.status(401).json({
        success: false,
        message: "Doctor authentication failed.",
      });
    }

    console.log("👨‍⚕️ Fetching unique patients for doctor:", doctorId);

    const { Session } = await import("../models/Session.js");
    const { Appointment } = await import("../models/Appointment.js");
    const { User } = await import("../models/User.js");

    // Collect related patients from sessions, appointments, and persistent doctor links.
    const [sessionPatientIds, appointmentPatientIds, doctorProfile] = await Promise.all([
      Session.distinct("patientId", { doctorId }),
      Appointment.distinct("patientId", { doctorId }),
      DoctorUser.findById(doctorId).select("linkedPatients").lean(),
    ]);

    const linkedPatientIds = (doctorProfile?.linkedPatients || []).map((id) => id?.toString());

    let patientIds = Array.from(
      new Set([
        ...linkedPatientIds,
        ...sessionPatientIds.map((id) => id?.toString()),
        ...appointmentPatientIds.map((id) => id?.toString()),
      ].filter(Boolean))
    );

    patientIds = patientIds.filter((id) => /^[a-fA-F0-9]{24}$/.test(id));

    if (patientIds.length === 0) {
      return res.json({
        success: true,
        count: 0,
        patients: [],
      });
    }

    // Gather complete session context (latest session + total sessions) without filtering.
    const allDoctorSessions = await Session.find({
      doctorId,
      patientId: { $in: patientIds },
    })
      .select("_id patientId status expiresAt createdAt")
      .sort({ createdAt: -1 })
      .lean();

    const sessionStatsByPatient = new Map();
    for (const session of allDoctorSessions) {
      const patientKey = session.patientId?.toString();
      if (!patientKey) continue;

      if (!sessionStatsByPatient.has(patientKey)) {
        sessionStatsByPatient.set(patientKey, {
          totalSessions: 1,
          sessionId: session._id,
          sessionStatus: session.status || null,
          sessionExpiresAt: session.expiresAt || null,
          sessionCreatedAt: session.createdAt || null,
        });
      } else {
        const existing = sessionStatsByPatient.get(patientKey);
        existing.totalSessions += 1;
      }
    }

    // Requirement: fetch users by _id in patientIds with no pagination/limit.
    const users = await User.find({ _id: { $in: patientIds } })
      .select("-password -resetToken -resetTokenExpiry")
      .sort({ createdAt: -1 })
      .lean();

    const patients = users
      .map((patient) => {
        const patientId = patient._id.toString();
        const sessionStats = sessionStatsByPatient.get(patientId);

        return {
          ...patient,
          id: patientId,
          phone: patient.mobile || "N/A",
          age: patient.age ?? "N/A",
          gender: patient.gender || "N/A",
          bloodType: patient.bloodType || "N/A",
          lastVisit: patient.lastVisit || "N/A",
          documents: Array.isArray(patient.medicalRecords) ? patient.medicalRecords.length : 0,
          status: patient.isActive === false ? "Inactive" : "Active",
          sessionId: sessionStats?.sessionId || null,
          sessionStatus: sessionStats?.sessionStatus || null,
          sessionExpiresAt: sessionStats?.sessionExpiresAt || null,
          sessionCreatedAt: sessionStats?.sessionCreatedAt || null,
          totalSessions: sessionStats?.totalSessions || 0,
        };
      })
      .sort((a, b) => {
        const aTime = a.sessionCreatedAt ? new Date(a.sessionCreatedAt).getTime() : 0;
        const bTime = b.sessionCreatedAt ? new Date(b.sessionCreatedAt).getTime() : 0;
        return bTime - aTime;
      });

    res.json({
      success: true,
      count: patients.length,
      patients,
    });
  } catch (error) {
    console.error("❌ Fetch patients error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error while fetching patients.",
      error: error.message,
    });
  }
});

export default router;
