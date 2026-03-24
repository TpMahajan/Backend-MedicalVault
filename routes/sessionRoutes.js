import express from "express";
import mongoose from "mongoose";
import { auth } from "../middleware/auth.js";
import { Session } from "../models/Session.js";
import { User } from "../models/User.js";
import { DoctorUser } from "../models/DoctorUser.js";
import { Appointment } from "../models/Appointment.js";
import { DirectMessage } from "../models/DirectMessage.js";
import { sendNotification, sendNotificationToDoctor } from "../utils/notifications.js";
import { persistSessionHistory } from "../services/sessionHistoryPersistence.js";
import { BUCKET_NAME } from "../config/s3.js";
import { generateSignedUrl } from "../utils/s3Utils.js";
import { RefreshToken } from "../models/RefreshToken.js";

const router = express.Router();
const ENABLE_DEBUG_ROUTES =
  String(process.env.ENABLE_DEBUG_ROUTES || "false").toLowerCase() === "true";
const hasAWSCredentials =
  !!process.env.AWS_ACCESS_KEY_ID && !!process.env.AWS_SECRET_ACCESS_KEY;

const asText = (value) => (value == null ? "" : String(value).trim());

const resolveDoctorSpecialization = (doctor) =>
  asText(doctor?.specialization || doctor?.specialty);

const isValidObjectId = (value) =>
  mongoose.Types.ObjectId.isValid(asText(value));

const asObjectId = (value) => new mongoose.Types.ObjectId(asText(value));

const normalizeMinutes = (value, fallback = 20) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(5, Math.min(120, parsed));
};

const resolveParticipantName = (participant, fallback) => {
  const fromProfile = asText(participant?.name);
  const fromFallback = asText(fallback);
  if (fromProfile) return fromProfile;
  if (fromFallback) return fromFallback;
  return "User";
};

const resolveAllowMultiSession = async ({ role, principalId }) => {
  if (role === "doctor") {
    const doctor = await DoctorUser.findById(principalId)
      .select("securitySettings.allowMultiSession")
      .lean();
    return doctor?.securitySettings?.allowMultiSession !== false;
  }

  const user = await User.findById(principalId)
    .select("securitySettings.allowMultiSession")
    .lean();
  return user?.securitySettings?.allowMultiSession !== false;
};

const updateAllowMultiSession = async ({ role, principalId, allowMultiSession }) => {
  if (role === "doctor") {
    const updated = await DoctorUser.findByIdAndUpdate(
      principalId,
      { $set: { "securitySettings.allowMultiSession": allowMultiSession } },
      { new: true, runValidators: true }
    )
      .select("securitySettings.allowMultiSession")
      .lean();
    return updated?.securitySettings?.allowMultiSession !== false;
  }

  const updated = await User.findByIdAndUpdate(
    principalId,
    { $set: { "securitySettings.allowMultiSession": allowMultiSession } },
    { new: true, runValidators: true }
  )
    .select("securitySettings.allowMultiSession")
    .lean();
  return updated?.securitySettings?.allowMultiSession !== false;
};

const resolveDoctorAvatarUrl = async (doctor) => {
  const raw =
    asText(
      doctor?.profilePictureUrl ||
        doctor?.profilePicture ||
        doctor?.avatarUrl ||
        doctor?.avatar
    ) || "";
  if (!raw) return "";

  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/uploads/")) {
    const baseUrl = process.env.API_BASE_URL || "http://localhost:5000";
    return `${baseUrl}${raw}`;
  }

  if (!hasAWSCredentials) return "";
  try {
    return await generateSignedUrl(raw, BUCKET_NAME);
  } catch {
    return "";
  }
};

const buildDoctorSummary = async (doctor) => {
  if (!doctor) {
    return {
      _id: null,
      name: "Doctor",
      email: "",
      mobile: "",
      profilePicture: null,
      profilePictureUrl: null,
      avatar: "",
      avatarUrl: null,
      experience: "",
      specialization: "",
      specialty: "",
      memberSince: null,
      chatUrl: "",
    };
  }

  const avatarUrl = await resolveDoctorAvatarUrl(doctor);
  const specialization = resolveDoctorSpecialization(doctor);
  const rawAvatar =
    asText(doctor.profilePicture || doctor.profilePictureUrl || doctor.avatar) ||
    "";

  return {
    _id: doctor._id ?? null,
    name: asText(doctor.name) || "Doctor",
    email: asText(doctor.email),
    mobile: asText(doctor.mobile || doctor.phone),
    profilePicture: avatarUrl || rawAvatar || null,
    profilePictureUrl: avatarUrl || rawAvatar || null,
    avatar: rawAvatar,
    avatarUrl: avatarUrl || null,
    experience: asText(doctor.experience),
    specialization,
    specialty: specialization,
    memberSince: doctor.createdAt || null,
    chatUrl: asText(doctor.chatUrl || doctor.chatDeepLink),
  };
};

const resolveDoctorPatientLink = async ({ doctorId, patientId }) => {
  if (!isValidObjectId(doctorId) || !isValidObjectId(patientId)) {
    return {
      linkedSession: null,
      linkedAppointment: null,
      relationType: "",
      relationId: "",
    };
  }

  const normalizedDoctorId = asText(doctorId);
  const normalizedPatientId = asText(patientId);
  const patientIdVariants = [normalizedPatientId];

  const linkedSession = await Session.findOne({
    doctorId: normalizedDoctorId,
    patientId: normalizedPatientId,
    status: { $in: ["pending", "accepted", "ended", "declined"] },
  })
    .sort({ createdAt: -1 })
    .select("_id status createdAt")
    .lean();

  const linkedAppointment = linkedSession
    ? null
    : await Appointment.findOne({
        doctorId: normalizedDoctorId,
        patientId: { $in: patientIdVariants },
      })
        .sort({ appointmentDate: -1, createdAt: -1 })
        .select("_id appointmentDate createdAt")
        .lean();

  return {
    linkedSession,
    linkedAppointment,
    relationType: linkedSession
      ? "session"
      : linkedAppointment
      ? "appointment"
      : "",
    relationId: linkedSession
      ? linkedSession._id.toString()
      : linkedAppointment
      ? linkedAppointment._id.toString()
      : "",
  };
};

const sendDirectMessageToRecipient = async ({
  recipientRole,
  recipientId,
  title,
  body,
  payload,
}) => {
  if (recipientRole === "doctor") {
    await sendNotificationToDoctor(recipientId, title, body, payload);
    return;
  }
  await sendNotification(recipientId, title, body, payload);
};

const dispatchDirectMessage = async ({
  senderRole,
  senderId,
  counterpartId,
  message,
  sessionId,
  senderName,
  counterpartName,
}) => {
  const normalizedSenderRole = asText(senderRole).toLowerCase();
  const normalizedSenderId = asText(senderId);
  const normalizedCounterpartId = asText(counterpartId);
  const normalizedMessage = asText(message);
  const normalizedSessionId = asText(sessionId);

  if (!["doctor", "patient"].includes(normalizedSenderRole)) {
    return {
      success: false,
      status: 403,
      message: "Only doctors or patients can send direct messages.",
    };
  }

  if (!normalizedCounterpartId || !normalizedMessage) {
    return {
      success: false,
      status: 400,
      message: "counterpartId and message are required.",
    };
  }

  if (!isValidObjectId(normalizedSenderId) || !isValidObjectId(normalizedCounterpartId)) {
    return {
      success: false,
      status: 400,
      message: "Invalid sender or recipient identifier.",
    };
  }

  let doctorId = "";
  let patientId = "";
  let recipientRole = "";
  let recipientId = "";

  if (normalizedSenderRole === "doctor") {
    doctorId = normalizedSenderId;
    patientId = normalizedCounterpartId;
    recipientRole = "patient";
    recipientId = patientId;
  } else {
    patientId = normalizedSenderId;
    doctorId = normalizedCounterpartId;
    recipientRole = "doctor";
    recipientId = doctorId;
  }

  const relation = await resolveDoctorPatientLink({ doctorId, patientId });
  if (!relation.linkedSession && !relation.linkedAppointment) {
    return {
      success: false,
      status: 403,
      message:
        "Direct chat is allowed only between connected doctor-patient pairs.",
    };
  }

  const resolvedSessionId =
    normalizedSessionId ||
    relation.relationId ||
    "";

  const directMessage = await DirectMessage.create({
    doctorId: asObjectId(doctorId),
    patientId: asObjectId(patientId),
    ...(isValidObjectId(resolvedSessionId)
      ? { sessionId: asObjectId(resolvedSessionId) }
      : {}),
    senderRole: normalizedSenderRole,
    senderId: asObjectId(normalizedSenderId),
    recipientRole,
    recipientId: asObjectId(recipientId),
    message: normalizedMessage,
    readByRecipient: false,
    metadata: {
      relationType: relation.relationType || "session",
    },
  });

  const { Notification } = await import("../models/Notification.js");
  const { broadcastNotification } = await import(
    "../controllers/notificationController.js"
  );

  const finalSenderName = resolveParticipantName(
    { name: senderName },
    normalizedSenderRole === "doctor" ? "Doctor" : "Patient"
  );
  const finalCounterpartName = resolveParticipantName(
    { name: counterpartName },
    normalizedSenderRole === "doctor" ? "Patient" : "Doctor"
  );

  const notificationTitle = `New message from ${finalSenderName}`;
  const notificationPayload = {
    type: "DIRECT_MESSAGE",
    messageId: directMessage._id.toString(),
    doctorId,
    patientId,
    sessionId: resolvedSessionId,
    relationType: relation.relationType || "session",
    senderRole: normalizedSenderRole,
    senderId: normalizedSenderId,
    senderName: finalSenderName,
    counterpartId: normalizedSenderId,
    counterpartRole: normalizedSenderRole,
    recipientRole,
  };

  const notification = await Notification.create({
    title: notificationTitle,
    body: normalizedMessage,
    type: "session",
    data: notificationPayload,
    recipientId: asObjectId(recipientId),
    recipientRole,
    senderId: asObjectId(normalizedSenderId),
    senderRole: normalizedSenderRole,
  });

  await sendDirectMessageToRecipient({
    recipientRole,
    recipientId,
    title: notificationTitle,
    body: normalizedMessage,
    payload: notificationPayload,
  });

  await broadcastNotification(notification);

  return {
    success: true,
    status: 200,
    relationType: relation.relationType || "session",
    relationId: relation.relationId,
    chatMessage: {
      id: directMessage._id.toString(),
      doctorId,
      patientId,
      sessionId: resolvedSessionId,
      senderRole: normalizedSenderRole,
      senderId: normalizedSenderId,
      message: normalizedMessage,
      createdAt: directMessage.createdAt,
      readByRecipient: directMessage.readByRecipient,
    },
    notificationId: notification._id.toString(),
    counterpartName: finalCounterpartName,
  };
};

// Health check endpoint (no auth required)
router.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "Session routes are working",
    timestamp: new Date().toISOString(),
    sessionModel: Session ? "loaded" : "not loaded"
  });
});

// Test database connection (debug-only)
router.get("/db-test", async (req, res) => {
  if (!ENABLE_DEBUG_ROUTES) {
    return res.status(404).json({ success: false, message: "Not found" });
  }
  try {
    // Test if we can create a simple session object (without saving)
    const testSessionData = {
      doctorId: "507f1f77bcf86cd799439011",
      patientId: "507f1f77bcf86cd799439012",
      requestMessage: "DB connection test",
      status: "pending",
      expiresAt: new Date(Date.now() + 20 * 60 * 1000)
    };

    const testSession = new Session(testSessionData);
    console.log('🧪 Test session object created:', testSession);

    res.json({
      success: true,
      message: "Database connection and Session model working",
      testSession: {
        doctorId: testSession.doctorId,
        patientId: testSession.patientId,
        status: testSession.status,
        expiresAt: testSession.expiresAt
      }
    });
  } catch (error) {
    console.error('❌ DB test error:', error);
    res.status(500).json({
      success: false,
      message: "Database test failed",
      error: error.message
    });
  }
});

// ---------------- Doctor Requests Access ----------------
// POST /api/sessions/request
router.post("/request", auth, async (req, res) => {
  try {
    console.log('📋 Session request received:', {
      body: req.body,
      authId: req.auth?.id,
      authRole: req.auth?.role,
      hasAuth: !!req.auth,
      headers: req.headers.authorization ? 'Present' : 'Missing',
      token: req.headers.authorization ? req.headers.authorization.substring(0, 20) + '...' : 'None'
    });

    const { patientId, requestMessage } = req.body;

    if (!req.auth || req.auth.role !== "doctor") {
      console.log('🚫 Session request denied - invalid role or no auth:', {
        hasAuth: !!req.auth,
        role: req.auth?.role,
        authId: req.auth?.id
      });
      return res.status(403).json({
        success: false,
        message: "Only doctors can request access",
      });
    }

    const doctor = await DoctorUser.findById(req.auth.id);
    if (doctor && doctor.isActive === false) {
      console.log('🚫 Session request denied - doctor profile is inactive:', req.auth.id);
      return res.status(403).json({
        success: false,
        message: "Your profile is currently inactive. Please activate your profile in Settings to attend sessions."
      });
    }

    // Validate required fields
    if (!patientId) {
      console.log('🚫 Session request denied - missing patientId');
      return res.status(400).json({
        success: false,
        message: "Patient ID is required"
      });
    }

    console.log('🔍 Looking for patient:', patientId);

    // Check if patient exists
    const patient = await User.findById(patientId);
    if (!patient) {
      console.log('🚫 Patient not found:', patientId);
      return res.status(404).json({
        success: false,
        message: "Patient not found",
        debug: {
          patientId: patientId
        }
      });
    }

    console.log('✅ Patient found:', patient.name, patient.email);

    // Persist doctor-patient relationship so Patient Manager keeps historical records.
    try {
      await DoctorUser.findByIdAndUpdate(
        req.auth.id,
        { $addToSet: { linkedPatients: patientId } },
        { new: false }
      );
    } catch (linkError) {
      console.error("⚠️ Failed to persist doctor-patient link:", linkError.message);
    }

    // Archive any existing active/pending sessions for the same doctor-patient pair.
    // ─────────────────────────────────────────────────────────────────────────
    // ARCHIVE previous active/pending sessions for this doctor-patient pair.
    //
    // IMPORTANT: We NEVER delete sessions. We set status="ended" so they appear
    // in Session History. All existing diagnosis/notes are PRESERVED as-is.
    // ─────────────────────────────────────────────────────────────────────────
    console.log('🔍 Checking for existing sessions between doctor', req.auth.id, 'and patient', patientId);
    const existingSessions = await Session.find({
      doctorId: req.auth.id,
      patientId: patientId,
      status: { $in: ["pending", "accepted"] }
    });

    if (existingSessions.length > 0) {
      console.log(`📦 Archiving ${existingSessions.length} existing session(s) — data preserved, NOT deleted`);
      const archiveTime = new Date();
      for (const oldSession of existingSessions) {
        const preservedDiagnosis =
          oldSession.diagnosis && oldSession.diagnosis.trim() !== ""
            ? oldSession.diagnosis
            : "Previous Visit";

        await persistSessionHistory(Session, {
          sessionId: oldSession._id,
          doctorId: oldSession.doctorId,
          patientId: oldSession.patientId,
          diagnosis: preservedDiagnosis,
          notes: oldSession.notes,
          endedAt: oldSession.endedAt || archiveTime,
        });
        console.log(`  ✅ Archived session ${oldSession._id} | diagnosis preserved: "${preservedDiagnosis}"`);
      }
    }

    console.log('✅ Ready to create new session (old sessions safely archived if any)');

    // Create new session request
    const requestLabel = requestMessage || "";

    console.log('🔄 Creating session with data:', {
      doctorId: req.auth.id,
      patientId: patientId,
      requestMessage: requestLabel,
      status: "pending"
    });

    const session = new Session({
      doctorId: req.auth.id,
      patientId: patientId,
      requestMessage: requestLabel,
      status: "pending",
      expiresAt: new Date(Date.now() + 20 * 60 * 1000) // Explicitly set expiration
    });

    console.log('💾 Saving session to database...');
    await session.save();
    console.log('✅ Session saved with ID:', session._id);

    // Populate doctor info for response if exists
    console.log('🔄 Populating doctor info...');
    await session.populate(
      "doctorId",
      "name email mobile avatar profilePicture profilePictureUrl experience specialty specialization createdAt chatUrl chatDeepLink"
    );
    console.log(`📋 New session request: Dr. ${session.doctorId.name} → Patient ${patientId}`);

    // Send notification to patient about the new session request
    try {
      const doctorName = session.doctorId.name;
      const doctorIdForNotif = session.doctorId._id.toString();

      // Create notification record in database
      const { Notification } = await import('../models/Notification.js');
      const notification = new Notification({
        title: "New Session Request",
        body: `${doctorName} is requesting access to your medical records`,
        type: "session",
        data: {
          sessionId: session._id.toString(),
          doctorId: doctorIdForNotif,
          doctorName: doctorName
        },
        recipientId: patientId,
        recipientRole: "patient",
        senderId: doctorIdForNotif,
        senderRole: "doctor"
      });
      await notification.save();

      // Send push notification
      await sendNotification(
        patientId,
        "New Session Request",
        `${doctorName} is requesting access to your medical records`,
        {
          type: "SESSION_REQUEST",
          sessionId: session._id.toString(),
          doctorId: doctorIdForNotif,
          doctorName: doctorName
        }
      );

      // Broadcast to SSE connections
      const { broadcastNotification } = await import('../controllers/notificationController.js');
      await broadcastNotification(notification);

      console.log('✅ Session request notification created and sent');
    } catch (notificationError) {
      console.error("❌ Failed to send session request notification:", notificationError);
      // Don't fail the request if notification fails
    }

    res.status(201).json({
      success: true,
      message: "Access request sent successfully",
      session: session,
      doctorLabel: `Dr. ${session.doctorId.name}`
    });

  } catch (error) {
    console.error("Session request error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create session request",
      error: error.message
    });
  }
});

// ---------------- Get Session Status (for polling) ----------------
// GET /api/sessions/:id/status
router.get("/:id/status", auth, async (req, res) => {
  try {
    const sessionId = req.params.id;

    const session = await Session.findById(sessionId)
      .populate(
        "doctorId",
        "name email mobile avatar profilePicture profilePictureUrl experience specialty specialization createdAt chatUrl chatDeepLink"
      )
      .populate('patientId', 'name email');

    if (!session) {
      return res.status(404).json({
        success: false,
        message: "Session not found"
      });
    }

    // Check if requester is authorized to view this session
    const role = asText(req.auth?.role).toLowerCase();
    const isDoctor =
      role === "doctor" &&
      session.doctorId &&
      session.doctorId._id.toString() === req.auth.id.toString();
    const isPatient =
      role === "patient" &&
      session.patientId._id.toString() === req.auth.id.toString();
    const isPrivileged = role === "admin" || role === "superadmin";

    if (!isDoctor && !isPatient && !isPrivileged) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized to view this session"
      });
    }

    // Check if session has expired
    const isExpired = session.expiresAt <= new Date();
    const actualStatus = isExpired ? "expired" : session.status;
    const doctorSummary = session.doctorId
      ? await buildDoctorSummary(session.doctorId)
      : null;

    res.json({
      success: true,
      session: {
        _id: session._id,
        status: actualStatus,
        expiresAt: session.expiresAt,
        createdAt: session.createdAt,
        respondedAt: session.respondedAt,
        isExpired: isExpired,
        timeRemaining: isExpired ? 0 : Math.max(0, Math.floor((session.expiresAt - new Date()) / 1000)),
        doctor: doctorSummary,
        patient: {
          name: session.patientId.name,
          email: session.patientId.email
        }
      }
    });

  } catch (error) {
    console.error("Session status error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get session status",
      error: error.message
    });
  }
});

// All other routes require authentication
router.use(auth);

// ---------------- Device Sessions (Patient/Doctor) ----------------
// GET /api/sessions/settings -> get device-session policy for current account
router.get("/settings", async (req, res) => {
  try {
    const role = asText(req.auth?.role).toLowerCase();
    const principalId = asText(req.auth?.id);
    if (!["patient", "doctor"].includes(role) || !principalId) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const allowMultiSession = await resolveAllowMultiSession({ role, principalId });
    return res.json({ success: true, allowMultiSession });
  } catch {
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch session settings" });
  }
});

// PUT /api/sessions/settings -> update device-session policy for current account
router.put("/settings", async (req, res) => {
  try {
    const role = asText(req.auth?.role).toLowerCase();
    const principalId = asText(req.auth?.id);
    if (!["patient", "doctor"].includes(role) || !principalId) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const allowMultiSession = req.body?.allowMultiSession;
    if (typeof allowMultiSession !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "allowMultiSession must be a boolean",
      });
    }

    const persistedValue = await updateAllowMultiSession({
      role,
      principalId,
      allowMultiSession,
    });

    let revokedCount = 0;
    if (persistedValue === false) {
      const activeTokens = await RefreshToken.find({
        principalId,
        role,
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      })
        .sort({ lastActiveAt: -1, createdAt: -1 })
        .select("_id")
        .lean();

      if (activeTokens.length > 1) {
        const keepTokenId = activeTokens[0]?._id;
        const revokeResult = await RefreshToken.updateMany(
          {
            principalId,
            role,
            revokedAt: null,
            _id: { $ne: keepTokenId },
          },
          { $set: { revokedAt: new Date(), revokedReason: "single_session_enforced" } }
        );
        revokedCount = revokeResult.modifiedCount || 0;
      }
    }

    return res.json({
      success: true,
      allowMultiSession: persistedValue,
      revokedCount,
      message:
        persistedValue
          ? "Multi-device sessions enabled"
          : "Single-device session mode enabled",
    });
  } catch {
    return res
      .status(500)
      .json({ success: false, message: "Failed to update session settings" });
  }
});

// GET /api/sessions -> list current user's auth device sessions
router.get("/", async (req, res) => {
  try {
    const role = asText(req.auth?.role).toLowerCase();
    const principalId = asText(req.auth?.id);
    if (!["patient", "doctor"].includes(role) || !principalId) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const rows = await RefreshToken.find({
      principalId,
      role,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    })
      .sort({ lastActiveAt: -1, createdAt: -1 })
      .select("jti createdByIp userAgent deviceInfo lastActiveAt createdAt expiresAt")
      .lean();

    const sessions = rows.map((row) => ({
      id: row._id?.toString(),
      sessionId: row._id?.toString(),
      jti: row.jti || "",
      ipAddress: row.createdByIp || "",
      userAgent: row.userAgent || "",
      deviceInfo: row.deviceInfo || "",
      lastActiveAt: row.lastActiveAt || row.updatedAt || row.createdAt,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    }));

    return res.json({ success: true, sessions, count: sessions.length });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to fetch sessions" });
  }
});

// DELETE /api/sessions/:id -> logout one device session
router.delete("/:id", async (req, res) => {
  try {
    const role = asText(req.auth?.role).toLowerCase();
    const principalId = asText(req.auth?.id);
    if (!["patient", "doctor"].includes(role) || !principalId) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const sessionId = asText(req.params.id);
    if (!isValidObjectId(sessionId)) {
      return res.status(400).json({ success: false, message: "Invalid session id" });
    }

    const updated = await RefreshToken.updateOne(
      {
        _id: sessionId,
        principalId,
        role,
        revokedAt: null,
      },
      { $set: { revokedAt: new Date(), revokedReason: "device_logout" } }
    );

    if (!updated.matchedCount) {
      return res.status(404).json({ success: false, message: "Session not found" });
    }
    return res.json({ success: true, message: "Device session logged out" });
  } catch {
    return res.status(500).json({ success: false, message: "Failed to logout session" });
  }
});

// DELETE /api/sessions -> logout all device sessions
router.delete("/", async (req, res) => {
  try {
    const role = asText(req.auth?.role).toLowerCase();
    const principalId = asText(req.auth?.id);
    if (!["patient", "doctor"].includes(role) || !principalId) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    const now = new Date();
    const result = await RefreshToken.updateMany(
      {
        principalId,
        role,
        revokedAt: null,
      },
      { $set: { revokedAt: now, revokedReason: "logout_all_devices" } }
    );

    return res.json({
      success: true,
      message: "All device sessions logged out",
      revokedCount: result.modifiedCount || 0,
    });
  } catch {
    return res.status(500).json({ success: false, message: "Failed to logout all sessions" });
  }
});

// ---------------- Direct Chat Threads ----------------
// GET /api/sessions/chat/threads
router.get("/chat/threads", async (req, res) => {
  try {
    const role = asText(req.auth?.role).toLowerCase();
    const authId = asText(req.auth?.id);

    if (!["doctor", "patient"].includes(role)) {
      return res.status(403).json({
        success: false,
        message: "Only doctors and patients can view chat threads.",
      });
    }

    if (!isValidObjectId(authId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid user identifier.",
      });
    }

    const authObjectId = asObjectId(authId);
    const isDoctor = role === "doctor";
    const counterpartField = isDoctor ? "$patientId" : "$doctorId";
    const matchStage = isDoctor
      ? { doctorId: authObjectId }
      : { patientId: authObjectId };

    const threadsRaw = await DirectMessage.aggregate([
      { $match: matchStage },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: counterpartField,
          doctorId: { $first: "$doctorId" },
          patientId: { $first: "$patientId" },
          lastMessage: { $first: "$message" },
          lastSenderRole: { $first: "$senderRole" },
          lastAt: { $first: "$createdAt" },
          unreadCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$recipientRole", role] },
                    { $eq: ["$recipientId", authObjectId] },
                    { $eq: ["$readByRecipient", false] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
      { $sort: { lastAt: -1 } },
      { $limit: 200 },
    ]);

    const counterpartIds = threadsRaw
      .map((thread) => asText(thread?._id))
      .filter(Boolean)
      .filter((id) => isValidObjectId(id));

    const counterpartDocs = isDoctor
      ? await User.find({ _id: { $in: counterpartIds } })
          .select("name email mobile profilePicture")
          .lean()
      : await DoctorUser.find({ _id: { $in: counterpartIds } })
          .select("name email mobile avatar profilePicture profilePictureUrl specialty")
          .lean();

    const counterpartById = new Map(
      counterpartDocs.map((entry) => [entry._id.toString(), entry])
    );

    const threads = await Promise.all(
      threadsRaw.map(async (thread) => {
        const counterpartId = asText(thread?._id);
        const counterpart = counterpartById.get(counterpartId) || {};
        const counterpartAvatar = isDoctor
          ? asText(counterpart?.profilePicture)
          : await resolveDoctorAvatarUrl(counterpart);

        return {
          counterpartId,
          counterpartRole: isDoctor ? "patient" : "doctor",
          counterpartName: resolveParticipantName(
            counterpart,
            isDoctor ? "Patient" : "Doctor"
          ),
          counterpartEmail: asText(counterpart?.email),
          counterpartMobile: asText(counterpart?.mobile),
          counterpartAvatar,
          doctorId: asText(thread?.doctorId),
          patientId: asText(thread?.patientId),
          lastMessage: asText(thread?.lastMessage),
          lastSenderRole: asText(thread?.lastSenderRole).toLowerCase(),
          lastAt: thread?.lastAt || null,
          unreadCount: Number(thread?.unreadCount || 0),
        };
      })
    );

    return res.json({
      success: true,
      count: threads.length,
      threads,
    });
  } catch (error) {
    console.error("Fetch chat threads error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch chat threads",
      error: error.message,
    });
  }
});

// ---------------- Direct Chat Messages ----------------
// GET /api/sessions/chat/messages/:counterpartId
router.get("/chat/messages/:counterpartId", async (req, res) => {
  try {
    const role = asText(req.auth?.role).toLowerCase();
    const authId = asText(req.auth?.id);
    const counterpartId = asText(req.params.counterpartId);
    const limit = Math.max(
      1,
      Math.min(500, Number.parseInt(req.query.limit, 10) || 200)
    );

    if (!["doctor", "patient"].includes(role)) {
      return res.status(403).json({
        success: false,
        message: "Only doctors and patients can view chat messages.",
      });
    }

    if (!isValidObjectId(authId) || !isValidObjectId(counterpartId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid chat participant identifier.",
      });
    }

    const doctorId = role === "doctor" ? authId : counterpartId;
    const patientId = role === "doctor" ? counterpartId : authId;

    const relation = await resolveDoctorPatientLink({ doctorId, patientId });
    if (!relation.linkedSession && !relation.linkedAppointment) {
      return res.status(403).json({
        success: false,
        message: "You can only access chats for linked doctor-patient pairs.",
      });
    }

    const docs = await DirectMessage.find({
      doctorId: asObjectId(doctorId),
      patientId: asObjectId(patientId),
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const messages = docs.reverse().map((entry) => ({
      id: entry._id.toString(),
      doctorId: asText(entry.doctorId),
      patientId: asText(entry.patientId),
      sessionId: asText(entry.sessionId),
      senderRole: asText(entry.senderRole).toLowerCase(),
      senderId: asText(entry.senderId),
      recipientRole: asText(entry.recipientRole).toLowerCase(),
      recipientId: asText(entry.recipientId),
      message: asText(entry.message),
      createdAt: entry.createdAt,
      readByRecipient: entry.readByRecipient === true,
      readAt: entry.readAt || null,
    }));

    await DirectMessage.updateMany(
      {
        doctorId: asObjectId(doctorId),
        patientId: asObjectId(patientId),
        recipientRole: role,
        recipientId: asObjectId(authId),
        readByRecipient: false,
      },
      {
        $set: {
          readByRecipient: true,
          readAt: new Date(),
        },
      }
    );

    return res.json({
      success: true,
      relationType: relation.relationType || "session",
      relationId: relation.relationId || "",
      count: messages.length,
      messages,
    });
  } catch (error) {
    console.error("Fetch chat messages error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch chat messages",
      error: error.message,
    });
  }
});

// ---------------- Send Direct Message ----------------
// POST /api/sessions/chat/send
router.post("/chat/send", async (req, res) => {
  try {
    const role = asText(req.auth?.role).toLowerCase();
    const counterpartId = asText(
      req.body.counterpartId || req.body.doctorId || req.body.patientId
    );
    const text = asText(req.body.message);
    const sessionId = asText(req.body.sessionId);

    const senderProfile =
      role === "doctor"
        ? await DoctorUser.findById(req.auth.id).select("name email").lean()
        : await User.findById(req.auth.id).select("name email").lean();

    const counterpartProfile =
      role === "doctor"
        ? await User.findById(counterpartId).select("name email").lean()
        : await DoctorUser.findById(counterpartId).select("name email").lean();

    if (!counterpartProfile) {
      return res.status(404).json({
        success: false,
        message:
          role === "doctor" ? "Patient not found" : "Doctor not found",
      });
    }

    const dispatch = await dispatchDirectMessage({
      senderRole: role,
      senderId: req.auth.id,
      counterpartId,
      message: text,
      sessionId,
      senderName: resolveParticipantName(senderProfile, role),
      counterpartName: resolveParticipantName(
        counterpartProfile,
        role === "doctor" ? "Patient" : "Doctor"
      ),
    });

    if (!dispatch.success) {
      return res.status(dispatch.status || 400).json({
        success: false,
        message: dispatch.message || "Failed to send direct message",
      });
    }

    return res.json({
      success: true,
      message: "Message sent successfully",
      relationType: dispatch.relationType,
      relationId: dispatch.relationId,
      notificationId: dispatch.notificationId,
      chatMessage: dispatch.chatMessage,
    });
  } catch (error) {
    console.error("Send direct chat message error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to send direct message",
      error: error.message,
    });
  }
});

// ---------------- Legacy Patient Chat Endpoint ----------------
// POST /api/sessions/chat-doctor
router.post("/chat-doctor", async (req, res) => {
  try {
    if (req.auth?.role !== "patient") {
      return res.status(403).json({
        success: false,
        message: "Only patients can send doctor messages",
      });
    }

    const doctorId = asText(req.body.doctorId);
    const doctorName = asText(req.body.doctorName);
    const text = asText(req.body.message);
    const sessionId = asText(req.body.sessionId);

    const dispatch = await dispatchDirectMessage({
      senderRole: "patient",
      senderId: req.auth.id,
      counterpartId: doctorId,
      message: text,
      sessionId,
      senderName: resolveParticipantName(req.user, "Patient"),
      counterpartName: doctorName || "Doctor",
    });

    if (!dispatch.success) {
      return res.status(dispatch.status || 400).json({
        success: false,
        message: dispatch.message || "Failed to send message to doctor",
      });
    }

    return res.json({
      success: true,
      message: `Message sent to Dr. ${dispatch.counterpartName}`,
      notificationId: dispatch.notificationId,
      chatMessage: dispatch.chatMessage,
    });
  } catch (error) {
    console.error("Chat doctor error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to send message to doctor",
      error: error.message,
    });
  }
});

// ---------------- Patient Fetches Pending Requests ----------------
// GET /api/sessions/requests
router.get("/requests", async (req, res) => {
  try {
    // Ensure the requester is a patient/user
    if (req.auth.role !== "patient" && !req.user) {
      return res.status(403).json({
        success: false,
        message: "Only patients can view session requests"
      });
    }

    // Clean up expired sessions first
    await Session.cleanExpiredSessions();

    // Fetch pending requests for this patient
    const requests = await Session.find({
      patientId: req.auth.id,
      status: "pending",
      expiresAt: { $gt: new Date() }
    })
      .populate(
        "doctorId",
        "name email mobile avatar profilePicture profilePictureUrl experience specialty specialization createdAt chatUrl chatDeepLink"
      )
      .sort({ createdAt: -1 }); // Most recent first

    console.log(`📋 Found ${requests.length} pending requests for patient ${req.auth.id}`);

    const requestPayload = await Promise.all(
      requests.map(async (session) => ({
        _id: session._id,
        doctor: await buildDoctorSummary(session.doctorId),
        requestMessage: session.requestMessage,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        status: session.status,
      }))
    );

    res.json({
      success: true,
      count: requests.length,
      requests: requestPayload,
    });

  } catch (error) {
    console.error("Fetch requests error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch session requests",
      error: error.message
    });
  }
});

// ---------------- Patient Fetches Pending Session Extension Requests ----------------
// GET /api/sessions/extension-requests
router.get("/extension-requests", async (req, res) => {
  try {
    if (req.auth.role !== "patient") {
      return res.status(403).json({
        success: false,
        message: "Only patients can view extension requests",
      });
    }

    await Session.cleanExpiredSessions();

    const sessions = await Session.find({
      patientId: req.auth.id,
      status: "accepted",
      expiresAt: { $gt: new Date() },
      "extensionRequest.status": "pending",
    })
      .populate(
        "doctorId",
        "name email mobile avatar profilePicture profilePictureUrl experience specialty specialization createdAt chatUrl chatDeepLink"
      )
      .sort({ "extensionRequest.requestedAt": -1, createdAt: -1 });

    const requests = await Promise.all(
      sessions.map(async (session) => ({
        sessionId: session._id.toString(),
        doctor: await buildDoctorSummary(session.doctorId),
        minutes: Number(session.extensionRequest?.minutes || 20),
        requestedAt:
          session.extensionRequest?.requestedAt || session.updatedAt || session.createdAt,
        currentExpiresAt: session.expiresAt,
      }))
    );

    return res.json({
      success: true,
      count: requests.length,
      requests,
    });
  } catch (error) {
    console.error("Fetch extension requests error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch extension requests",
      error: error.message,
    });
  }
});

// ---------------- Patient Responds to Request ----------------
// POST /api/sessions/:id/respond
router.post("/:id/respond", async (req, res) => {
  try {
    const { status } = req.body;
    const sessionId = req.params.id;

    // Validate status
    if (!status || !["accepted", "declined"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Status must be 'accepted' or 'declined'"
      });
    }

    // Find the session
    const session = await Session.findById(sessionId)
      .populate(
        "doctorId",
        "name email mobile avatar profilePicture profilePictureUrl experience specialty specialization createdAt chatUrl chatDeepLink"
      );

    if (!session) {
      return res.status(404).json({
        success: false,
        message: "Session request not found"
      });
    }

    // Ensure the session belongs to the authenticated patient
    if (session.patientId.toString() !== req.auth.id.toString()) {
      return res.status(403).json({
        success: false,
        message: "You can only respond to your own session requests"
      });
    }

    // Check if session is still pending
    if (session.status !== "pending") {
      return res.status(409).json({
        success: false,
        message: `Session request has already been ${session.status}`
      });
    }

    // Check if session hasn't expired
    if (session.expiresAt <= new Date()) {
      return res.status(410).json({
        success: false,
        message: "Session request has expired"
      });
    }

    // Update session status
    console.log('🔄 Updating session status:', {
      sessionId: sessionId,
      oldStatus: session.status,
      newStatus: status,
      oldExpiresAt: session.expiresAt
    });

    session.status = status;
    session.respondedAt = new Date();
    const doctorRecipientId =
      session.doctorId && typeof session.doctorId === "object"
        ? session.doctorId._id?.toString?.() || null
        : session.doctorId?.toString?.() || null;

    // If accepted, extend the session for 20 minutes from now and increment session count
    if (status === "accepted") {
      const newExpiresAt = new Date(Date.now() + 20 * 60 * 1000);
      session.expiresAt = newExpiresAt;

      // Update patient session count and last visit
      try {
        await User.findByIdAndUpdate(session.patientId, {
          $inc: { sessionCount: 1 },
          $set: { lastVisit: new Date().toISOString().split('T')[0] }
        });
        console.log('📈 Incremented session count and updated last visit for patient:', session.patientId);
      } catch (err) {
        console.error('❌ Failed to update patient session stats:', err);
      }

      console.log('⏰ Session accepted, setting expiration:', {
        now: new Date(),
        expiresAt: newExpiresAt,
        minutesFromNow: 20
      });
    }

    console.log('💾 Saving session with data:', {
      _id: session._id,
      doctorId: doctorRecipientId,
      patientId: session.patientId,
      status: session.status,
      expiresAt: session.expiresAt
    });

    const savedSession = await session.save();

    console.log(`📋 Session ${sessionId} ${status} by patient ${req.auth.id}`);
    console.log('✅ Session saved to database:', {
      _id: savedSession._id,
      status: savedSession.status,
      expiresAt: savedSession.expiresAt,
      doctorId: savedSession.doctorId,
      patientId: savedSession.patientId,
      isActive: savedSession.expiresAt > new Date()
    });

    // Send notification to doctor about the patient's response
    try {
      if (!doctorRecipientId) {
        console.log('Skipping doctor notification: session has no doctor recipient');
      } else {
        // Create notification record in database
        const { Notification } = await import('../models/Notification.js');
        const notification = new Notification({
          title: `Session Request ${status === 'accepted' ? 'Accepted' : 'Declined'}`,
          body: `Patient has ${status} your access request`,
          type: "session",
          data: {
            sessionId: session._id.toString(),
            status: status,
            patientId: session.patientId.toString(),
            expiresAt: session.expiresAt.toISOString()
          },
          recipientId: doctorRecipientId,
          recipientRole: "doctor",
          senderId: session.patientId.toString(),
          senderRole: "patient"
        });
        await notification.save();

        // Send push notification
        await sendNotificationToDoctor(
          doctorRecipientId,
          `Session Request ${status === 'accepted' ? 'Accepted' : 'Declined'}`,
          `Patient has ${status} your access request`,
          {
            type: "SESSION_RESPONSE",
            sessionId: session._id.toString(),
            status: status,
            patientId: session.patientId.toString(),
            expiresAt: session.expiresAt.toISOString()
          }
        );

        // Broadcast to SSE connections
        const { broadcastNotification } = await import('../controllers/notificationController.js');
        await broadcastNotification(notification);

        console.log('✅ Session response notification created and sent');
      }
    } catch (notificationError) {
      console.error("❌ Failed to send session response notification:", notificationError);
      // Don't fail the request if notification fails
    }

    // Verify the session was saved correctly by re-querying
    const verifySession = await Session.findById(savedSession._id);
    console.log('🔍 Verification query result:', {
      found: !!verifySession,
      status: verifySession?.status,
      expiresAt: verifySession?.expiresAt,
      isStillActive: verifySession?.expiresAt > new Date()
    });

    const doctorSummary = await buildDoctorSummary(session.doctorId);

    res.json({
      success: true,
      message: `Session request ${status} successfully`,
      session: {
        _id: session._id,
        doctor: doctorSummary,
        status: session.status,
        expiresAt: session.expiresAt,
        respondedAt: session.respondedAt
      }
    });

  } catch (error) {
    console.error("Session response error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to respond to session request",
      error: error.message
    });
  }
});

// ---------------- Get Doctor's Own Sessions/Patients ----------------
// GET /api/sessions/mine
router.get("/mine", async (req, res) => {
  try {
    // Ensure the requester is a doctor
    if (req.auth.role !== "doctor") {
      return res.status(403).json({
        success: false,
        message: "Only doctors can access this endpoint"
      });
    }

    console.log('👨‍⚕️ Doctor requesting own sessions:', req.auth.id);

    // Clean up expired sessions first
    await Session.cleanExpiredSessions();

    // Find all accepted sessions for this doctor that are not expired
    const doctorSessions = await Session.find({
      doctorId: req.auth.id,
      status: { $in: ["accepted", "pending"] },
      expiresAt: { $gt: new Date() }
    })
      .populate('patientId', 'name email mobile profilePicture age gender bloodType dateOfBirth')
      .sort({ createdAt: -1 });

    console.log(`📋 Found ${doctorSessions.length} active sessions for doctor ${req.auth.id}`);

    // Transform sessions into patient list format for frontend compatibility
    const patients = doctorSessions.map(session => {
      const patient = session.patientId;
      return {
        id: patient._id.toString(),
        name: patient.name,
        email: patient.email,
        mobile: patient.mobile,
        profilePicture: patient.profilePicture,
        age: patient.age,
        gender: patient.gender,
        bloodType: patient.bloodType,
        dateOfBirth: patient.dateOfBirth,
        // Session info for reference
        sessionId: session._id,
        sessionExpiresAt: session.expiresAt,
        sessionCreatedAt: session.createdAt,
        status: session.status,
        isActive: session.isActive,
        // Add expiry info for frontend
        expiresAt: session.expiresAt.getTime(), // Convert to timestamp for frontend
        isExpiringSoon: (session.expiresAt - new Date()) < (5 * 60 * 1000) // Less than 5 minutes left
      };
    });

    console.log('✅ Returning patients for doctor:', patients.map(p => ({ id: p.id, name: p.name })));

    res.json({
      success: true,
      count: patients.length,
      patients: patients,
      activeSessions: doctorSessions.length
    });

  } catch (error) {
    console.error("❌ Doctor sessions error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch doctor's sessions",
      error: error.message
    });
  }
});

// ---------------- End All Active Sessions (When Doctor Goes Inactive) ----------------
// POST /api/sessions/end-all-active
router.post("/end-all-active", async (req, res) => {
  try {
    // Ensure the requester is a doctor
    if (req.auth.role !== "doctor") {
      return res.status(403).json({
        success: false,
        message: "Only doctors can access this endpoint"
      });
    }

    console.log('🛑 Doctor ending all active sessions:', req.auth.id);

    // Find all active sessions for this doctor
    const activeSessions = await Session.find({
      doctorId: req.auth.id,
      status: { $in: ["accepted", "pending"] },
      expiresAt: { $gt: new Date() }
    }).populate('patientId', 'name email');

    console.log(`📋 Found ${activeSessions.length} active sessions to end`);

    // End all active sessions
    let endedCount = 0;
    for (const session of activeSessions) {
      const persistedSession = await persistSessionHistory(Session, {
        sessionId: session._id,
        doctorId: session.doctorId,
        patientId: session.patientId?._id || session.patientId,
        diagnosis: session.diagnosis,
        notes: session.notes
          ? `${session.notes}\n\nSession ended automatically: Doctor profile deactivated.`
          : "Session ended automatically: Doctor profile deactivated.",
        endedAt: new Date(),
      });

      if (!persistedSession) {
        continue;
      }

      endedCount++;

      // Send notification to patient
      try {
        const { Notification } = await import('../models/Notification.js');
        const notification = new Notification({
          title: "Session Ended",
          body: "Your active session has been ended as the doctor's profile is now inactive.",
          type: "session",
          data: {
            sessionId: session._id.toString(),
            reason: "doctor_inactive"
          },
          recipientId: session.patientId._id.toString(),
          recipientRole: "patient",
          senderId: req.auth.id.toString(),
          senderRole: "doctor"
        });
        await notification.save();

        // Broadcast notification
        const { broadcastNotification } = await import('../controllers/notificationController.js');
        await broadcastNotification(notification);

        console.log(`✅ Notification sent to patient ${session.patientId.name}`);
      } catch (notifError) {
        console.error('❌ Failed to send session end notification:', notifError);
      }
    }

    console.log(`✅ Ended ${endedCount} active sessions`);

    res.json({
      success: true,
      message: `Successfully ended ${endedCount} active session(s)`,
      endedCount: endedCount
    });

  } catch (error) {
    console.error("❌ End all sessions error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to end active sessions",
      error: error.message
    });
  }
});

// ---------------- Get Session History for Doctor ----------------
// GET /api/sessions/history
router.get("/history", async (req, res) => {
  try {
    if (req.auth.role !== "doctor") {
      return res.status(403).json({
        success: false,
        message: "Only doctors can access this endpoint"
      });
    }

    console.log('👨‍⚕️ Doctor requesting session history:', req.auth.id);

    // Clean up expired sessions first (mark as inactive)
    await Session.cleanExpiredSessions();

    // Find all sessions for this doctor
    const sessions = await Session.find({
      doctorId: req.auth.id
    })
      .populate('patientId', 'name email mobile profilePicture age gender bloodType dateOfBirth sessionCount')
      .sort({ createdAt: -1 });

    const now = new Date();
    const processedHistory = sessions.map(session => {
      const patient = session.patientId;
      if (!patient) return null;

      const startTime = new Date(session.createdAt);
      const isExpired = session.expiresAt ? new Date(session.expiresAt) <= now : false;

      // EXCLUDE currently active sessions from THIS history endpoint
      // Active = (pending or accepted) AND NOT expired
      const isActive = (session.status === "accepted" || session.status === "pending") && !isExpired && session.isActive !== false;
      if (isActive) return null;

      const endTime = session.endedAt || session.expiresAt || new Date();
      const durationMs = Math.max(0, endTime - startTime);
      const durationMinutes = Math.round(durationMs / (1000 * 60));

      // Determine the logical status for the UI
      let displayStatus = "expired";
      if (session.status === "ended") displayStatus = "completed";
      else if (session.status === "declined") displayStatus = "declined";
      else if (session.status === "accepted" && isExpired) displayStatus = "expired";
      else if (session.status === "pending" && isExpired) displayStatus = "ignored";

      return {
        id: patient._id.toString(),
        name: patient.name,
        email: patient.email,
        mobile: patient.mobile,
        profilePicture: patient.profilePicture,
        age: patient.age,
        gender: patient.gender,
        bloodType: patient.bloodType,
        dateOfBirth: patient.dateOfBirth,
        sessionCount: patient.sessionCount || 0,
        sessionId: session._id,
        date: startTime.toLocaleDateString(),
        time: startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        duration: durationMinutes,
        status: displayStatus,
        originalStatus: session.status,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        endedAt: session.endedAt,
        diagnosis: session.diagnosis || "No diagnosis recorded",
        notes: session.notes || "No notes recorded"
      };
    }).filter(p => p !== null);

    res.json({
      success: true,
      count: processedHistory.length,
      history: processedHistory
    });

  } catch (error) {
    console.error("❌ History fetching error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch session history",
      error: error.message
    });
  }
});

// ---------------- Get Specific Doctor's Previous Sessions (For Dashboard) ----------------
// GET /api/sessions/previous-sessions
// Returns unique patients with their visit counts and latest records
router.get("/previous-sessions", auth, async (req, res) => {
  try {
    if (req.auth.role !== "doctor") {
      return res.status(403).json({
        success: false,
        message: "Only doctors can access this endpoint"
      });
    }

    console.log('👨‍⚕️ Doctor requesting structured previous sessions:', req.auth.id);

    // Clean up expired sessions first
    await Session.cleanExpiredSessions();

    // Find all non-pending sessions for this doctor
    const sessions = await Session.find({
      doctorId: req.auth.id,
      status: { $in: ["accepted", "ended", "declined"] }
    })
      .populate('patientId', 'name email mobile profilePicture age gender bloodType dateOfBirth sessionCount')
      .sort({ createdAt: -1 });

    // Group by patient to calculate total visits and get latest details
    const patientGroups = {};

    sessions.forEach(session => {
      const patient = session.patientId;
      if (!patient) return;

      const pId = patient._id.toString();
      if (!patientGroups[pId]) {
        patientGroups[pId] = {
          patient_id: pId,
          name: patient.name,
          mobile: patient.mobile,
          email: patient.email,
          profilePicture: patient.profilePicture,
          totalVisits: patient.sessionCount || 0,
          sessions: []
        };
      }

      patientGroups[pId].sessions.push({
        session_id: session._id,
        visit_date: session.createdAt,
        diagnosis: session.diagnosis || "No diagnosis recorded",
        notes: session.notes || "No notes recorded",
        status: session.status,
        duration: session.endedAt && session.createdAt ? Math.round((session.endedAt - session.createdAt) / (1000 * 60)) : 20
      });
    });

    const result = Object.values(patientGroups).map(group => ({
      ...group,
      totalVisits: group.sessions.length
    }));

    res.json({
      success: true,
      count: result.length,
      data: result
    });

  } catch (error) {
    console.error("❌ Previous sessions error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch previous sessions",
      error: error.message
    });
  }
});

// ---------------- Get All Sessions for a Specific Patient ----------------
// GET /api/sessions/patient/:patientId
router.get("/patient/:patientId", async (req, res) => {
  try {
    const { patientId } = req.params;

    console.log(`🔍 Fetching all sessions for patient: ${patientId}, requested by: ${req.auth.id}`);

    // Security check: Patient can only view their own history
    if (req.auth.role === 'patient' && req.auth.id.toString() !== patientId.toString()) {
      return res.status(403).json({
        success: false,
        message: "You can only view your own session history"
      });
    }

    // Find all sessions for this patient where status is not pending
    // This includes accepted, ended, declined, and expired sessions
    const sessions = await Session.find({
      patientId: patientId,
      status: { $in: ["accepted", "ended", "declined"] }
    })
      .populate(
        "doctorId",
        "name email mobile avatar profilePicture profilePictureUrl specialty specialization chatUrl chatDeepLink"
      )
      .sort({ createdAt: -1 });

    const processedHistory = sessions.map(session => {
      const doctor = session.doctorId;
      const startTime = new Date(session.createdAt);
      const endTime = session.endedAt || session.expiresAt || new Date();
      const durationMs = Math.max(0, endTime - startTime);
      const durationMinutes = Math.round(durationMs / (1000 * 60));

      return {
        sessionId: session._id,
        doctorId: doctor ? doctor._id : null,
        doctorName: doctor ? doctor.name : (session.requestMessage && session.requestMessage.includes('Anonymous') ? 'Anonymous Doctor' : 'Unknown Doctor'),
        doctorSpecialization: doctor
          ? (doctor.specialization || doctor.specialty || "Medical Practice")
          : 'Medical Practice',
        date: startTime.toLocaleDateString(),
        time: startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        duration: durationMinutes,
        status: session.status,
        createdAt: session.createdAt
      };
    });

    res.json({
      success: true,
      count: processedHistory.length,
      history: processedHistory
    });

  } catch (error) {
    console.error("❌ Patient history fetching error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch patient session history",
      error: error.message
    });
  }
});

// ---------------- Get Active Sessions (Optional - for future use) ----------------
// GET /api/sessions/active
router.get("/active", async (req, res) => {
  try {
    // Clean up expired sessions first
    await Session.cleanExpiredSessions();

    let query = {
      status: "accepted",
      expiresAt: { $gt: new Date() }
    };

    // Filter by role
    if (req.auth.role === "doctor") {
      query.doctorId = req.auth.id;
    } else {
      query.patientId = req.auth.id;
    }

    const activeSessions = await Session.find(query)
      .populate(
        "doctorId",
        "name email mobile avatar profilePicture profilePictureUrl experience specialty specialization createdAt chatUrl chatDeepLink"
      )
      .populate('patientId', 'name email profilePicture age gender')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      count: activeSessions.length,
      sessions: activeSessions
    });

  } catch (error) {
    console.error("Active sessions error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch active sessions",
      error: error.message
    });
  }
});

// ---------------- Debug endpoint ----------------
// GET /api/sessions/debug
router.get("/debug", auth, async (req, res) => {
  if (!ENABLE_DEBUG_ROUTES) {
    return res.status(404).json({ success: false, message: "Not found" });
  }
  try {
    res.json({
      success: true,
      debug: {
        authId: req.auth?.id,
        authRole: req.auth?.role,
        user: req.user ? {
          id: req.user._id,
          name: req.user.name,
          email: req.user.email
        } : null,
        doctor: req.doctor ? {
          id: req.doctor._id,
          name: req.doctor.name,
          email: req.doctor.email
        } : null,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ---------------- Debug specific doctor-patient session ----------------
// GET /api/sessions/debug/:patientId
router.get("/debug/:patientId", auth, async (req, res) => {
  if (!ENABLE_DEBUG_ROUTES) {
    return res.status(404).json({ success: false, message: "Not found" });
  }
  try {
    const patientId = req.params.patientId;

    // Find all sessions between this doctor and patient
    const sessions = await Session.find({
      doctorId: req.auth.id,
      patientId: patientId
    }).sort({ createdAt: -1 });

    // Find active session specifically
    const activeSession = await Session.findOne({
      doctorId: req.auth.id,
      patientId: patientId,
      status: "accepted",
      expiresAt: { $gt: new Date() }
    });

    res.json({
      success: true,
      debug: {
        doctorId: req.auth.id,
        patientId: patientId,
        currentTime: new Date(),
        allSessions: sessions.map(s => ({
          _id: s._id,
          status: s.status,
          createdAt: s.createdAt,
          expiresAt: s.expiresAt,
          isExpired: s.expiresAt <= new Date()
        })),
        activeSession: activeSession ? {
          _id: activeSession._id,
          status: activeSession.status,
          expiresAt: activeSession.expiresAt,
          isActive: activeSession.expiresAt > new Date()
        } : null
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ---------------- Test session creation ----------------
// POST /api/sessions/test-create
router.post("/test-create", auth, async (req, res) => {
  if (!ENABLE_DEBUG_ROUTES) {
    return res.status(404).json({ success: false, message: "Not found" });
  }
  try {
    console.log('🧪 Test session creation:', {
      authId: req.auth?.id,
      authRole: req.auth?.role,
      body: req.body
    });

    if (req.auth.role !== "doctor") {
      return res.status(403).json({
        success: false,
        message: "Only doctors can create test sessions"
      });
    }

    // First, ensure we have a test patient
    let testPatient = await User.findOne({ email: "test.patient@example.com" });

    if (!testPatient) {
      console.log('🔄 Creating test patient...');
      testPatient = new User({
        name: "Test Patient",
        email: "test.patient@example.com",
        password: "test123",
        mobile: "+1234567890",
        age: 30,
        gender: "Male",
        bloodType: "O+"
      });
      await testPatient.save();
      console.log('✅ Test patient created:', testPatient._id);
    } else {
      console.log('✅ Test patient found:', testPatient._id);
    }

    // Use the test patient's ID or the provided one
    const patientId = req.body.patientId || testPatient._id.toString();
    console.log('🔄 Using patient ID:', patientId);

    // Create a simple test session
    const testSession = new Session({
      doctorId: req.auth.id,
      patientId: patientId,
      requestMessage: "Test session creation",
      status: "pending",
      expiresAt: new Date(Date.now() + 20 * 60 * 1000) // Explicitly set expiration
    });

    console.log('💾 Saving test session...');
    const savedSession = await testSession.save();
    console.log('✅ Test session saved:', savedSession._id);

    res.json({
      success: true,
      message: "Test session created successfully",
      sessionId: savedSession._id,
      session: savedSession,
      testPatient: {
        id: testPatient._id,
        name: testPatient.name,
        email: testPatient.email
      }
    });

  } catch (error) {
    console.error("Test session creation error:", error);
    res.status(500).json({
      success: false,
      message: "Test session creation failed",
      error: error.message,
      stack: error.stack
    });
  }
});

// ---------------- End Active Session (Production Ready) ----------------
// DELETE /api/sessions/end/:sessionId
router.delete("/end/:sessionId", auth, async (req, res) => {
  try {
    const { sessionId } = req.params;

    // Validate sessionId format
    if (!sessionId || !sessionId.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({
        success: false,
        message: "Invalid session ID format"
      });
    }

    // Find the session
    const session = await Session.findById(sessionId)
      .populate('patientId', 'name email');

    if (!session) {
      return res.status(404).json({
        success: false,
        message: "Session not found"
      });
    }

    // Verify the session belongs to the requesting doctor
    if (session.doctorId.toString() !== req.auth.id.toString()) {
      return res.status(403).json({
        success: false,
        message: "You can only end your own sessions"
      });
    }

    // Check if session is already ended
    if (session.status === "ended") {
      return res.status(409).json({
        success: false,
        message: "Session has already been ended"
      });
    }

    // Store patient info before update for notification
    const patientName = session.patientId?.name || 'Patient';
    const patientId = session.patientId?._id || session.patientId;

    // Update session to ended state
    const { diagnosis, notes } = req.body || {};

    const persistedSession = await persistSessionHistory(Session, {
      sessionId: session._id,
      doctorId: session.doctorId,
      patientId: patientId,
      diagnosis: diagnosis !== undefined ? diagnosis : session.diagnosis,
      notes: notes !== undefined ? notes : session.notes,
      endedAt: new Date(),
    });

    if (!persistedSession) {
      throw new Error("Failed to persist ended session");
    }

    console.log(`🗑️ Session ${sessionId} ended by doctor ${req.auth.id}`);
    console.log('📋 Session end details:', {
      sessionId: sessionId,
      patientId: patientId,
      status: persistedSession.status,
      isActive: persistedSession.isActive,
      endedAt: persistedSession.endedAt
    });

    // Send notification to patient about session end
    try {
      const doctorInfo = await DoctorUser.findById(req.auth.id).select('name');
      const doctorName = doctorInfo?.name || 'Your doctor';

      // Create notification record
      const { Notification } = await import('../models/Notification.js');
      const notification = new Notification({
        userId: patientId,
        title: 'Session Ended',
        message: `Dr. ${doctorName} has ended your access session.`,
        type: 'SESSION_ENDED',
        data: {
          sessionId: sessionId,
          doctorName: doctorName,
          endedAt: persistedSession.endedAt.toISOString()
        },
        senderRole: 'doctor'
      });
      await notification.save();

      // Send push notification
      await sendNotification(
        patientId.toString(),
        'Session Ended',
        `Dr. ${doctorName} has ended your access session.`,
        {
          type: 'SESSION_ENDED',
          sessionId: sessionId,
          endedAt: persistedSession.endedAt.toISOString()
        }
      );

      // Broadcast to SSE connections for real-time update
      const { broadcastNotification } = await import('../controllers/notificationController.js');
      await broadcastNotification(notification);

      console.log('✅ Session end notification sent to patient');
    } catch (notifError) {
      console.error('❌ Failed to send session end notification:', notifError);
      // Don't fail the request if notification fails
    }

    res.json({
      success: true,
      message: "Live session ended successfully",
      session: {
        id: persistedSession._id,
        status: persistedSession.status,
        isActive: persistedSession.isActive,
        endedAt: persistedSession.endedAt,
        patientName: patientName
      }
    });

  } catch (error) {
    console.error("❌ End session error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to end session",
      error: error.message
    });
  }
});

// ---------------- Cleanup expired sessions (Utility endpoint) ----------------
// DELETE /api/sessions/cleanup
router.delete("/cleanup", async (req, res) => {
  try {
    // Only allow doctors or admins to trigger cleanup
    if (req.auth.role !== "doctor") {
      return res.status(403).json({
        success: false,
        message: "Unauthorized"
      });
    }

    const result = await Session.cleanExpiredSessions();

    res.json({
      success: true,
      message: `Cleaned up ${result.modifiedCount || 0} expired sessions`
    });

  } catch (error) {
    console.error("Cleanup error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to cleanup sessions",
      error: error.message
    });
  }
});

// ---------------- Get All Sessions (Active + History) for Doctor ----------------
// GET /api/sessions/all-sessions
// Returns ALL sessions for the logged-in doctor (both active and completed)
router.get("/all-sessions", async (req, res) => {
  try {
    if (req.auth.role !== "doctor") {
      return res.status(403).json({
        success: false,
        message: "Only doctors can access this endpoint"
      });
    }

    console.log('👨‍⚕️ Doctor requesting all sessions:', req.auth.id);

    // Clean up expired sessions first (mark as inactive)
    await Session.cleanExpiredSessions();

    // Find ALL sessions for THIS DOCTOR (past and current)
    const sessions = await Session.find({
      doctorId: req.auth.id
    })
      .populate('patientId', 'name email mobile profilePicture age gender bloodType dateOfBirth sessionCount')
      .populate(
        "doctorId",
        "name email mobile avatar profilePicture profilePictureUrl experience specialty specialization createdAt chatUrl chatDeepLink"
      )
      .sort({ createdAt: -1 });

    const now = new Date();
    const processedSessions = sessions.map(session => {
      const patient = session.patientId && typeof session.patientId === "object" ? session.patientId : null;
      const patientMongoId = patient?._id?.toString() || (session.patientId?.toString?.() || null);

      const startTime = new Date(session.createdAt);
      const isExpired = session.expiresAt ? new Date(session.expiresAt) <= now : false;

      const endTime = session.endedAt || session.expiresAt || new Date();
      const durationMs = Math.max(0, endTime - startTime);
      const durationMinutes = Math.round(durationMs / (1000 * 60));

      // Correct status logic for past vs current
      let displayStatus = "Completed";
      let paymentStatus = "Paid";

      if (session.status === "ended") {
        displayStatus = "Completed";
        paymentStatus = "Paid";
      } else if (session.status === "declined") {
        displayStatus = "Cancelled";
        paymentStatus = "Refunded";
      } else if (session.status === "accepted") {
        if (isExpired) {
          displayStatus = "Completed";
          paymentStatus = "Paid";
        } else {
          displayStatus = "Active"; // This is a "Current" session
          paymentStatus = "Pending";
        }
      } else if (session.status === "pending") {
        if (isExpired) {
          displayStatus = "Cancelled";
          paymentStatus = "Refunded";
        } else {
          displayStatus = "Pending";
          paymentStatus = "Pending";
        }
      }

      // Determine session type
      let sessionType = "Regular Checkup";
      const diagnosisLower = (session.diagnosis || "").toLowerCase();
      const notesLower = (session.notes || "").toLowerCase();

      if (diagnosisLower.includes("emergency") || notesLower.includes("emergency")) sessionType = "Emergency";
      else if (diagnosisLower.includes("follow") || notesLower.includes("follow")) sessionType = "Follow-up";
      else if (diagnosisLower.includes("consult") || notesLower.includes("consult")) sessionType = "Consultation";

      return {
        id: session._id.toString(),
        patientMongoId: patientMongoId,
        patientName: patient?.name || "Unknown Patient",
        patientId: patientMongoId ? `PT-${patientMongoId.slice(-6).toUpperCase()}` : "PT-UNKNOWN",
        date: startTime.toISOString().split('T')[0],
        time: startTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        type: sessionType,
        status: displayStatus,
        duration: `${durationMinutes} min`,
        durationMinutes: durationMinutes,
        paymentStatus: paymentStatus,
        followUpRequired: (session.notes || "").toLowerCase().includes("follow"),
        diagnosis: session.diagnosis || "Medical Session",
        doctorNotes: session.notes || "No notes recorded.",
        avatar: patient?.profilePicture || `https://ui-avatars.com/api/?name=${encodeURIComponent(patient?.name || "Unknown Patient")}&background=0D8ABC&color=fff`,
        doctorName: session.doctorId?.name || "Anonymous Doctor",
        createdAt: session.createdAt
      };
    });

    res.json({
      success: true,
      count: processedSessions.length,
      sessions: processedSessions
    });

  } catch (error) {
    console.error("❌ All sessions fetching error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch all sessions",
      error: error.message
    });
  }
});




// ============================================================
// ---- SESSION HISTORY PAGE - COMPLETED SESSIONS ONLY ----
// GET /api/sessions/session-history
// ============================================================
// MongoDB connection: process.env.MONGO_URI read from .env via dotenv
//   (see backend/config/database.js — mongoose.connect(process.env.MONGO_URI))
// Collection: 'sessions' (see Session model: mongoose.model("Session", schema, "sessions"))
//
// Filter: ONLY completed/closed sessions for the logged-in doctor:
//   ✅ status === "ended"             (doctor manually ended)
//   ✅ status === "accepted" + expired (natural 20-min expiry)
//   ✅ status === "declined"           (patient declined)
//   ✅ status === "pending"  + expired (patient ignored)
//   ❌ EXCLUDED: active sessions, open pending
// Sort: Latest session first (createdAt: -1)
// ============================================================
router.get('/session-history', async (req, res) => {
  try {
    // Step 1: Auth check - only logged-in doctors can access
    if (!req.auth || req.auth.role !== 'doctor') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only authenticated doctors can view Session History.'
      });
    }

    const doctorId = req.auth.id;
    const now = new Date();
    console.log('📋 [SessionHistory] Fetching COMPLETED sessions from MongoDB for doctor:', doctorId);

    // Step 2: Fetch ALL sessions for this doctor from the 'sessions' collection
    // MongoDB connection is established at startup via process.env.MONGO_URI (config/database.js)
    const rawSessions = await Session.find({ doctorId: doctorId })
      .populate('patientId', 'name profilePicture email mobile age gender bloodType sessionCount')
      .sort({ createdAt: -1 });

    console.log('✅ [SessionHistory] Total DB sessions for doctor:', rawSessions.length);

    // Step 3: FILTER - Keep only COMPLETED sessions (exclude active & open pending)
    const completedRaw = rawSessions.filter(session => {
      const isExpired = session.expiresAt ? new Date(session.expiresAt) <= now : true;
      // ✅ Ended manually by doctor
      if (session.status === 'ended') return true;
      // ✅ Accepted but timer ran out naturally
      if (session.status === 'accepted' && isExpired) return true;
      // ✅ Patient declined
      if (session.status === 'declined') return true;
      // ✅ Pending request that expired (patient ignored)
      if (session.status === 'pending' && isExpired) return true;
      // ❌ Exclude: active accepted sessions & open pending (still waiting)
      return false;
    });

    console.log('✅ [SessionHistory] Completed sessions (after filter):', completedRaw.length);

    // Step 3.5: Calculate localized session counts for each patient (count sessions with THIS doctor)
    const patientSessionCounts = {};
    rawSessions.forEach(s => {
      const pId = s.patientId?._id?.toString() || s.patientId?.toString();
      if (pId) {
        patientSessionCounts[pId] = (patientSessionCounts[pId] || 0) + 1;
      }
    });

    // Step 4: Transform into frontend-ready objects
    const sessions = completedRaw.map((session) => {
      const patient = session.patientId && typeof session.patientId === 'object' ? session.patientId : null;

      // Date & Time
      const sessionStart = new Date(session.createdAt);
      const sessionDate = sessionStart.toISOString().split('T')[0];
      const sessionTime = sessionStart.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

      // Duration
      const sessionEnd = session.endedAt || session.expiresAt || now;
      const durationMs = Math.max(0, new Date(sessionEnd) - sessionStart);
      const totalSeconds = Math.floor(durationMs / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;

      const durationDisplay = minutes >= 60
        ? `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds}s`
        : `${minutes}m ${seconds}s`;

      // Session type derived from keywords
      const diagText = (session.diagnosis || '').toLowerCase();
      const notesText = (session.notes || '').toLowerCase();
      let sessionType = 'Regular Checkup';
      if (diagText.includes('emergency') || notesText.includes('emergency')) sessionType = 'Emergency';
      else if (diagText.includes('follow') || notesText.includes('follow')) sessionType = 'Follow-up';
      else if (diagText.includes('consult') || notesText.includes('consult')) sessionType = 'Consultation';

      // Display status & payment mapping
      const isExpired = session.expiresAt ? new Date(session.expiresAt) <= now : true;
      let sessionStatus = 'Completed';
      let paymentStatus = 'Paid';

      if (session.status === 'ended') {
        sessionStatus = 'Completed'; paymentStatus = 'Paid';
      } else if (session.status === 'declined') {
        sessionStatus = 'Cancelled'; paymentStatus = 'Refunded';
      } else if (session.status === 'accepted' && isExpired) {
        sessionStatus = 'Completed'; paymentStatus = 'Paid';
      } else if (session.status === 'pending' && isExpired) {
        sessionStatus = 'Cancelled'; paymentStatus = 'Refunded';
      }

      const patientMongoId = patient ? patient._id.toString() : null;
      const patientDisplayId = patientMongoId ? `PT-${patientMongoId.slice(-6).toUpperCase()}` : 'PT-UNKNOWN';
      const patientName = patient?.name || 'Unknown Patient';
      const avatar = patient?.profilePicture
        || `https://ui-avatars.com/api/?name=${encodeURIComponent(patientName)}&background=0D8ABC&color=fff`;

      return {
        id: session._id.toString(),
        sessionMongoId: session._id.toString(),
        patientMongoId: patientMongoId,
        patientName: patientName,
        patientId: patientDisplayId,
        patientEmail: patient?.email || '',
        patientMobile: patient?.mobile || '',
        patientAge: patient?.age || '',
        patientGender: patient?.gender || '',
        patientBloodType: patient?.bloodType || '',
        date: sessionDate,
        time: sessionTime,
        type: sessionType,
        duration: durationDisplay,
        durationMinutes: minutes,
        diagnosis: session.diagnosis || 'Medical Session',
        doctorNotes: session.notes || '',
        paymentStatus: paymentStatus,
        status: sessionStatus,
        followUpRequired: notesText.includes('follow') || diagText.includes('follow'),
        avatar: avatar,
        patientSessionCount: patient ? (patientSessionCounts[patient._id.toString()] || 0) : 0,
        createdAt: session.createdAt,
        endedAt: session.endedAt || null,
        expiresAt: session.expiresAt || null,
        rawStatus: session.status
      };
    });

    // Step 5: Return response
    console.log(`✅ [SessionHistory] Returning ${sessions.length} completed sessions`);
    res.json({
      success: true,
      count: sessions.length,
      sessions: sessions,
      meta: {
        source: 'sessions_collection',
        filter: `doctorId=${doctorId} | completed_only`,
        sort: 'createdAt_desc',
        timestamp: now.toISOString()
      }
    });

  } catch (error) {
    console.error('❌ [SessionHistory] Error fetching session history:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch session history from sessions collection',
      error: error.message
    });
  }
});


// ---------------- Doctor Requests Session Extension ----------------
// POST /api/sessions/extend/:sessionId
router.post("/extend/:sessionId", async (req, res) => {
  try {
    if (req.auth?.role !== "doctor") {
      return res.status(403).json({
        success: false,
        message: "Only doctors can request session extensions",
      });
    }

    const { sessionId } = req.params;
    const minutes = normalizeMinutes(req.body?.minutes, 20);

    if (!sessionId || !sessionId.match(/^[0-9a-fA-F]{24}$/)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid session ID format" });
    }

    const session = await Session.findById(sessionId).populate(
      "doctorId",
      "name email mobile avatar profilePicture profilePictureUrl experience specialty specialization createdAt chatUrl chatDeepLink"
    );
    if (!session) {
      return res
        .status(404)
        .json({ success: false, message: "Session not found" });
    }

    if (session.doctorId.toString() !== req.auth.id.toString()) {
      return res.status(403).json({
        success: false,
        message: "You can only extend your own sessions",
      });
    }

    if (session.status !== "accepted") {
      return res.status(409).json({
        success: false,
        message: "Only active accepted sessions can be extended",
      });
    }

    if (session.expiresAt <= new Date()) {
      return res.status(410).json({
        success: false,
        message: "Session has already expired",
      });
    }

    if (session.extensionRequest?.status === "pending") {
      return res.status(409).json({
        success: false,
        message: "An extension request is already pending patient approval",
      });
    }

    session.extensionRequest = {
      status: "pending",
      minutes,
      requestedAt: new Date(),
      respondedAt: null,
      requestedBy: asObjectId(req.auth.id),
    };

    await session.save();

    const doctorName = resolveParticipantName(session.doctorId, "Doctor");
    const patientRecipientId = asText(session.patientId);

    try {
      const { Notification } = await import("../models/Notification.js");
      const { broadcastNotification } = await import(
        "../controllers/notificationController.js"
      );

      const notificationPayload = {
        type: "SESSION_EXTENSION_REQUEST",
        sessionId: session._id.toString(),
        doctorId: asText(session.doctorId?._id || session.doctorId),
        doctorName,
        minutes: String(minutes),
        requestedAt: session.extensionRequest.requestedAt?.toISOString() || "",
        currentExpiresAt: session.expiresAt?.toISOString() || "",
      };

      const notification = await Notification.create({
        title: "Session Extension Request",
        body: `Dr. ${doctorName} requested ${minutes} more minutes for this session.`,
        type: "session",
        data: notificationPayload,
        recipientId: asObjectId(patientRecipientId),
        recipientRole: "patient",
        senderId: asObjectId(req.auth.id),
        senderRole: "doctor",
      });

      await sendNotification(
        patientRecipientId,
        "Session Extension Request",
        `Dr. ${doctorName} requested ${minutes} more minutes for this session.`,
        notificationPayload
      );

      await broadcastNotification(notification);
    } catch (notificationError) {
      console.error(
        "Failed to notify patient about extension request:",
        notificationError
      );
    }

    res.json({
      success: true,
      message: `Extension request for ${minutes} minutes sent to patient`,
      data: {
        sessionId: session._id.toString(),
        status: session.extensionRequest.status,
        minutes,
        requestedAt: session.extensionRequest.requestedAt,
        currentExpiresAt: session.expiresAt,
      },
    });
  } catch (error) {
    console.error("Extend session request error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to request session extension",
      error: error.message,
    });
  }
});

// ---------------- Patient Responds To Session Extension Request ----------------
// POST /api/sessions/extend/:sessionId/respond
router.post("/extend/:sessionId/respond", async (req, res) => {
  try {
    if (req.auth?.role !== "patient") {
      return res.status(403).json({
        success: false,
        message: "Only patients can respond to extension requests",
      });
    }

    const { sessionId } = req.params;
    const requestedStatus = asText(req.body?.status).toLowerCase();
    if (!["accepted", "declined"].includes(requestedStatus)) {
      return res.status(400).json({
        success: false,
        message: "Status must be 'accepted' or 'declined'",
      });
    }

    if (!sessionId || !sessionId.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({
        success: false,
        message: "Invalid session ID format",
      });
    }

    const session = await Session.findById(sessionId).populate(
      "doctorId",
      "name email mobile avatar profilePicture profilePictureUrl experience specialty specialization createdAt chatUrl chatDeepLink"
    );
    if (!session) {
      return res.status(404).json({
        success: false,
        message: "Session not found",
      });
    }

    if (asText(session.patientId) !== asText(req.auth.id)) {
      return res.status(403).json({
        success: false,
        message: "You can only respond to your own extension requests",
      });
    }

    if (session.status !== "accepted" || session.expiresAt <= new Date()) {
      return res.status(410).json({
        success: false,
        message: "Session is no longer active",
      });
    }

    if (session.extensionRequest?.status !== "pending") {
      return res.status(409).json({
        success: false,
        message: "No pending extension request found for this session",
      });
    }

    const requestedMinutes = normalizeMinutes(
      session.extensionRequest?.minutes,
      20
    );
    session.extensionRequest.status = requestedStatus;
    session.extensionRequest.respondedAt = new Date();
    session.extensionRequest.minutes = requestedMinutes;

    if (requestedStatus === "accepted") {
      const baseTime = Math.max(Date.now(), session.expiresAt.getTime());
      session.expiresAt = new Date(baseTime + requestedMinutes * 60 * 1000);
      session.status = "accepted";
    }

    await session.save();

    const doctorRecipientId = asText(
      session.doctorId && typeof session.doctorId === "object"
        ? session.doctorId._id
        : session.doctorId
    );
    const doctorName = resolveParticipantName(session.doctorId, "Doctor");

    try {
      const { Notification } = await import("../models/Notification.js");
      const { broadcastNotification } = await import(
        "../controllers/notificationController.js"
      );

      const notificationPayload = {
        type: "SESSION_EXTENSION_RESPONSE",
        sessionId: session._id.toString(),
        status: requestedStatus,
        patientId: asText(req.auth.id),
        minutes: String(requestedMinutes),
        expiresAt: session.expiresAt?.toISOString() || "",
        respondedAt: session.extensionRequest.respondedAt?.toISOString() || "",
      };

      const notification = await Notification.create({
        title:
          requestedStatus === "accepted"
            ? "Session Extension Approved"
            : "Session Extension Declined",
        body:
          requestedStatus === "accepted"
            ? `Patient approved +${requestedMinutes} minutes for this session.`
            : "Patient declined your session extension request.",
        type: "session",
        data: notificationPayload,
        recipientId: asObjectId(doctorRecipientId),
        recipientRole: "doctor",
        senderId: asObjectId(req.auth.id),
        senderRole: "patient",
      });

      await sendNotificationToDoctor(
        doctorRecipientId,
        requestedStatus === "accepted"
          ? "Session Extension Approved"
          : "Session Extension Declined",
        requestedStatus === "accepted"
          ? `Patient approved +${requestedMinutes} minutes for this session.`
          : "Patient declined your session extension request.",
        notificationPayload
      );

      await broadcastNotification(notification);
    } catch (notificationError) {
      console.error(
        "Failed to notify doctor about extension response:",
        notificationError
      );
    }

    return res.json({
      success: true,
      message:
        requestedStatus === "accepted"
          ? `Session extended by ${requestedMinutes} minutes`
          : "Session extension request declined",
      data: {
        sessionId: session._id.toString(),
        status: requestedStatus,
        minutes: requestedMinutes,
        expiresAt: session.expiresAt,
        doctorName,
      },
    });
  } catch (error) {
    console.error("Respond extension request error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to respond to extension request",
      error: error.message,
    });
  }
});


// ============================================================
// ---- UPDATE SESSION WHEN IT ENDS ----
// PATCH /api/sessions/:sessionId/update
// ============================================================
// Called when a session ends to save diagnosis + notes into MongoDB.
// Only the owning doctor can update. Sets status='ended', isActive=false,
// endedAt=now if not already set.
// ============================================================
router.patch('/:sessionId/update', async (req, res) => {
  try {
    if (!req.auth || req.auth.role !== 'doctor') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only authenticated doctors can update sessions.'
      });
    }

    const { sessionId } = req.params;
    const { diagnosis, notes, status } = req.body;

    if (!sessionId || !sessionId.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ success: false, message: 'Invalid session ID format' });
    }

    // Find and verify session ownership
    const session = await Session.findOne({ _id: sessionId, doctorId: req.auth.id });
    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found or you do not have permission to update it.'
      });
    }

    console.log(`📝 [SessionUpdate] Updating session ${sessionId} for doctor ${req.auth.id}`);

    if (status === 'ended') {
      const savedSession = await persistSessionHistory(Session, {
        sessionId: session._id,
        doctorId: session.doctorId,
        patientId: session.patientId,
        diagnosis: diagnosis !== undefined ? diagnosis : session.diagnosis,
        notes: notes !== undefined ? notes : session.notes,
        endedAt: session.endedAt || new Date(),
      }) || session;

      console.log(`🔴 [SessionUpdate] Marked as ended at ${savedSession.endedAt}`);
      console.log(`✅ [SessionUpdate] Session ${sessionId} saved successfully in MongoDB`);

      return res.json({
        success: true,
        message: 'Session updated successfully in MongoDB',
        session: {
          id: savedSession._id.toString(),
          status: savedSession.status,
          diagnosis: savedSession.diagnosis,
          notes: savedSession.notes,
          endedAt: savedSession.endedAt,
          isActive: savedSession.isActive
        }
      });
    }

    // Apply updates
    if (diagnosis !== undefined) session.diagnosis = diagnosis;
    if (notes !== undefined) session.notes = notes;

    await session.save();
    console.log(`✅ [SessionUpdate] Session ${sessionId} saved successfully in MongoDB`);

    res.json({
      success: true,
      message: 'Session updated successfully in MongoDB',
      session: {
        id: session._id.toString(),
        status: session.status,
        diagnosis: session.diagnosis,
        notes: session.notes,
        endedAt: session.endedAt,
        isActive: session.isActive
      }
    });

  } catch (error) {
    console.error('❌ [SessionUpdate] Error updating session:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update session in MongoDB',
      error: error.message
    });
  }
});


export default router;


