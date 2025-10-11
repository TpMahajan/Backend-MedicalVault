import express from "express";
import jwt from "jsonwebtoken";
import { User } from "../models/User.js";
import { auth } from "../middleware/auth.js";
import { getMe, updateMe } from "../controllers/authController.js";
import { DoctorUser } from "../models/DoctorUser.js";  // doctor model
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import { OAuth2Client } from 'google-auth-library';

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ================= Patient Signup =================
router.post("/signup", async (req, res) => {
  try {
    const { name, email, password, mobile } = req.body;

    if (!name || !email || !password || !mobile) {
      return res.status(400).json({ message: "Name, email, mobile, and password are required" });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    const newUser = new User({
      name,
      email: email.toLowerCase(),
      password,
      mobile,
    });

    await newUser.save();

    const token = jwt.sign(
      { userId: newUser._id, role: "patient" },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    res.status(201).json({
      success: true,
      message: "User registered successfully",
      user: {
        id: newUser._id.toString(),
        name: newUser.name,
        email: newUser.email,
        mobile: newUser.mobile,
      },
      token,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ================= Google OAuth =================
router.post("/google", async (req, res) => {
  try {
    const { idToken, id_token } = req.body;
    const token = idToken || id_token;

    if (!token) {
      return res.status(400).json({ 
        success: false, 
        message: "Google ID token is required" 
      });
    }

    // Verify Google ID token
    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: token,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch (error) {
      console.error("Google token verification failed:", error);
      return res.status(401).json({ 
        success: false, 
        message: "Invalid Google token" 
      });
    }

    const { email, name, picture, sub: googleId } = payload;

    // Check if user exists
    let user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      // Create new user with Google auth
      user = new User({
        name,
        email: email.toLowerCase(),
        profilePicture: picture,
        googleId,
        // No password needed for Google auth users
      });
      await user.save();
      console.log("✅ New user created via Google:", email);
    } else {
      // Update existing user's Google info if not set
      if (!user.googleId) {
        user.googleId = googleId;
      }
      if (!user.profilePicture && picture) {
        user.profilePicture = picture;
      }
      user.lastLogin = new Date();
      await user.save();
      console.log("✅ Existing user logged in via Google:", email);
    }

    // Generate JWT
    const jwtToken = jwt.sign(
      { userId: user._id, role: "patient" },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    res.status(200).json({
      success: true,
      message: user.googleId === googleId ? "Login successful" : "Account created successfully",
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        mobile: user.mobile || "",
        profilePicture: user.profilePicture,
      },
      token: jwtToken,
    });

  } catch (error) {
    console.error("Google auth error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Google authentication failed" 
    });
  }
});

// ================= Patient Login =================
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    console.log("Login attempt:", { userId: user._id, email: user.email, hasStoredPassword: !!user.password });
    
    const isValid = await user.comparePassword(password);
    console.log("Password validation result:", { userId: user._id, isValid });
    
    if (!isValid) return res.status(400).json({ message: "Invalid credentials" });

    const token = jwt.sign(
      { userId: user._id, role: "patient" },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    user.lastLogin = new Date();
    await user.save();

    res.status(200).json({
      success: true,
      message: "Login successful",
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        mobile: user.mobile,
        profilePicture: user.profilePicture,
      },
      token,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ================= Doctor Signup =================
router.post("/doctor/signup", async (req, res) => {
  try {
    const { name, email, password, specialization } = req.body;

    if (!name || !email || !password || !specialization) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const existingDoctor = await DoctorUser.findOne({ email: email.toLowerCase() });
    if (existingDoctor) {
      return res.status(400).json({ message: "Doctor already exists" });
    }

    const newDoctor = new DoctorUser({
      name,
      email: email.toLowerCase(),
      password,
      specialization,
    });

    await newDoctor.save();

    const token = jwt.sign(
      { doctorId: newDoctor._id, role: "doctor" },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    res.status(201).json({
      success: true,
      message: "Doctor registered successfully",
      doctor: {
        id: newDoctor._id.toString(),
        name: newDoctor.name,
        email: newDoctor.email,
        specialization: newDoctor.specialization,
      },
      token,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ================= Doctor Login =================
router.post("/doctor/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const doctor = await DoctorUser.findOne({ email: email.toLowerCase() });
    if (!doctor) return res.status(400).json({ message: "Invalid credentials" });

    const isValid = await doctor.comparePassword(password);
    if (!isValid) return res.status(400).json({ message: "Invalid credentials" });

    const token = jwt.sign(
      { doctorId: doctor._id, role: "doctor" },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    doctor.lastLogin = new Date();
    await doctor.save();

    res.status(200).json({
      success: true,
      message: "Login successful",
      doctor: {
        id: doctor._id.toString(),
        name: doctor.name,
        email: doctor.email,
        specialization: doctor.specialization,
      },
      token,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ================= Current User/Doctor =================
router.get("/me", auth, getMe);
router.put("/me", auth, updateMe);

// ================= Debug Login Endpoint =================
router.post("/debug-login", async (req, res) => {
  try {
    const { email, password, userType } = req.body;
    
    console.log('🔍 Debug login attempt:', {
      email: email,
      userType: userType,
      hasPassword: !!password
    });

    let user, token, role;
    
    if (userType === 'doctor') {
      user = await DoctorUser.findOne({ email: email.toLowerCase() });
      role = 'doctor';
      console.log('👨‍⚕️ Looking for doctor:', user ? 'Found' : 'Not found');
    } else {
      user = await User.findOne({ email: email.toLowerCase() });
      role = 'patient';
      console.log('👤 Looking for patient:', user ? 'Found' : 'Not found');
    }

    if (!user) {
      return res.status(400).json({ 
        success: false,
        message: "User not found",
        debug: { email, userType, role }
      });
    }

    const isValid = await user.comparePassword(password);
    console.log('🔐 Password valid:', isValid);
    
    if (!isValid) {
      return res.status(400).json({ 
        success: false,
        message: "Invalid password",
        debug: { email, userType, role }
      });
    }

    token = jwt.sign(
      { userId: user._id, role: role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    console.log('✅ Login successful:', {
      userId: user._id,
      role: role,
      tokenGenerated: !!token
    });

    res.json({
      success: true,
      message: "Debug login successful",
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: role
      },
      token,
      debug: {
        userType: userType,
        role: role,
        tokenPayload: { userId: user._id, role: role }
      }
    });

  } catch (error) {
    console.error('Debug login error:', error);
    res.status(500).json({ 
      success: false,
      message: "Debug login failed",
      error: error.message 
    });
  }
});

// ================= Test Endpoint for QR Scanner =================
router.post("/test-patient", async (req, res) => {
  try {
    // Create a test patient for QR scanner testing
    const testPatient = new User({
      name: "Test Patient",
      email: "test.patient@example.com",
      password: "test123",
      mobile: "+1234567890",
      age: 30,
      gender: "Male",
      bloodType: "O+"
    });

    // Check if test patient already exists
    const existingPatient = await User.findOne({ email: "test.patient@example.com" });
    let patient;
    
    if (existingPatient) {
      patient = existingPatient;
    } else {
      await testPatient.save();
      patient = testPatient;
    }

    // Generate token
    const token = jwt.sign(
      { userId: patient._id, role: "patient" },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    res.json({
      success: true,
      message: "Test patient token generated",
      token,
      patient: {
        id: patient._id.toString(),
        name: patient.name,
        email: patient.email,
        mobile: patient.mobile
      }
    });
  } catch (error) {
    console.error("Test patient creation error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create test patient"
    });
  }
});

export default router;

// ================= Password Reset (Patient) =================
// Create email transporter (dummy SMTP; replace with real creds in env)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.ethereal.email",
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: process.env.SMTP_USER && process.env.SMTP_PASS ? {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  } : undefined,
});

// POST /auth/forgot-password
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email is required" });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      // Respond generically to avoid user enumeration
      return res.json({ success: true, message: "If your email exists, a reset link has been sent." });
    }

    const expiresInMinutes = Number(process.env.RESET_TOKEN_EXPIRES_MIN || 20);
    const resetToken = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET,
      { expiresIn: '30m' }
    );

    const expiryDate = new Date(Date.now() + expiresInMinutes * 60 * 1000);
    user.resetToken = resetToken;
    user.resetTokenExpiry = expiryDate;
    await user.save();

    const appBaseUrl = process.env.APP_BASE_URL || "https://example.com";
    const resetLink = `${appBaseUrl}/reset-password?token=${encodeURIComponent(resetToken)}`;

    // Send email (if transporter configured)
    try {
      if (transporter.options.auth) {
        await transporter.sendMail({
          from: process.env.MAIL_FROM || "no-reply@medicalvault.app",
          to: user.email,
          subject: "Reset your password",
          html: `<p>You requested a password reset.</p>
                 <p>Click the link below to set a new password (valid for ${expiresInMinutes} minutes):</p>
                 <p><a href="${resetLink}">Reset Password</a></p>
                 <p>If you didn't request this, you can safely ignore this email.</p>`
        });
      }
    } catch (mailErr) {
      console.warn("Email send failed (continuing):", mailErr.message);
    }

    res.json({ success: true, message: "If your email exists, a reset link has been sent." });
  } catch (error) {
    console.error("Forgot password error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// POST /auth/reset-password
router.post("/reset-password", async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) {
      return res.status(400).json({ success: false, message: "Token and new password are required" });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(400).json({ success: false, message: "Invalid or expired token" });
    }

    // Token is valid, proceed with reset

    const user = await User.findById(payload.userId);
    if (!user || user.resetToken !== token) {
      return res.status(400).json({ success: false, message: "Invalid token" });
    }

    if (!user.resetTokenExpiry || user.resetTokenExpiry.getTime() < Date.now()) {
      return res.status(400).json({ success: false, message: "Token expired" });
    }

    console.log("Password reset - before hash:", { userId: user._id, newPasswordLength: newPassword.length });
    
    // Set the new password - the pre-save hook will hash it automatically
    user.password = newPassword;
    user.resetToken = null;
    user.resetTokenExpiry = null;
    await user.save();
    
    console.log("Password reset - after save:", { userId: user._id, passwordHashed: true });

    res.json({ success: true, message: "Password has been reset successfully" });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// POST /auth/change-password (requires auth)
router.post("/change-password", auth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ success: false, message: "Old and new password are required" });
    }

    // patient by default
    const userId = req.user?._id || req.auth?.id;
    if (!userId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const matches = await user.comparePassword(oldPassword);
    if (!matches) return res.status(400).json({ success: false, message: "Old password is incorrect" });

    console.log("Password change - before hash:", { userId: user._id, newPasswordLength: newPassword.length });
    
    // Set the new password - the pre-save hook will hash it automatically
    user.password = newPassword;
    await user.save();
    
    console.log("Password change - after save:", { userId: user._id, passwordHashed: true });

    res.json({ success: true, message: "Password changed successfully" });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});
