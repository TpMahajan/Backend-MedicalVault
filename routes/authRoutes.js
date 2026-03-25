import express from "express";
import jwt from "jsonwebtoken";
import { User } from "../models/User.js";
import rateLimit from "express-rate-limit";
import { auth } from "../middleware/auth.js";
import { authLimiter } from "../middleware/rateLimit.js";
import {
  doctorSignupValidation,
  forgotPasswordValidation,
  loginValidation,
  registerValidation,
  resetPasswordValidation,
} from "../middleware/validation.js";
import { getMe, updateMe } from "../controllers/authController.js";
import { DoctorUser } from "../models/DoctorUser.js";  // doctor model
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import { OAuth2Client } from 'google-auth-library';
import crypto from "crypto";
import { EmailVerify } from "../models/EmailVerify.js";
import { sendVerificationEmail, sendPasswordResetEmail } from "../utils/emailService.js";
import multer from "multer";
import multerS3 from "multer-s3";
import path from "path";
import s3Client, { BUCKET_NAME } from "../config/s3.js";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { buildUserResponse } from "../utils/userResponse.js";
import {
  clearAuthCookies,
  hashToken,
  issueAuthTokenSet,
  parseCookies,
  signLoginAttemptToken,
  setAuthCookies,
  verifyLoginAttemptToken,
  verifyRefreshToken,
} from "../services/tokenService.js";
import { RefreshToken } from "../models/RefreshToken.js";
import { LoginAttempt } from "../models/LoginAttempt.js";
import {
  isActorTemporarilyBlocked,
  monitorFailedLogin,
  monitorSuspiciousSession,
} from "../services/securityMonitorService.js";
import {
  emitLoginApprovedEvent,
  emitLoginAttemptEvent,
  emitLoginDeniedEvent,
  emitSessionInvalidatedEvent,
  hasActiveSessionSocket,
} from "../services/authSessionRealtime.js";

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
const safeLog = (...args) => {
  if (!isProduction) console.log(...args);
};

// Rate limiters for email-related endpoints (must be defined before routes)
const emailLimiter = rateLimit({
  windowMs: Number(process.env.EMAIL_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.EMAIL_LIMIT_MAX || 5),
  standardHeaders: true,
  legacyHeaders: false,
});

const codeLimiter = rateLimit({
  windowMs: Number(process.env.CODE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.CODE_LIMIT_MAX || 10),
  standardHeaders: true,
  legacyHeaders: false,
});

const ENABLE_DEBUG_ROUTES =
  String(process.env.ENABLE_DEBUG_ROUTES || "false").toLowerCase() === "true";

const SESSION_ACTIVE_WINDOW_MS = Number(
  process.env.AUTH_SESSION_ACTIVE_WINDOW_MS || 60_000
);
const LOGIN_ATTEMPT_TTL_MS = Number(
  process.env.AUTH_LOGIN_ATTEMPT_TTL_MS || 120_000
);

const asText = (value) => (value == null ? "" : String(value).trim());
const lower = (value) => asText(value).toLowerCase();
const patientRole = "patient";

const getRequestIp = (req) =>
  asText(
    req.headers["x-forwarded-for"]?.toString().split(",")[0] ||
      req.ip ||
      req.socket?.remoteAddress ||
      ""
  );

const getDeviceInfo = (req) =>
  asText(
    req.headers["x-device-info"] ||
      req.headers["sec-ch-ua-platform"] ||
      req.headers["user-agent"] ||
      "Unknown device"
  ).slice(0, 200);

const getDeviceId = (req) =>
  asText(
    req.headers["x-device-id"] ||
      req.headers["x-device-fingerprint"] ||
      `${getDeviceInfo(req)}|${getRequestIp(req)}`
  ).slice(0, 160);

const persistRefreshToken = async (
  req,
  principalId,
  role,
  refreshToken,
  refreshMeta,
  { deviceId = "", deviceInfo = "", lastActiveAt = new Date() } = {}
) => {
  const decoded = verifyRefreshToken(refreshToken);
  const expiresAt = new Date((decoded.exp || 0) * 1000);
  const roleKey = lower(role);
  const incomingIp = getRequestIp(req);
  const incomingDeviceInfo = asText(deviceInfo || getDeviceInfo(req));
  const incomingDeviceId = asText(deviceId || getDeviceId(req));

  const existingActiveSession = await RefreshToken.findOne({
    principalId: asText(principalId),
    role: roleKey,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
    jti: { $ne: asText(refreshMeta?.jti) },
  })
    .sort({ createdAt: -1 })
    .select("createdByIp deviceInfo userAgent deviceId")
    .lean();

  if (
    existingActiveSession &&
    ((incomingDeviceInfo &&
      existingActiveSession.deviceInfo &&
      incomingDeviceInfo !== asText(existingActiveSession.deviceInfo)) ||
      (incomingDeviceId &&
        existingActiveSession.deviceId &&
        incomingDeviceId !== asText(existingActiveSession.deviceId)) ||
      (incomingIp &&
        existingActiveSession.createdByIp &&
        incomingIp !== asText(existingActiveSession.createdByIp)))
  ) {
    await monitorSuspiciousSession({
      actorEmail: asText(req.body?.email),
      actorRole: roleKey,
      ipAddress: incomingIp,
      userAgent: asText(req.headers["user-agent"]),
      metadata: {
        previousDevice: asText(existingActiveSession.deviceInfo),
        previousDeviceId: asText(existingActiveSession.deviceId),
        previousIp: asText(existingActiveSession.createdByIp),
        newDevice: incomingDeviceInfo,
        newDeviceId: incomingDeviceId,
        newIp: incomingIp,
      },
    });
  }

  return RefreshToken.create({
    principalId: asText(principalId),
    role: roleKey,
    tokenHash: hashToken(refreshToken),
    familyId: refreshMeta.familyId,
    jti: refreshMeta.jti,
    expiresAt,
    createdByIp: incomingIp,
    userAgent: asText(req.headers["user-agent"]),
    deviceId: incomingDeviceId,
    deviceInfo: incomingDeviceInfo,
    lastActiveAt,
  });
};

const issueLoginTokens = async (
  req,
  res,
  { principalId, role, email, deviceId = "", deviceInfo = "" }
) => {
  const tokenSet = issueAuthTokenSet({
    principalId,
    role,
    email,
  });
  await persistRefreshToken(req, principalId, role, tokenSet.refreshToken, tokenSet.refreshMeta, {
    deviceId,
    deviceInfo,
    lastActiveAt: new Date(),
  });
  setAuthCookies(res, {
    accessToken: tokenSet.accessToken,
    refreshToken: tokenSet.refreshToken,
  });
  return {
    accessToken: tokenSet.accessToken,
    refreshToken: tokenSet.refreshToken,
    sessionId: asText(tokenSet.sessionId || tokenSet.refreshMeta?.jti),
  };
};

const revokeAuthSessionById = async ({
  principalId,
  role,
  sessionId,
  reason = "session_replaced",
  emitRealtime = true,
}) => {
  const normalizedSessionId = asText(sessionId);
  if (!normalizedSessionId) return 0;

  const result = await RefreshToken.updateMany(
    {
      principalId: asText(principalId),
      role: lower(role),
      jti: normalizedSessionId,
      revokedAt: null,
    },
    {
      $set: {
        revokedAt: new Date(),
        revokedReason: asText(reason) || "session_replaced",
      },
    }
  );

  if (emitRealtime && (result.modifiedCount || 0) > 0) {
    emitSessionInvalidatedEvent({
      sessionId: normalizedSessionId,
      reason: asText(reason) || "session_replaced",
    });
  }

  return Number(result.modifiedCount || 0);
};

const setCurrentPatientSession = async ({
  userId,
  sessionId,
  deviceId,
  activityAt = new Date(),
  revokePrevious = true,
}) => {
  const before = await User.findOneAndUpdate(
    { _id: userId },
    {
      $set: {
        currentSessionId: asText(sessionId),
        currentDeviceId: asText(deviceId),
        lastActiveAt: activityAt,
        lastLogin: activityAt,
      },
    },
    { new: false }
  )
    .select("currentSessionId")
    .lean();

  const previousSessionId = asText(before?.currentSessionId);
  const nextSessionId = asText(sessionId);
  if (
    revokePrevious &&
    previousSessionId &&
    nextSessionId &&
    previousSessionId !== nextSessionId
  ) {
    await revokeAuthSessionById({
      principalId: asText(userId),
      role: patientRole,
      sessionId: previousSessionId,
      reason: "new_login_replaced_previous_session",
      emitRealtime: true,
    });
  }
};

const getCurrentPatientSessionToken = async (user) => {
  const principalId = asText(user?._id);
  const currentSessionId = asText(user?.currentSessionId);
  if (!principalId || !currentSessionId) return null;

  return RefreshToken.findOne({
    principalId,
    role: patientRole,
    jti: currentSessionId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .select("jti deviceId deviceInfo createdByIp lastActiveAt")
    .lean();
};

const evaluateSessionActivity = ({ user, sessionToken }) => {
  const nowMs = Date.now();
  const userActiveMs = new Date(user?.lastActiveAt || 0).getTime() || 0;
  const tokenActiveMs = new Date(sessionToken?.lastActiveAt || 0).getTime() || 0;
  const latestActivityMs = Math.max(userActiveMs, tokenActiveMs);
  const ageMs = latestActivityMs > 0 ? nowMs - latestActivityMs : Number.POSITIVE_INFINITY;
  const isRecentHeartbeat = ageMs <= SESSION_ACTIVE_WINDOW_MS;
  const socketAlive = hasActiveSessionSocket(asText(sessionToken?.jti));
  const isActive = isRecentHeartbeat || socketAlive;

  return {
    isActive,
    isRecentHeartbeat,
    socketAlive,
    ageMs,
    latestActivityAt:
      latestActivityMs > 0 ? new Date(latestActivityMs) : null,
  };
};

const createOrReusePendingLoginAttempt = async ({
  principalId,
  requestedDeviceId,
  requestedDeviceInfo,
  requestedIp,
  requestedUserAgent,
  activeSessionId,
  activeDeviceId,
}) => {
  const expiresAt = new Date(Date.now() + LOGIN_ATTEMPT_TTL_MS);

  await LoginAttempt.updateMany(
    {
      principalId: asText(principalId),
      role: patientRole,
      status: "pending",
      expiresAt: { $lte: new Date() },
    },
    { $set: { status: "expired", respondedAt: new Date() } }
  );

  const existing = await LoginAttempt.findOne({
    principalId: asText(principalId),
    role: patientRole,
    status: "pending",
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });

  if (existing) {
    existing.requestedDeviceId = asText(requestedDeviceId);
    existing.requestedDeviceInfo = asText(requestedDeviceInfo);
    existing.requestedIp = asText(requestedIp);
    existing.requestedUserAgent = asText(requestedUserAgent);
    existing.activeSessionId = asText(activeSessionId);
    existing.activeDeviceId = asText(activeDeviceId);
    existing.expiresAt = expiresAt;
    await existing.save();
    return existing;
  }

  try {
    return await LoginAttempt.create({
      principalId: asText(principalId),
      role: patientRole,
      status: "pending",
      requestedDeviceId: asText(requestedDeviceId),
      requestedDeviceInfo: asText(requestedDeviceInfo),
      requestedIp: asText(requestedIp),
      requestedUserAgent: asText(requestedUserAgent),
      activeSessionId: asText(activeSessionId),
      activeDeviceId: asText(activeDeviceId),
      expiresAt,
    });
  } catch (error) {
    if (error?.code === 11000) {
      const latest = await LoginAttempt.findOne({
        principalId: asText(principalId),
        role: patientRole,
        status: "pending",
      }).sort({ createdAt: -1 });
      if (latest) return latest;
    }
    throw error;
  }
};

const completePatientLogin = async ({ req, res, user, message = "Login successful" }) => {
  const now = new Date();
  const requestedDeviceId = getDeviceId(req);
  const requestedDeviceInfo = getDeviceInfo(req);
  const allowMultipleSessions = user?.allowMultipleSessions === true;

  const tokenBundle = await issueLoginTokens(req, res, {
    principalId: user._id.toString(),
    role: patientRole,
    email: user.email,
    deviceId: requestedDeviceId,
    deviceInfo: requestedDeviceInfo,
  });

  await setCurrentPatientSession({
    userId: user._id,
    sessionId: tokenBundle.sessionId,
    deviceId: requestedDeviceId,
    activityAt: now,
    revokePrevious: !allowMultipleSessions,
  });

  const updatedUser = await User.findById(user._id);
  const responseUser = await buildUserResponse(updatedUser || user);

  return {
    success: true,
    message,
    user: responseUser,
    token: tokenBundle.accessToken,
    refreshToken: tokenBundle.refreshToken,
  };
};

const handlePatientLoginWithSessionPolicy = async ({
  req,
  res,
  user,
  loginSource = "patient_login",
  successMessage = "Login successful",
}) => {
  const principalId = asText(user?._id);
  const requestedDeviceId = getDeviceId(req);
  const requestedDeviceInfo = getDeviceInfo(req);
  const requestedIp = getRequestIp(req);
  const requestedUserAgent = asText(req.headers["user-agent"]);
  const allowMultipleSessions = user?.allowMultipleSessions === true;

  console.info("[AuthSession] Login attempt", {
    principalId,
    loginSource,
    requestedDeviceId,
    allowMultipleSessions,
  });

  if (allowMultipleSessions) {
    console.info("[AuthSession] allowMultipleSessions=true, skipping session checks", {
      principalId,
      loginSource,
    });
    return {
      type: "success",
      payload: await completePatientLogin({
        req,
        res,
        user,
        message: successMessage,
      }),
    };
  }

  const existingToken = await getCurrentPatientSessionToken(user);
  if (!existingToken) {
    if (asText(user.currentSessionId)) {
      await User.updateOne(
        { _id: user._id },
        { $set: { currentSessionId: "", currentDeviceId: "" } }
      );
    }
    return {
      type: "success",
      payload: await completePatientLogin({
        req,
        res,
        user,
        message: successMessage,
      }),
    };
  }

  const activity = evaluateSessionActivity({ user, sessionToken: existingToken });
  console.info("[AuthSession] Existing session decision", {
    principalId,
    currentSessionId: asText(existingToken.jti),
    isActive: activity.isActive,
    isRecentHeartbeat: activity.isRecentHeartbeat,
    socketAlive: activity.socketAlive,
    ageMs: Number.isFinite(activity.ageMs) ? activity.ageMs : null,
    loginSource,
  });

  if (!activity.isActive) {
    await revokeAuthSessionById({
      principalId,
      role: patientRole,
      sessionId: asText(existingToken.jti),
      reason: "inactive_session_replaced",
      emitRealtime: true,
    });
    return {
      type: "success",
      payload: await completePatientLogin({
        req,
        res,
        user,
        message: successMessage,
      }),
    };
  }

  const attempt = await createOrReusePendingLoginAttempt({
    principalId,
    requestedDeviceId,
    requestedDeviceInfo,
    requestedIp,
    requestedUserAgent,
    activeSessionId: asText(existingToken.jti),
    activeDeviceId: asText(existingToken.deviceId || user.currentDeviceId),
  });

  const attemptId = asText(attempt?._id);
  const attemptToken = signLoginAttemptToken({
    attemptId,
    principalId,
    role: patientRole,
  });
  const wsRecipients = emitLoginAttemptEvent({
    sessionId: asText(existingToken.jti),
    attemptId,
    requestedDeviceInfo,
    requestedIp,
  });

  console.info("[AuthSession] Login approval required", {
    principalId,
    attemptId,
    activeSessionId: asText(existingToken.jti),
    wsRecipients,
  });

  return {
    type: "pending",
    payload: {
      success: false,
      code: "LOGIN_APPROVAL_REQUIRED",
      message: "Active session approval required",
      loginAttemptId: attemptId,
      attemptToken,
    },
  };
};

const profilePhotoUpload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,
    key: (req, file, cb) => {
      const ext = path.extname(file.originalname) || ".jpg";
      const baseName = path
        .parse(file.originalname)
        .name.replace(/\s+/g, "_")
        .slice(0, 40);
      const unique = Math.random().toString(36).slice(2, 10);
      const userId =
        (req.user?._id?.toString() ?? req.user?.id?.toString()) || "unknown";
      const fileName = `profile-pictures/${userId}/${Date.now()}-${unique}-${baseName}${ext}`;
      cb(null, fileName);
    },
    contentType: multerS3.AUTO_CONTENT_TYPE,
    metadata: (req, file, cb) => {
      cb(null, {
        fieldName: file.fieldname,
        uploadedBy:
          (req.user?._id?.toString() ?? req.user?.id?.toString()) || "unknown",
      });
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mimeType = String(file.mimetype || "").toLowerCase();
    if (!mimeType.startsWith("image/")) {
      return cb(new Error("Only image files are allowed"));
    }
    return cb(null, true);
  },
});

// ================= Patient Signup =================
router.post("/signup", registerValidation, async (req, res) => {
  try {
    const { name, email, password, mobile } = req.body;
    if (typeof req.body?.role !== "undefined") {
      return res.status(400).json({ success: false, message: "Role is not accepted in patient signup" });
    }

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
      safeLog("Verification email sent");
    } catch (emailError) {
      console.error("❌ Failed to send verification email:", emailError);
      // Don't fail signup if email fails - user can resend
    }

    const loginPayload = await completePatientLogin({
      req,
      res,
      user: newUser,
      message:
        "User registered successfully. Please check your email to verify your account.",
    });

    res.status(201).json(loginPayload);
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
    let createdViaGoogle = false;

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
      safeLog("New user created via Google");
      createdViaGoogle = true;
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
      await user.save();
      safeLog("Existing user logged in via Google");
    }

    const loginResult = await handlePatientLoginWithSessionPolicy({
      req,
      res,
      user,
      loginSource: "patient_google_login",
      successMessage: createdViaGoogle
        ? "Account created successfully"
        : "Login successful",
    });

    if (loginResult.type === "pending") {
      return res.status(409).json(loginResult.payload);
    }

    return res.status(200).json(loginResult.payload);

  } catch (error) {
    console.error("Google auth error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Google authentication failed" 
    });
  }
});

// ================= Patient Login =================
router.post("/login", authLimiter, loginValidation, async (req, res) => {
  try {
    const { email, password } = req.body;
    const blockState = await isActorTemporarilyBlocked({ actorEmail: email, actorRole: "patient" });
    if (blockState.isBlocked) {
      return res.status(429).json({ message: "Account temporarily blocked due to suspicious activity" });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      await monitorFailedLogin({
        actorEmail: email,
        actorRole: "patient",
        ipAddress: req.ip || "",
        userAgent: req.headers["user-agent"] || "",
        source: "patient_login",
      });
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const isValid = await user.comparePassword(password);
    
    if (!isValid) {
      await monitorFailedLogin({
        actorEmail: email,
        actorRole: "patient",
        ipAddress: req.ip || "",
        userAgent: req.headers["user-agent"] || "",
        source: "patient_login",
      });
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const loginResult = await handlePatientLoginWithSessionPolicy({
      req,
      res,
      user,
      loginSource: "patient_password_login",
      successMessage: "Login successful",
    });

    if (loginResult.type === "pending") {
      return res.status(409).json(loginResult.payload);
    }

    return res.status(200).json(loginResult.payload);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ================= Doctor Signup =================
router.post("/doctor/signup", doctorSignupValidation, async (req, res) => {
  try {
    if (typeof req.body?.role !== "undefined") {
      return res.status(400).json({ success: false, message: "Role cannot be set from client" });
    }
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

    const { accessToken, refreshToken } = await issueLoginTokens(req, res, {
      principalId: newDoctor._id.toString(),
      role: "doctor",
      email: newDoctor.email,
    });

    res.status(201).json({
      success: true,
      message: "Doctor registered successfully",
      doctor: {
        id: newDoctor._id.toString(),
        name: newDoctor.name,
        email: newDoctor.email,
        specialization: newDoctor.specialization,
      },
      token: accessToken,
      refreshToken,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ================= Doctor Login =================
router.post("/doctor/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const blockState = await isActorTemporarilyBlocked({ actorEmail: email, actorRole: "doctor" });
    if (blockState.isBlocked) {
      return res.status(429).json({ message: "Account temporarily blocked due to suspicious activity" });
    }

    const doctor = await DoctorUser.findOne({ email: email.toLowerCase() });
    if (!doctor) {
      await monitorFailedLogin({
        actorEmail: email,
        actorRole: "doctor",
        ipAddress: req.ip || "",
        userAgent: req.headers["user-agent"] || "",
        source: "doctor_login",
      });
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const isValid = await doctor.comparePassword(password);
    if (!isValid) {
      await monitorFailedLogin({
        actorEmail: email,
        actorRole: "doctor",
        ipAddress: req.ip || "",
        userAgent: req.headers["user-agent"] || "",
        source: "doctor_login",
      });
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const { accessToken, refreshToken } = await issueLoginTokens(req, res, {
      principalId: doctor._id.toString(),
      role: "doctor",
      email: doctor.email,
    });

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
      token: accessToken,
      refreshToken,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ================= Current User/Doctor =================
router.get("/me", auth, getMe);
router.put("/me", auth, updateMe);

// ================= Token Refresh / Logout =================
router.post("/refresh", async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const providedRefreshToken = String(
      req.body?.refreshToken || cookies.mv_rt || ""
    ).trim();
    if (!providedRefreshToken) {
      return res.status(401).json({ success: false, message: "Refresh token is required" });
    }

    const decoded = verifyRefreshToken(providedRefreshToken);
    const role = String(decoded.role || "").toLowerCase();
    if (!["patient", "doctor"].includes(role)) {
      return res.status(403).json({ success: false, message: "Invalid refresh token role" });
    }

    const stored = await RefreshToken.findOne({
      tokenHash: hashToken(providedRefreshToken),
      revokedAt: null,
    });
    if (!stored || stored.expiresAt <= new Date()) {
      return res.status(401).json({ success: false, message: "Refresh token expired or revoked" });
    }

    let principal;
    if (role === "doctor") {
      principal = await DoctorUser.findById(stored.principalId).select("_id email isActive status");
    } else {
      principal = await User.findById(stored.principalId).select("_id email isActive status");
    }

    if (!principal || principal.isActive === false || principal.status === "BLOCKED") {
      return res.status(403).json({ success: false, message: "Account inactive" });
    }

    const { accessToken, refreshToken, refreshMeta, sessionId } = issueAuthTokenSet({
      principalId: principal._id.toString(),
      role,
      email: principal.email,
      familyId: decoded.familyId,
    });

    stored.revokedAt = new Date();
    stored.revokedReason = "rotated";
    stored.replacedByTokenHash = hashToken(refreshToken);
    await stored.save();
    await persistRefreshToken(req, principal._id.toString(), role, refreshToken, refreshMeta, {
      deviceId: getDeviceId(req),
      deviceInfo: getDeviceInfo(req),
      lastActiveAt: new Date(),
    });

    if (role === patientRole) {
      const user = await User.findById(principal._id).select("_id");
      if (user) {
        await setCurrentPatientSession({
          userId: user._id,
          sessionId,
          deviceId: getDeviceId(req),
          activityAt: new Date(),
          revokePrevious: false,
        });
      }
    }

    setAuthCookies(res, { accessToken, refreshToken });
    return res.json({ success: true, token: accessToken, refreshToken });
  } catch {
    return res.status(401).json({ success: false, message: "Invalid refresh token" });
  }
});

router.post("/logout", auth, async (req, res) => {
  try {
    const principalId = asText(req.auth?.id);
    const role = lower(req.auth?.role);
    const sessionId = asText(req.auth?.sid);
    const cookies = parseCookies(req);
    const providedRefreshToken = String(
      req.body?.refreshToken || cookies.mv_rt || ""
    ).trim();

    if (providedRefreshToken) {
      await RefreshToken.updateOne(
        { tokenHash: hashToken(providedRefreshToken), revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: "logout" } }
      );
    }

    if (principalId && role && sessionId) {
      await revokeAuthSessionById({
        principalId,
        role,
        sessionId,
        reason: "logout",
        emitRealtime: false,
      });
    }

    if (role === patientRole && principalId) {
      await User.updateOne(
        { _id: principalId, currentSessionId: sessionId },
        {
          $set: {
            currentSessionId: "",
            currentDeviceId: "",
          },
        }
      );
    }

    clearAuthCookies(res);
    return res.json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Logout failed" });
  }
});

// ---------------- Auth Session Control ----------------
// POST /api/auth/session/heartbeat
router.post("/session/heartbeat", auth, async (req, res) => {
  try {
    const principalId = asText(req.auth?.id);
    const role = lower(req.auth?.role);
    const sessionId = asText(req.auth?.sid);
    const now = new Date();

    if (!principalId || !["patient", "doctor", "admin", "superadmin"].includes(role)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }
    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: "Session id missing in access token",
        code: "SESSION_ID_MISSING",
      });
    }

    const heartbeatUpdate = await RefreshToken.updateOne(
      {
        principalId,
        role,
        jti: sessionId,
        revokedAt: null,
        expiresAt: { $gt: now },
      },
      {
        $set: {
          lastActiveAt: now,
          deviceId: getDeviceId(req),
          deviceInfo: getDeviceInfo(req),
          userAgent: asText(req.headers["user-agent"]),
        },
      }
    );

    if ((heartbeatUpdate.matchedCount || 0) === 0) {
      return res.status(401).json({
        success: false,
        code: "SESSION_INVALID",
        message: "You have been logged out due to login from another device",
      });
    }

    if (role === patientRole) {
      await User.updateOne(
        { _id: principalId },
        {
          $set: {
            lastActiveAt: now,
            currentSessionId: sessionId,
            currentDeviceId: getDeviceId(req),
          },
        }
      );
    }

    return res.json({
      success: true,
      message: "Heartbeat received",
      lastActiveAt: now.toISOString(),
    });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: "Failed to process heartbeat" });
  }
});

// POST /api/auth/session/login-attempt/respond
router.post("/session/login-attempt/respond", auth, async (req, res) => {
  try {
    const principalId = asText(req.auth?.id);
    const role = lower(req.auth?.role);
    const sessionId = asText(req.auth?.sid);
    const loginAttemptId = asText(req.body?.loginAttemptId);
    const approve = req.body?.approve === true;

    if (role !== patientRole) {
      return res.status(403).json({ success: false, message: "Patient access required" });
    }
    if (!loginAttemptId || !/^[a-fA-F0-9]{24}$/.test(loginAttemptId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid login attempt id",
      });
    }

    const attempt = await LoginAttempt.findOne({
      _id: loginAttemptId,
      principalId,
      role: patientRole,
    });
    if (!attempt) {
      return res
        .status(404)
        .json({ success: false, message: "Login attempt not found" });
    }

    if (attempt.status !== "pending") {
      const isApproved = attempt.status === "approved" || attempt.status === "consumed";
      return res.json({
        success: true,
        message: isApproved
          ? "Login request already approved"
          : "Login request already denied",
        status: attempt.status,
      });
    }
    if (attempt.expiresAt <= new Date()) {
      attempt.status = "expired";
      attempt.respondedAt = new Date();
      await attempt.save();
      return res.status(410).json({
        success: false,
        message: "Login request expired",
        code: "LOGIN_APPROVAL_EXPIRED",
      });
    }

    if (
      asText(attempt.activeSessionId) &&
      asText(attempt.activeSessionId) !== sessionId
    ) {
      return res.status(403).json({
        success: false,
        message: "Only active session can respond",
      });
    }

    attempt.status = approve ? "approved" : "denied";
    attempt.respondedAt = new Date();
    await attempt.save();

    if (approve) {
      console.info("[AuthSession] Login attempt approved", {
        principalId,
        loginAttemptId,
        activeSessionId: asText(attempt.activeSessionId),
      });
      await revokeAuthSessionById({
        principalId,
        role: patientRole,
        sessionId: asText(attempt.activeSessionId),
        reason: "new_login_approved",
        emitRealtime: true,
      });
      await User.updateOne(
        { _id: principalId, currentSessionId: asText(attempt.activeSessionId) },
        { $set: { currentSessionId: "", currentDeviceId: "" } }
      );
      emitLoginApprovedEvent({
        attemptId: loginAttemptId,
        sessionId: asText(attempt.activeSessionId),
      });
      return res.json({
        success: true,
        message: "Login request approved",
        status: "approved",
      });
    }

    console.info("[AuthSession] Login attempt denied", {
      principalId,
      loginAttemptId,
      activeSessionId: asText(attempt.activeSessionId),
    });
    emitLoginDeniedEvent({ attemptId: loginAttemptId });
    return res.json({
      success: true,
      message: "Login request denied",
      status: "denied",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to respond to login attempt",
    });
  }
});

// POST /api/auth/session/login-attempt/finalize
router.post("/session/login-attempt/finalize", async (req, res) => {
  try {
    const loginAttemptId = asText(req.body?.loginAttemptId);
    const attemptToken = asText(req.body?.attemptToken);

    if (!loginAttemptId || !attemptToken) {
      return res.status(400).json({
        success: false,
        message: "loginAttemptId and attemptToken are required",
      });
    }

    let tokenPayload;
    try {
      tokenPayload = verifyLoginAttemptToken(attemptToken);
    } catch {
      return res.status(401).json({
        success: false,
        message: "Invalid attempt token",
      });
    }

    if (
      asText(tokenPayload?.typ) !== "login_attempt" ||
      asText(tokenPayload?.attemptId) !== loginAttemptId
    ) {
      return res.status(401).json({
        success: false,
        message: "Attempt token mismatch",
      });
    }

    const attempt = await LoginAttempt.findById(loginAttemptId);
    if (!attempt) {
      return res.status(404).json({
        success: false,
        message: "Login attempt not found",
      });
    }
    if (
      asText(tokenPayload?.sub) &&
      asText(tokenPayload.sub) !== asText(attempt.principalId)
    ) {
      return res.status(401).json({
        success: false,
        message: "Attempt token principal mismatch",
      });
    }
    if (
      asText(tokenPayload?.role) &&
      lower(tokenPayload.role) !== lower(attempt.role)
    ) {
      return res.status(401).json({
        success: false,
        message: "Attempt token role mismatch",
      });
    }
    if (attempt.expiresAt <= new Date()) {
      if (attempt.status === "pending") {
        attempt.status = "expired";
        await attempt.save();
      }
      return res.status(410).json({
        success: false,
        message: "Login approval expired",
        code: "LOGIN_APPROVAL_EXPIRED",
      });
    }
    if (attempt.status === "pending") {
      return res.status(409).json({
        success: false,
        message: "Login approval still pending",
        code: "LOGIN_APPROVAL_REQUIRED",
      });
    }
    if (attempt.status === "denied") {
      return res.status(403).json({
        success: false,
        message: "Login denied by active session",
        code: "LOGIN_DENIED_BY_ACTIVE_SESSION",
      });
    }
    if (attempt.status === "consumed") {
      return res.status(409).json({
        success: false,
        message: "Login approval already consumed",
        code: "LOGIN_APPROVAL_CONSUMED",
      });
    }
    if (attempt.status !== "approved") {
      return res.status(409).json({
        success: false,
        message: "Login attempt is not approvable",
      });
    }

    const consumedAt = new Date();
    const claimed = await LoginAttempt.findOneAndUpdate(
      {
        _id: loginAttemptId,
        status: "approved",
        consumedAt: null,
      },
      {
        $set: {
          status: "consumed",
          consumedAt,
        },
      },
      { new: true }
    );
    if (!claimed) {
      return res.status(409).json({
        success: false,
        message: "Login approval was already finalized",
      });
    }

    try {
      const user = await User.findById(asText(claimed.principalId));
      if (!user || user.isActive === false || user.status === "BLOCKED") {
        return res.status(403).json({
          success: false,
          message: "Account inactive",
        });
      }

      const payload = await completePatientLogin({
        req,
        res,
        user,
        message: "Login successful",
      });
      return res.status(200).json(payload);
    } catch (error) {
      await LoginAttempt.updateOne(
        { _id: loginAttemptId, status: "consumed", consumedAt },
        { $set: { status: "approved" }, $unset: { consumedAt: 1 } }
      );
      throw error;
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to finalize login",
    });
  }
});

// ================= Debug Login Endpoint =================
router.post("/debug-login", async (req, res) => {
  if (!ENABLE_DEBUG_ROUTES) {
    return res.status(404).json({ success: false, message: "Not found" });
  }
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

    const tokens = await issueLoginTokens(req, res, {
      principalId: user._id.toString(),
      role,
      email: user.email,
    });
    token = tokens.accessToken;

    if (role === patientRole) {
      await setCurrentPatientSession({
        userId: user._id,
        sessionId: tokens.sessionId,
        deviceId: getDeviceId(req),
        activityAt: new Date(),
        revokePrevious: user.allowMultipleSessions !== true,
      });
    }

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
      refreshToken: tokens.refreshToken,
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
    const tokenStr = req.body.token;
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
router.post("/verify-code", codeLimiter, async (req, res) => {
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
router.post("/resend-verification", emailLimiter, async (req, res) => {
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
  if (!ENABLE_DEBUG_ROUTES) {
    return res.status(404).json({ success: false, message: "Not found" });
  }
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

    const { accessToken, refreshToken } = await issueLoginTokens(req, res, {
      principalId: patient._id.toString(),
      role: "patient",
      email: patient.email,
    });

    const responseUser = await buildUserResponse(patient);

    res.json({
      success: true,
      message: "Test patient token generated",
      token: accessToken,
      refreshToken,
      patient: responseUser,
    });
  } catch (error) {
    console.error("Test patient creation error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create test patient"
    });
  }
});

router.post(
  "/profile-picture",
  auth,
  profilePhotoUpload.single("photo"),
  async (req, res) => {
    try {
      if (!req.file || (!req.file.location && !req.file.key)) {
        return res
          .status(400)
          .json({ success: false, message: "Photo upload failed" });
      }

      const userId = req.user._id || req.user.id;
      const photoKey = req.file.key || req.file.location;

      const updatedUser = await User.findByIdAndUpdate(
        userId,
        { profilePicture: photoKey },
        { new: true, runValidators: true }
      ).select("-password");

      if (!updatedUser) {
        return res
          .status(404)
          .json({ success: false, message: "User not found" });
      }

      let signedUrl = null;
      if (photoKey) {
        try {
          const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: photoKey,
          });
          signedUrl = await getSignedUrl(
            s3Client,
            command,
            { expiresIn: Number(process.env.PROFILE_PIC_URL_TTL || 3600) },
          );
        } catch (error) {
          console.error(
            "Failed to generate signed profile picture URL:",
            error.message || error,
          );
        }
      }

      const responseUser = await buildUserResponse(updatedUser);

      res.status(201).json({
        success: true,
        message: "Profile picture updated successfully",
        data: {
          photoUrl: signedUrl,
          user: responseUser,
        },
      });
    } catch (error) {
      console.error("Profile picture upload error:", error);
      res
        .status(500)
        .json({ success: false, message: "Internal server error" });
    }
  }
);

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
    rejectUnauthorized:
      String(process.env.SMTP_REJECT_UNAUTHORIZED || "true").toLowerCase() ===
      "true",
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
router.post("/forgot-password", emailLimiter, forgotPasswordValidation, async (req, res) => {
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
    const resetTokenHash = hashToken(resetToken);

    const expiryDate = new Date(Date.now() + expiresInMinutes * 60 * 1000);
    user.resetToken = null;
    user.resetTokenHash = resetTokenHash;
    user.resetTokenExpiry = expiryDate;
    await user.save();

    const frontendUrl =
      process.env.FRONTEND_URL ||
      process.env.APP_WEB_URL ||
      (process.env.NODE_ENV === "production"
        ? "https://health-vault-web.vercel.app"
        : "http://localhost:5173");
    const resetLink = `${frontendUrl}/reset-password?token=${encodeURIComponent(resetToken)}`;

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
        safeLog("Password reset email sent");
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
router.post("/reset-password", resetPasswordValidation, async (req, res) => {
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
    if (!user || user.resetTokenHash !== hashToken(token)) {
      return res.status(400).json({ success: false, message: "Invalid token" });
    }

    if (!user.resetTokenExpiry || user.resetTokenExpiry.getTime() < Date.now()) {
      return res.status(400).json({ success: false, message: "Token expired" });
    }

    // Set the new password - the pre-save hook will hash it automatically
    user.password = newPassword;
    user.resetToken = null;
    user.resetTokenHash = null;
    user.resetTokenExpiry = null;
    await user.save();

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

    // Set the new password - the pre-save hook will hash it automatically
    user.password = newPassword;
    await user.save();

    res.json({ success: true, message: "Password changed successfully" });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ================= Consent Logging =================
// POST /auth/consent
router.post("/consent", auth, async (req, res) => {
  try {
    const userId = req.user?._id || req.auth?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    const consentType = String(req.body?.consentType || "").trim().toUpperCase();
    const version = String(req.body?.version || "").trim();
    if (!["PRIVACY_POLICY", "TERMS_OF_SERVICE"].includes(consentType) || !version) {
      return res.status(400).json({
        success: false,
        message: "consentType (PRIVACY_POLICY|TERMS_OF_SERVICE) and version are required",
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const existingIdx = Array.isArray(user.consents)
      ? user.consents.findIndex(
          (entry) =>
            String(entry?.consentType || "").toUpperCase() === consentType &&
            String(entry?.version || "") === version
        )
      : -1;

    const payload = {
      consentType,
      version,
      acceptedAt: new Date(),
      ipAddress: req.ip || "",
      userAgent: req.headers["user-agent"] || "",
    };

    if (existingIdx >= 0) {
      user.consents[existingIdx] = payload;
    } else {
      user.consents = [...(user.consents || []), payload];
    }
    await user.save();

    return res.json({ success: true, message: "Consent logged successfully", consent: payload });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to log consent" });
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

    // Set the new password - the pre-save hook will hash it automatically
    user.password = password;
    await user.save();

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
