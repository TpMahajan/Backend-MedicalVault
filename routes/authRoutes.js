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
import { AdminUser } from "../models/AdminUser.js";
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
  emitLoginApprovedEvent,
  emitLoginAttemptEvent,
  emitLoginDeniedEvent,
  emitSessionInvalidatedEvent,
} from "../services/authSessionRealtime.js";
import {
  isActorTemporarilyBlocked,
  monitorFailedLogin,
  monitorSuspiciousSession,
} from "../services/securityMonitorService.js";

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

const RESETTABLE_ACCOUNT_DEFINITIONS = [
  { role: "patient", model: User, displayName: "Patient" },
  { role: "doctor", model: DoctorUser, displayName: "Doctor" },
  { role: "admin", model: AdminUser, displayName: "Admin" },
];

const resolveResettableAccountByEmail = async (email) => {
  const normalizedEmail = String(email || "").toLowerCase().trim();
  for (const entry of RESETTABLE_ACCOUNT_DEFINITIONS) {
    const account = await entry.model.findOne({ email: normalizedEmail });
    if (account) {
      return { ...entry, account };
    }
  }
  return null;
};

const resolveResettableAccountByTokenPayload = async (payload) => {
  const role = String(payload?.role || "").toLowerCase().trim() || "patient";
  const userId = String(payload?.userId || payload?.sub || "").trim();
  if (!userId) return null;

  const roleDefinition = RESETTABLE_ACCOUNT_DEFINITIONS.find(
    (entry) => entry.role === role
  );
  if (!roleDefinition) return null;

  const account = await roleDefinition.model.findById(userId);
  if (!account) return null;
  return { ...roleDefinition, account };
};

const SESSION_INVALID_CODE = "SESSION_INVALID";
const LOGIN_APPROVAL_REQUIRED_CODE = "LOGIN_APPROVAL_REQUIRED";
const LOGIN_ATTEMPT_TTL_MS = Number(
  process.env.LOGIN_ATTEMPT_WINDOW_MS || 5 * 60 * 1000
);
const loginLocks = new Map();

const asText = (value) => (value == null ? "" : String(value).trim());

const resolveDeviceContext = (req, overrides = {}) => ({
  deviceId: asText(
    overrides.deviceId ||
      req.body?.deviceId ||
      req.headers["x-device-id"] ||
      ""
  ).slice(0, 200),
  deviceInfo: asText(
    overrides.deviceInfo ||
      req.headers["x-device-info"] ||
      req.headers["sec-ch-ua-platform"] ||
      ""
  ).slice(0, 300),
  userAgent: asText(overrides.userAgent || req.headers["user-agent"] || "").slice(
    0,
    500
  ),
  ipAddress: asText(overrides.ipAddress || req.ip || "").slice(0, 100),
});

const normalizeRole = (role) => asText(role).toLowerCase();

const runWithLoginLock = async (lockKey, work) => {
  while (loginLocks.has(lockKey)) {
    try {
      await loginLocks.get(lockKey);
    } catch {
      // Ignore previous lock failures.
    }
  }

  let release;
  const waitHandle = new Promise((resolve) => {
    release = resolve;
  });
  loginLocks.set(lockKey, waitHandle);

  try {
    return await work();
  } finally {
    release();
    if (loginLocks.get(lockKey) === waitHandle) {
      loginLocks.delete(lockKey);
    }
  }
};

const isSameDevice = (existing, incoming) => {
  const existingDeviceId = asText(existing?.deviceId);
  const incomingDeviceId = asText(incoming?.deviceId);
  if (existingDeviceId && incomingDeviceId) {
    return existingDeviceId === incomingDeviceId;
  }

  const existingUa = asText(existing?.userAgent || "").toLowerCase();
  const incomingUa = asText(incoming?.userAgent || "").toLowerCase();
  const existingInfo = asText(existing?.deviceInfo || "").toLowerCase();
  const incomingInfo = asText(incoming?.deviceInfo || "").toLowerCase();

  if (!existingUa || !incomingUa) return false;
  if (existingUa !== incomingUa) return false;
  if (existingInfo && incomingInfo && existingInfo !== incomingInfo) {
    return false;
  }
  return true;
};

const findLatestActiveSession = async ({ principalId, role }) =>
  RefreshToken.findOne({
    principalId: asText(principalId),
    role: normalizeRole(role),
    sessionId: { $exists: true, $ne: "" },
    revokedAt: null,
    expiresAt: { $gt: new Date() },
    isCurrentSession: { $ne: false },
  })
    .sort({ lastActiveAt: -1, createdAt: -1 })
    .lean();

const revokeActiveSessions = async ({
  principalId,
  role,
  reason,
  skipSessionId = "",
  emitRealtime = false,
}) => {
  const baseQuery = {
    principalId: asText(principalId),
    role: normalizeRole(role),
    revokedAt: null,
    expiresAt: { $gt: new Date() },
    isCurrentSession: { $ne: false },
  };
  if (asText(skipSessionId)) {
    baseQuery.sessionId = { $ne: asText(skipSessionId) };
  }

  const rows = await RefreshToken.find(baseQuery).select("sessionId").lean();
  if (!rows.length) return 0;

  await RefreshToken.updateMany(baseQuery, {
    $set: {
      revokedAt: new Date(),
      revokedReason: asText(reason) || "session_invalidated",
      isCurrentSession: false,
    },
  });

  if (emitRealtime) {
    for (const row of rows) {
      if (!asText(row?.sessionId)) continue;
      emitSessionInvalidatedEvent({
        sessionId: row.sessionId,
        reason: asText(reason) || "session_invalidated",
      });
    }
  }

  return rows.length;
};

const persistRefreshToken = async (
  req,
  principalId,
  role,
  refreshToken,
  refreshMeta,
  context = {}
) => {
  const decoded = verifyRefreshToken(refreshToken);
  const expiresAt = new Date((decoded.exp || 0) * 1000);
  const roleKey = normalizeRole(role);
  const sessionId = asText(refreshMeta?.sid || context.sessionId);
  if (!sessionId) {
    throw new Error("Missing session id while persisting refresh token");
  }

  const device = resolveDeviceContext(req, context);
  const existingActiveSession = await findLatestActiveSession({
    principalId,
    role: roleKey,
  });

  if (existingActiveSession && existingActiveSession.sessionId !== sessionId) {
    if (!isSameDevice(existingActiveSession, device)) {
      await monitorSuspiciousSession({
        actorEmail: req.body?.email || "",
        actorRole: roleKey,
        ipAddress: device.ipAddress,
        userAgent: device.userAgent,
        metadata: {
          previousDevice: existingActiveSession.deviceInfo || "",
          previousIp: existingActiveSession.createdByIp || "",
          newDevice: device.deviceInfo,
          newIp: device.ipAddress,
        },
      });
    }

    await revokeActiveSessions({
      principalId,
      role: roleKey,
      reason: "single_session_enforced",
      skipSessionId: sessionId,
      emitRealtime: false,
    });
  }

  await RefreshToken.findOneAndUpdate(
    {
      sessionId,
    },
    {
      $set: {
        principalId: asText(principalId),
        role: roleKey,
        tokenHash: hashToken(refreshToken),
        familyId: refreshMeta.familyId,
        jti: refreshMeta.jti,
        expiresAt,
        revokedAt: null,
        revokedReason: "",
        replacedByTokenHash: "",
        createdByIp: device.ipAddress,
        userAgent: device.userAgent,
        deviceInfo: device.deviceInfo,
        deviceId: device.deviceId,
        lastActiveAt: new Date(),
        isCurrentSession: true,
      },
      $setOnInsert: {
        createdAt: new Date(),
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    }
  );
};

const issueLoginTokens = async (
  req,
  res,
  { principalId, role, email, sessionId, deviceContext }
) => {
  const { accessToken, refreshToken, refreshMeta, sessionId: issuedSessionId } =
    issueAuthTokenSet({
      principalId,
      role,
      email,
      sessionId,
    });
  await persistRefreshToken(req, principalId, role, refreshToken, refreshMeta, {
    ...(deviceContext || {}),
    sessionId: issuedSessionId,
  });
  setAuthCookies(res, { accessToken, refreshToken });
  return { accessToken, refreshToken, sessionId: issuedSessionId };
};

const createOrReusePendingLoginAttempt = async ({
  principalId,
  role,
  requestedDeviceId,
  requestedDeviceInfo,
  requestedUserAgent,
  requestedIp,
  activeSessionId,
  activeDeviceId,
}) => {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOGIN_ATTEMPT_TTL_MS);
  const filter = {
    principalId: asText(principalId),
    role: normalizeRole(role),
    status: "pending",
    expiresAt: { $gt: now },
  };

  const update = {
    $set: {
      requestedDeviceId: asText(requestedDeviceId),
      requestedDeviceInfo: asText(requestedDeviceInfo),
      requestedUserAgent: asText(requestedUserAgent),
      requestedIp: asText(requestedIp),
      activeSessionId: asText(activeSessionId),
      activeDeviceId: asText(activeDeviceId),
      expiresAt,
      respondedAt: null,
      consumedAt: null,
    },
    $setOnInsert: {
      principalId: asText(principalId),
      role: normalizeRole(role),
      status: "pending",
    },
  };

  try {
    return await LoginAttempt.findOneAndUpdate(filter, update, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return LoginAttempt.findOne(filter);
  }
};

const resolvePrincipalAccount = async ({ principalId, role }) => {
  const normalizedRole = normalizeRole(role);
  if (normalizedRole === "doctor") {
    return DoctorUser.findById(principalId).select(
      "_id email name specialization isActive status lastLogin"
    );
  }

  if (normalizedRole === "patient") {
    return User.findById(principalId).select(
      "_id email name mobile emailVerified isActive status profilePicture loginType googleId lastLogin"
    );
  }

  return null;
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

    const { accessToken, refreshToken, sessionId } = await issueLoginTokens(
      req,
      res,
      {
      principalId: newUser._id.toString(),
      role: "patient",
      email: newUser.email,
      }
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
      token: accessToken,
      refreshToken,
      sessionId,
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
      safeLog("New user created via Google");
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
      safeLog("Existing user logged in via Google");
    }

    const principalId = user._id.toString();
    const role = "patient";
    const lockKey = `${role}:${principalId}`;
    const deviceContext = resolveDeviceContext(req);

    await runWithLoginLock(lockKey, async () => {
      const activeSession = await findLatestActiveSession({ principalId, role });
      const sameDevice = activeSession
        ? isSameDevice(activeSession, deviceContext)
        : false;

      if (activeSession && !sameDevice) {
        const loginAttempt = await createOrReusePendingLoginAttempt({
          principalId,
          role,
          requestedDeviceId: deviceContext.deviceId,
          requestedDeviceInfo: deviceContext.deviceInfo,
          requestedUserAgent: deviceContext.userAgent,
          requestedIp: deviceContext.ipAddress,
          activeSessionId: activeSession.sessionId,
          activeDeviceId: activeSession.deviceId,
        });

        const attemptId = loginAttempt?._id?.toString() || "";
        const attemptToken = signLoginAttemptToken({
          attemptId,
          principalId,
          role,
          deviceId: deviceContext.deviceId,
        });

        emitLoginAttemptEvent({
          sessionId: activeSession.sessionId,
          attemptId,
          requestedDeviceInfo: deviceContext.deviceInfo || deviceContext.userAgent,
          requestedIp: deviceContext.ipAddress,
        });

        return res.status(409).json({
          success: false,
          code: LOGIN_APPROVAL_REQUIRED_CODE,
          message: "Another device is trying to access your account.",
          loginAttemptId: attemptId,
          attemptToken,
          retryAfterSeconds: Math.max(
            1,
            Math.floor((loginAttempt.expiresAt.getTime() - Date.now()) / 1000)
          ),
        });
      }

      const { accessToken, refreshToken, sessionId } = await issueLoginTokens(
        req,
        res,
        {
          principalId,
          role,
          email: user.email,
          sessionId: sameDevice ? activeSession?.sessionId : undefined,
          deviceContext,
        }
      );

      const responseUser = await buildUserResponse(user);

      return res.status(200).json({
        success: true,
        message:
          user.googleId === googleId
            ? "Login successful"
            : "Account created successfully",
        user: responseUser,
        token: accessToken,
        refreshToken,
        sessionId,
      });
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

    const principalId = user._id.toString();
    const role = "patient";
    const lockKey = `${role}:${principalId}`;
    const deviceContext = resolveDeviceContext(req);

    await runWithLoginLock(lockKey, async () => {
      const activeSession = await findLatestActiveSession({ principalId, role });
      const sameDevice = activeSession
        ? isSameDevice(activeSession, deviceContext)
        : false;

      if (activeSession && !sameDevice) {
        const loginAttempt = await createOrReusePendingLoginAttempt({
          principalId,
          role,
          requestedDeviceId: deviceContext.deviceId,
          requestedDeviceInfo: deviceContext.deviceInfo,
          requestedUserAgent: deviceContext.userAgent,
          requestedIp: deviceContext.ipAddress,
          activeSessionId: activeSession.sessionId,
          activeDeviceId: activeSession.deviceId,
        });
        const attemptId = loginAttempt?._id?.toString() || "";
        const attemptToken = signLoginAttemptToken({
          attemptId,
          principalId,
          role,
          deviceId: deviceContext.deviceId,
        });

        emitLoginAttemptEvent({
          sessionId: activeSession.sessionId,
          attemptId,
          requestedDeviceInfo: deviceContext.deviceInfo || deviceContext.userAgent,
          requestedIp: deviceContext.ipAddress,
        });

        return res.status(409).json({
          success: false,
          code: LOGIN_APPROVAL_REQUIRED_CODE,
          message: "Another device is trying to access your account.",
          loginAttemptId: attemptId,
          attemptToken,
          retryAfterSeconds: Math.max(
            1,
            Math.floor((loginAttempt.expiresAt.getTime() - Date.now()) / 1000)
          ),
        });
      }

      const { accessToken, refreshToken, sessionId } = await issueLoginTokens(
        req,
        res,
        {
          principalId,
          role,
          email: user.email,
          sessionId: sameDevice ? activeSession?.sessionId : undefined,
          deviceContext,
        }
      );

      user.lastLogin = new Date();
      await user.save();

      const responseUser = await buildUserResponse(user);

      return res.status(200).json({
        success: true,
        message: "Login successful",
        user: responseUser,
        token: accessToken,
        refreshToken,
        sessionId,
      });
    });
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

    const { accessToken, refreshToken, sessionId } = await issueLoginTokens(
      req,
      res,
      {
      principalId: newDoctor._id.toString(),
      role: "doctor",
      email: newDoctor.email,
      }
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
      token: accessToken,
      refreshToken,
      sessionId,
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

    const principalId = doctor._id.toString();
    const role = "doctor";
    const lockKey = `${role}:${principalId}`;
    const deviceContext = resolveDeviceContext(req);

    await runWithLoginLock(lockKey, async () => {
      const activeSession = await findLatestActiveSession({ principalId, role });
      const sameDevice = activeSession
        ? isSameDevice(activeSession, deviceContext)
        : false;

      if (activeSession && !sameDevice) {
        const loginAttempt = await createOrReusePendingLoginAttempt({
          principalId,
          role,
          requestedDeviceId: deviceContext.deviceId,
          requestedDeviceInfo: deviceContext.deviceInfo,
          requestedUserAgent: deviceContext.userAgent,
          requestedIp: deviceContext.ipAddress,
          activeSessionId: activeSession.sessionId,
          activeDeviceId: activeSession.deviceId,
        });
        const attemptId = loginAttempt?._id?.toString() || "";
        const attemptToken = signLoginAttemptToken({
          attemptId,
          principalId,
          role,
          deviceId: deviceContext.deviceId,
        });

        emitLoginAttemptEvent({
          sessionId: activeSession.sessionId,
          attemptId,
          requestedDeviceInfo: deviceContext.deviceInfo || deviceContext.userAgent,
          requestedIp: deviceContext.ipAddress,
        });

        return res.status(409).json({
          success: false,
          code: LOGIN_APPROVAL_REQUIRED_CODE,
          message: "Another device is trying to access your account.",
          loginAttemptId: attemptId,
          attemptToken,
          retryAfterSeconds: Math.max(
            1,
            Math.floor((loginAttempt.expiresAt.getTime() - Date.now()) / 1000)
          ),
        });
      }

      const { accessToken, refreshToken, sessionId } = await issueLoginTokens(
        req,
        res,
        {
          principalId,
          role,
          email: doctor.email,
          sessionId: sameDevice ? activeSession?.sessionId : undefined,
          deviceContext,
        }
      );

      doctor.lastLogin = new Date();
      await doctor.save();

      return res.status(200).json({
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
        sessionId,
      });
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post("/login-attempts/:attemptId/respond", auth, async (req, res) => {
  try {
    const attemptId = asText(req.params.attemptId);
    const principalId = asText(req.auth?.id);
    const role = normalizeRole(req.auth?.role);
    const decision = asText(req.body?.decision).toLowerCase();
    const normalizedDecision =
      decision === "ok" || decision === "approve"
        ? "approve"
        : decision === "cancel" || decision === "deny"
        ? "deny"
        : "";

    if (!["patient", "doctor"].includes(role) || !principalId) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }
    if (!attemptId) {
      return res
        .status(400)
        .json({ success: false, message: "attemptId is required" });
    }
    if (!normalizedDecision) {
      return res.status(400).json({
        success: false,
        message: "decision must be approve|deny",
      });
    }

    const attempt = await LoginAttempt.findOne({
      _id: attemptId,
      principalId,
      role,
      status: "pending",
    });

    if (!attempt) {
      return res.status(404).json({
        success: false,
        message: "Login attempt not found or already resolved",
      });
    }

    if (attempt.expiresAt <= new Date()) {
      attempt.status = "expired";
      await attempt.save();
      return res.status(410).json({
        success: false,
        message: "Login attempt expired",
      });
    }

    const activeSession = await findLatestActiveSession({ principalId, role });
    if (!activeSession || activeSession.sessionId !== asText(attempt.activeSessionId)) {
      return res.status(401).json({
        success: false,
        code: SESSION_INVALID_CODE,
        message: SESSION_INVALID_CODE,
      });
    }

    attempt.respondedAt = new Date();
    if (normalizedDecision === "approve") {
      attempt.status = "approved";
      await attempt.save();

      await revokeActiveSessions({
        principalId,
        role,
        reason: "new_login_approved",
        emitRealtime: true,
      });

      emitLoginApprovedEvent({
        attemptId,
        sessionId: asText(attempt.activeSessionId),
      });

      return res.json({
        success: true,
        status: "approved",
        message: "Login approved",
      });
    }

    attempt.status = "denied";
    await attempt.save();
    emitLoginDeniedEvent({ attemptId });

    return res.json({
      success: true,
      status: "denied",
      message: "Login denied",
    });
  } catch (error) {
    if (error?.name === "CastError") {
      return res
        .status(400)
        .json({ success: false, message: "Invalid attempt id" });
    }
    return res.status(500).json({
      success: false,
      message: "Unable to process login attempt response",
    });
  }
});

router.post("/login-attempts/:attemptId/finalize", async (req, res) => {
  try {
    const attemptId = asText(req.params.attemptId);
    const attemptToken = asText(
      req.body?.attemptToken || req.headers["x-login-attempt-token"] || ""
    );
    if (!attemptId || !attemptToken) {
      return res.status(400).json({
        success: false,
        message: "attemptId and attemptToken are required",
      });
    }

    let tokenPayload;
    try {
      tokenPayload = verifyLoginAttemptToken(attemptToken);
    } catch {
      return res.status(401).json({
        success: false,
        message: "Invalid login attempt token",
      });
    }

    if (
      asText(tokenPayload?.typ) !== "login_attempt" ||
      asText(tokenPayload?.attemptId) !== attemptId
    ) {
      return res.status(401).json({
        success: false,
        message: "Login attempt token mismatch",
      });
    }

    const principalId = asText(tokenPayload?.sub);
    const role = normalizeRole(tokenPayload?.role);
    if (!principalId || !["patient", "doctor"].includes(role)) {
      return res.status(401).json({
        success: false,
        message: "Invalid login attempt token payload",
      });
    }

    const lockKey = `${role}:${principalId}`;
    await runWithLoginLock(lockKey, async () => {
      const attempt = await LoginAttempt.findOne({
        _id: attemptId,
        principalId,
        role,
      });

      if (!attempt) {
        return res.status(404).json({
          success: false,
          message: "Login attempt not found",
        });
      }

      if (attempt.expiresAt <= new Date()) {
        attempt.status = "expired";
        await attempt.save();
        return res.status(410).json({
          success: false,
          message: "Login attempt expired",
        });
      }

      if (attempt.status === "pending") {
        return res.status(409).json({
          success: false,
          code: "LOGIN_APPROVAL_PENDING",
          message: "Waiting for active session approval",
        });
      }

      if (attempt.status === "denied") {
        return res.status(403).json({
          success: false,
          code: "LOGIN_DENIED_BY_ACTIVE_SESSION",
          message: "Login denied by active session",
        });
      }

      if (attempt.status === "consumed") {
        return res.status(409).json({
          success: false,
          message: "Login attempt already consumed",
        });
      }

      if (attempt.status !== "approved") {
        return res.status(409).json({
          success: false,
          message: "Login attempt is not approved",
        });
      }

      const tokenDeviceId = asText(tokenPayload?.deviceId);
      if (tokenDeviceId && tokenDeviceId !== asText(attempt.requestedDeviceId)) {
        return res.status(401).json({
          success: false,
          message: "Login attempt token device mismatch",
        });
      }

      const principal = await resolvePrincipalAccount({ principalId, role });
      if (
        !principal ||
        principal.isActive === false ||
        principal.status === "BLOCKED"
      ) {
        return res.status(403).json({
          success: false,
          message: "Account inactive",
        });
      }

      const deviceContext = resolveDeviceContext(req, {
        deviceId: attempt.requestedDeviceId || tokenDeviceId,
        deviceInfo: attempt.requestedDeviceInfo,
        userAgent: attempt.requestedUserAgent,
        ipAddress: attempt.requestedIp || req.ip || "",
      });

      const { accessToken, refreshToken, sessionId } = await issueLoginTokens(
        req,
        res,
        {
          principalId,
          role,
          email: principal.email,
          deviceContext,
        }
      );

      principal.lastLogin = new Date();
      await principal.save();

      attempt.status = "consumed";
      attempt.consumedAt = new Date();
      await attempt.save();

      if (role === "doctor") {
        return res.json({
          success: true,
          message: "Login successful",
          doctor: {
            id: principal._id.toString(),
            name: principal.name,
            email: principal.email,
            specialization: principal.specialization,
          },
          token: accessToken,
          refreshToken,
          sessionId,
        });
      }

      const responseUser = await buildUserResponse(principal);
      return res.json({
        success: true,
        message: "Login successful",
        user: responseUser,
        token: accessToken,
        refreshToken,
        sessionId,
      });
    });
  } catch (error) {
    if (error?.name === "CastError") {
      return res
        .status(400)
        .json({ success: false, message: "Invalid attempt id" });
    }
    return res.status(500).json({
      success: false,
      message: "Unable to finalize login attempt",
    });
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
    const role = normalizeRole(decoded.role);
    const tokenSessionId = asText(decoded.sid);
    if (!["patient", "doctor"].includes(role)) {
      return res.status(403).json({ success: false, message: "Invalid refresh token role" });
    }

    const stored = await RefreshToken.findOne({
      tokenHash: hashToken(providedRefreshToken),
      revokedAt: null,
      isCurrentSession: { $ne: false },
    });
    if (
      !stored ||
      stored.expiresAt <= new Date() ||
      (tokenSessionId && asText(stored.sessionId) !== tokenSessionId)
    ) {
      return res.status(401).json({
        success: false,
        code: SESSION_INVALID_CODE,
        message: SESSION_INVALID_CODE,
      });
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
      sessionId: asText(stored.sessionId) || tokenSessionId,
    });

    await persistRefreshToken(req, principal._id.toString(), role, refreshToken, refreshMeta, {
      sessionId,
    });

    setAuthCookies(res, { accessToken, refreshToken });
    return res.json({ success: true, token: accessToken, refreshToken, sessionId });
  } catch {
    return res.status(401).json({ success: false, message: "Invalid refresh token" });
  }
});

router.post("/logout", auth, async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const providedRefreshToken = String(
      req.body?.refreshToken || cookies.mv_rt || ""
    ).trim();

    if (providedRefreshToken) {
      const current = await RefreshToken.findOne({
        tokenHash: hashToken(providedRefreshToken),
        revokedAt: null,
      })
        .select("sessionId")
        .lean();
      await RefreshToken.updateOne(
        { tokenHash: hashToken(providedRefreshToken), revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: "logout", isCurrentSession: false } }
      );
      if (asText(current?.sessionId)) {
        emitSessionInvalidatedEvent({
          sessionId: current.sessionId,
          reason: "logout",
        });
      }
    }

    clearAuthCookies(res);
    return res.json({ success: true, message: "Logged out successfully" });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Logout failed" });
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
      sessionId: tokens.sessionId,
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

    const { accessToken, refreshToken, sessionId } = await issueLoginTokens(
      req,
      res,
      {
        principalId: patient._id.toString(),
        role: "patient",
        email: patient.email,
      }
    );

    const responseUser = await buildUserResponse(patient);

    res.json({
      success: true,
      message: "Test patient token generated",
      token: accessToken,
      refreshToken,
      sessionId,
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

    const resolved = await resolveResettableAccountByEmail(email);
    if (!resolved) {
      // Respond generically to avoid user enumeration
      return res.json({ success: true, message: "If your email exists, a reset link has been sent." });
    }

    const { account, role, displayName } = resolved;

    const expiresInMinutes = Number(process.env.RESET_TOKEN_EXPIRES_MIN || 30);
    const resetToken = jwt.sign(
      { userId: account._id, role },
      process.env.JWT_SECRET,
      { expiresIn: `${expiresInMinutes}m` }
    );
    const resetTokenHash = hashToken(resetToken);

    const expiryDate = new Date(Date.now() + expiresInMinutes * 60 * 1000);
    account.resetTokenHash = resetTokenHash;
    account.resetTokenExpiry = expiryDate;
    await account.save();

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
        await sendPasswordResetEmail(
          account.email,
          account.name || displayName,
          resetLink,
          expiresInMinutes
        );
        emailSent = true;
      } else if (transporter.options.auth) {
        await transporter.sendMail({
          from: process.env.MAIL_FROM_SMTP || process.env.MAIL_FROM || process.env.SMTP_USER || "no-reply@medicalvault.app",
          to: account.email,
          subject: `Reset Your HealthVault ${displayName} Password`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #4A90E2;">Password Reset Request</h2>
              <p>Hello ${account.name || displayName},</p>
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
    const resolved = await resolveResettableAccountByTokenPayload(payload);
    if (!resolved) {
      return res.status(400).json({ success: false, message: "Invalid token" });
    }

    const { account } = resolved;
    if (account.resetTokenHash !== hashToken(token)) {
      return res.status(400).json({ success: false, message: "Invalid token" });
    }

    if (!account.resetTokenExpiry || account.resetTokenExpiry.getTime() < Date.now()) {
      return res.status(400).json({ success: false, message: "Token expired" });
    }

    // Set the new password - the pre-save hook will hash it automatically
    account.password = newPassword;
    account.resetTokenHash = null;
    account.resetTokenExpiry = null;
    await account.save();

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

