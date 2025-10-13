import express from "express";
import jwt from "jsonwebtoken";
import { User } from "../models/User.js";
import { auth } from "../middleware/auth.js";
import { getMe, updateMe } from "../controllers/authController.js";
import { DoctorUser } from "../models/DoctorUser.js";  // doctor model
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import { OAuth2Client } from 'google-auth-library';
import crypto from "crypto";

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
      loginType: "email",
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
      // Accept both Android and Web client IDs
      const allowedAudiences = [
        process.env.GOOGLE_CLIENT_ID,
        "17869523090-bkk7sg3pei58pgq9h8mh5he85i6khg8r.apps.googleusercontent.com", // Android client
        "17869523090-4eritfoe3a8it2nkef2a0lllofs8862n.apps.googleusercontent.com"  // Web client
      ].filter(Boolean); // Remove any undefined values

      const ticket = await googleClient.verifyIdToken({
        idToken: token,
        audience: allowedAudiences,
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
      // Generate a random password for new Google users (16-byte hex string)
      const randomPassword = crypto.randomBytes(16).toString('hex');
      
      // Create new user with Google auth
      user = new User({
        name,
        email: email.toLowerCase(),
        profilePicture: picture,
        googleId,
        password: randomPassword, // Will be hashed by pre-save hook
        loginType: "google",
        mobile: "", // Set empty mobile for Google users
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
      // Update loginType to google if not already set
      if (user.loginType !== "google") {
        user.loginType = "google";
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
// Create email transporter with improved configuration
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT || 587),
  secure: false, // true for 465, false for other ports
  auth: process.env.SMTP_USER && process.env.SMTP_PASS ? {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  } : undefined,
  tls: {
    rejectUnauthorized: false // Allow self-signed certificates in dev
  }
});

// Verify transporter configuration on startup
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter.verify(function(error, success) {
    if (error) {
      console.error("❌ SMTP Configuration Error:", error);
      console.error("Please check your SMTP credentials in db.env");
    } else {
      console.log("✅ SMTP Server is ready to send emails");
    }
  });
} else {
  console.warn("⚠️  SMTP credentials not configured. Password reset emails will not be sent.");
  console.warn("Please add SMTP_USER and SMTP_PASS to your db.env file.");
}

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

    const expiresInMinutes = Number(process.env.RESET_TOKEN_EXPIRES_MIN || 30);
    const resetToken = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET,
      { expiresIn: `${expiresInMinutes}m` }
    );

    const expiryDate = new Date(Date.now() + expiresInMinutes * 60 * 1000);
    user.resetToken = resetToken;
    user.resetTokenExpiry = expiryDate;
    await user.save();

    const appBaseUrl = process.env.APP_BASE_URL || "https://backend-medicalvault.onrender.com";
    const resetLink = `${appBaseUrl}/reset-password?token=${encodeURIComponent(resetToken)}`;

    // Send email
    let emailSent = false;
    try {
      if (transporter.options.auth) {
        await transporter.sendMail({
          from: process.env.MAIL_FROM || process.env.SMTP_USER || "no-reply@medicalvault.app",
          to: user.email,
          subject: "🔐 Reset Your HealthVault Password",
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #4A90E2;">Password Reset Request</h2>
              <p>Hello ${user.name},</p>
              <p>You requested a password reset for your HealthVault account.</p>
              <p>Click the button below to set a new password (valid for ${expiresInMinutes} minutes):</p>
              <div style="text-align: center; margin: 30px 0;">
                <a href="${resetLink}" 
                   style="background-color: #4A90E2; color: white; padding: 12px 30px; 
                          text-decoration: none; border-radius: 5px; display: inline-block;">
                  Reset Password
                </a>
              </div>
              <p style="color: #666; font-size: 14px;">
                Or copy and paste this link into your browser:<br>
                <a href="${resetLink}" style="color: #4A90E2;">${resetLink}</a>
              </p>
              <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
              <p style="color: #999; font-size: 12px;">
                If you didn't request this password reset, you can safely ignore this email. 
                Your password will remain unchanged.
              </p>
            </div>
          `
        });
        emailSent = true;
        console.log(`✅ Password reset email sent to: ${user.email}`);
      } else {
        console.error("❌ SMTP not configured - cannot send password reset email");
      }
    } catch (mailErr) {
      console.error("❌ Email send failed:", mailErr.message);
      console.error("Full error:", mailErr);
      // Return error to user if email fails
      return res.status(500).json({ 
        success: false, 
        message: "Failed to send password reset email. Please contact support or try again later." 
      });
    }

    if (!emailSent) {
      return res.status(500).json({ 
        success: false, 
        message: "Email service not configured. Please contact support." 
      });
    }

    res.json({ 
      success: true, 
      message: "Password reset link has been sent to your email. Please check your inbox." 
    });
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

// ================= Set Password for Google Users =================
router.post("/user/set-password", auth, async (req, res) => {
  try {
    const { password } = req.body;
    
    if (!password) {
      return res.status(400).json({ 
        success: false, 
        message: "Password is required" 
      });
    }

    if (password.length < 6) {
      return res.status(400).json({ 
        success: false, 
        message: "Password must be at least 6 characters long" 
      });
    }

    // Get user ID from auth middleware
    const userId = req.user?._id || req.auth?.id;
    if (!userId) {
      return res.status(401).json({ 
        success: false, 
        message: "Unauthorized" 
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: "User not found" 
      });
    }

    console.log("Setting password for user:", { 
      userId: user._id, 
      email: user.email,
      loginType: user.loginType,
      passwordLength: password.length 
    });

    // Set the new password - the pre-save hook will hash it automatically
    user.password = password;
    await user.save();

    console.log("Password set successfully:", { 
      userId: user._id, 
      passwordHashed: true 
    });

    res.json({ 
      success: true, 
      message: "Password updated successfully" 
    });

  } catch (error) {
    console.error("Set password error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to update password. Please try again." 
    });
  }
});
