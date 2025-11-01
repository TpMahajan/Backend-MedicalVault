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
import { EmailVerify } from "../models/EmailVerify.js";
import { sendVerificationEmail, sendPasswordResetEmail } from "../utils/emailService.js";

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
      emailVerified: false, // Email not verified yet
    });

    await newUser.save();

    // Generate verification materials
    const tokenId = crypto.randomBytes(16).toString("hex");
    const verificationToken = crypto.randomBytes(32).toString("hex");
    const code = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit code

    const salt = await bcrypt.genSalt(12);
    const tokenHash = await bcrypt.hash(verificationToken, salt);
    const codeHash = await bcrypt.hash(code, salt);

    // Create EmailVerify record
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
    const emailVerify = new EmailVerify({
      userId: newUser._id,
      tokenId,
      tokenHash,
      codeHash,
      expiresAt,
      lastSentAt: new Date(),
    });
    await emailVerify.save();

    // Send verification email
    try {
      await sendVerificationEmail(email.toLowerCase(), name, tokenId, verificationToken, code);
      console.log("✅ Verification email sent to:", email.toLowerCase());
    } catch (emailError) {
      console.error("❌ Failed to send verification email:", emailError);
      // Don't fail signup if email fails - user can resend
    }

    const jwtToken = jwt.sign(
      { userId: newUser._id, role: "patient" },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    res.status(201).json({
      success: true,
      message: "User registered successfully. Please check your email to verify your account.",
      user: {
        id: newUser._id.toString(),
        name: newUser.name,
        email: newUser.email,
        mobile: newUser.mobile,
        emailVerified: false,
      },
      token: jwtToken,
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
        emailVerified: true, // Google users are pre-verified
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
      // Ensure Google users have emailVerified=true
      if (!user.emailVerified) {
        user.emailVerified = true;
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

    // Infer loginType if not present in user document
    const loginType = user.loginType || (user.googleId ? 'google' : 'email');
    
    res.status(200).json({
      success: true,
      message: user.googleId === googleId ? "Login successful" : "Account created successfully",
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        mobile: user.mobile || "",
        profilePicture: user.profilePicture,
        loginType: loginType, // Always include loginType
        googleId: user.googleId, // Include googleId for frontend inference
        emailVerified: user.emailVerified || false,
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
        emailVerified: user.emailVerified || false,
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

// ================= Email Verification Routes =================
// POST /auth/verify - Verify email with token
router.post("/verify", async (req, res) => {
  try {
    const tokenStr = req.body.token || req.query.token;
    if (!tokenStr) {
      return res.status(400).json({ success: false, message: "Token is required" });
    }

    const [tokenId, token] = tokenStr.split(".");
    if (!tokenId || !token) {
      return res.status(400).json({ success: false, message: "Invalid token format" });
    }

    // Find EmailVerify record
    const emailVerify = await EmailVerify.findOne({ tokenId });
    if (!emailVerify) {
      return res.status(400).json({ success: false, message: "Invalid or expired verification token" });
    }

    // Check expiration
    if (new Date() > emailVerify.expiresAt) {
      await EmailVerify.deleteMany({ userId: emailVerify.userId });
      return res.status(400).json({ success: false, message: "Verification token has expired" });
    }

    // Verify token
    const isValid = await bcrypt.compare(token, emailVerify.tokenHash);
    if (!isValid) {
      return res.status(400).json({ success: false, message: "Invalid verification token" });
    }

    // Update user
    const user = await User.findById(emailVerify.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    user.emailVerified = true;
    await user.save();

    // Clean up verification records
    await EmailVerify.deleteMany({ userId: emailVerify.userId });

    console.log("✅ Email verified successfully:", { userId: user._id, email: user.email });

    res.json({
      success: true,
      message: "Email verified successfully",
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        emailVerified: true,
      },
    });
  } catch (error) {
    console.error("Verify error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// POST /auth/verify-code - Verify email with code
router.post("/verify-code", async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ success: false, message: "Email and code are required" });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Find valid EmailVerify for this user
    const emailVerify = await EmailVerify.findOne({
      userId: user._id,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });

    if (!emailVerify) {
      return res.status(400).json({ success: false, message: "No valid verification code found" });
    }

    // Check expiration
    if (new Date() > emailVerify.expiresAt) {
      await EmailVerify.deleteMany({ userId: user._id });
      return res.status(400).json({ success: false, message: "Verification code has expired" });
    }

    // Verify code
    const isValid = await bcrypt.compare(code, emailVerify.codeHash);
    if (!isValid) {
      return res.status(400).json({ success: false, message: "Invalid verification code" });
    }

    // Update user
    user.emailVerified = true;
    await user.save();

    // Clean up verification records
    await EmailVerify.deleteMany({ userId: user._id });

    console.log("✅ Email verified successfully via code:", { userId: user._id, email: user.email });

    res.json({
      success: true,
      message: "Email verified successfully",
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        emailVerified: true,
      },
    });
  } catch (error) {
    console.error("Verify code error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// POST /auth/resend-verification - Resend verification email
router.post("/resend-verification", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required" });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      // Return generic success to avoid user enumeration
      return res.json({ success: true, message: "If your email exists, a verification email has been sent." });
    }

    // Check if already verified
    if (user.emailVerified) {
      return res.status(400).json({ success: false, message: "Email is already verified" });
    }

    // Rate limiting: check lastSentAt
    const lastVerify = await EmailVerify.findOne({ userId: user._id }).sort({ lastSentAt: -1 });
    if (lastVerify) {
      const timeSinceLastSent = Date.now() - lastVerify.lastSentAt.getTime();
      const cooldownMs = 60 * 1000; // 60 seconds

      if (timeSinceLastSent < cooldownMs) {
        const remainingSeconds = Math.ceil((cooldownMs - timeSinceLastSent) / 1000);
        return res.status(429).json({
          success: false,
          message: `Please wait ${remainingSeconds} seconds before requesting another verification email`,
        });
      }
    }

    // Invalidate old tokens
    await EmailVerify.deleteMany({ userId: user._id });

    // Generate new verification materials
    const tokenId = crypto.randomBytes(16).toString("hex");
    const verificationToken = crypto.randomBytes(32).toString("hex");
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    const salt = await bcrypt.genSalt(12);
    const tokenHash = await bcrypt.hash(verificationToken, salt);
    const codeHash = await bcrypt.hash(code, salt);

    // Create new EmailVerify record
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    const emailVerify = new EmailVerify({
      userId: user._id,
      tokenId,
      tokenHash,
      codeHash,
      expiresAt,
      lastSentAt: new Date(),
    });
    await emailVerify.save();

    // Send verification email
    try {
      await sendVerificationEmail(user.email, user.name, tokenId, verificationToken, code);
      console.log("✅ Verification email resent to:", user.email);
    } catch (emailError) {
      console.error("❌ Failed to send verification email:", emailError);
      return res.status(500).json({ success: false, message: "Failed to send verification email" });
    }

    res.json({
      success: true,
      message: "Verification email has been sent",
    });
  } catch (error) {
    console.error("Resend verification error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
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
const smtpPort = Number(process.env.SMTP_PORT || 587);
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: smtpPort,
  secure: smtpPort === 465, // true for 465, false for other ports
  auth: process.env.SMTP_USER && process.env.SMTP_PASS ? {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  } : undefined,
  tls: {
    ciphers: "TLSv1.2",
    rejectUnauthorized: false // Allow self-signed certificates in dev
  },
  connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 10000),
  greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 10000),
  socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 20000)
});

// Verify transporter configuration on startup (optional)
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  if (process.env.SMTP_VERIFY_ON_STARTUP === "true") {
    transporter.verify(function(error, success) {
      if (error) {
        console.error("❌ SMTP Configuration Error:", error);
        console.error("Please check your SMTP credentials in db.env");
      } else {
        console.log("✅ SMTP Server is ready to send emails");
      }
    });
  } else {
    console.warn("ℹ️  Skipping SMTP verification on startup (set SMTP_VERIFY_ON_STARTUP=true to enable)");
  }
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

    // Allow password reset regardless of emailVerified status

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

    // Send email using Resend (preferred) or SMTP fallback
    let emailSent = false;
    try {
      if (process.env.RESEND_API_KEY) {
        await sendPasswordResetEmail(user.email, user.name, resetLink, expiresInMinutes);
        emailSent = true;
      } else if (transporter.options.auth) {
        await transporter.sendMail({
          from: process.env.MAIL_FROM_SMTP || process.env.MAIL_FROM || process.env.SMTP_USER || "no-reply@medicalvault.app",
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
        console.error("❌ No email provider configured for password reset");
      }
    } catch (mailErr) {
      console.error("❌ Email send failed:", mailErr.message);
      console.error("Full error:", mailErr);
      // Do not leak provider errors to client; return generic success to prevent enumeration
    }

    if (!emailSent) {
      // Soft-success: To avoid revealing email service status, respond generically
      return res.json({ success: true, message: "If your email exists, a reset link has been sent." });
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
