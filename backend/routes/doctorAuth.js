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

// Helper: build signed avatar URL if we have an S3 key
const buildSignedAvatarUrl = async (avatarValue) => {
  try {
    if (!avatarValue) return null;
    const looksLikeUrl = /^https?:\/\//i.test(avatarValue);
    if (looksLikeUrl) return avatarValue; // already a URL (legacy)
    // otherwise it is an S3 key
    const signed = await generateSignedUrl(avatarValue, BUCKET_NAME);
    return signed;
  } catch (e) {
    return null;
  }
};

// ---------------- Storage (S3) ----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const upload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    // Do NOT set ACLs; many buckets disable ACLs. Use signed URLs for access.
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
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype?.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"), false);
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
  if (!req.doctor) {
    return res.status(404).json({ success: false, message: "Doctor not found." });
  }
  const avatarUrl = await buildSignedAvatarUrl(req.doctor.avatar);
  const doctorData = req.doctor.toObject();
  
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

    // Delete old avatar if exists (supports prior local URLs and S3 URLs)
    if (req.doctor.avatar) {
      try {
        const url = req.doctor.avatar;
        const s3Host = `.s3.${REGION}.amazonaws.com/`;
        if (url.includes(s3Host)) {
          const key = url.split(s3Host)[1];
          if (key) {
            await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
          }
        } else if (url.includes("/uploads/doctor-avatars/")) {
          const oldFilePath = path.join(__dirname, "../uploads/doctor-avatars", path.basename(url));
          if (fs.existsSync(oldFilePath)) {
            fs.unlinkSync(oldFilePath);
          }
        }
      } catch (deleteError) {
        console.warn("Could not delete old avatar:", deleteError.message);
      }
    }

    // Store the S3 key in DB (not a public URL)
    const avatarKey = req.file.key;

    // Update doctor with new avatar URL
    const updatedDoctor = await DoctorUser.findByIdAndUpdate(
      req.doctor._id,
      { avatar: avatarKey },
      { new: true, runValidators: true }
    ).select("-password");

    // Return a signed URL for immediate use by the client
    let signedUrl = await buildSignedAvatarUrl(avatarKey);
    if (!signedUrl) signedUrl = `https://${BUCKET_NAME}.s3.${REGION}.amazonaws.com/${avatarKey}`;

    res.json({
      success: true,
      message: "Avatar uploaded successfully.",
      doctor: updatedDoctor,
      avatarUrl: signedUrl,
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
