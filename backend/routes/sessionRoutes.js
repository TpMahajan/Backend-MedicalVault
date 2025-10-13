import express from "express";
import { auth, optionalAuth } from "../middleware/auth.js";
import { Session } from "../models/Session.js";
import { User } from "../models/User.js";
import { DoctorUser } from "../models/DoctorUser.js";
import { sendNotification, sendNotificationToDoctor } from "../utils/notifications.js";

const router = express.Router();

// Health check endpoint (no auth required)
router.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "Session routes are working",
    timestamp: new Date().toISOString(),
    sessionModel: Session ? "loaded" : "not loaded"
  });
});

// Test database connection (no auth required)
router.get("/db-test", async (req, res) => {
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
// POST /api/sessions/request (allows anonymous access)
router.post("/request", optionalAuth, async (req, res) => {
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
    
    // Allow logged-in doctor; anonymous may initiate placeholder request label (no doctorId)
    if (!req.auth || (req.auth.role !== "doctor" && req.auth.role !== "anonymous")) {
      console.log('🚫 Session request denied - invalid role or no auth:', {
        hasAuth: !!req.auth,
        role: req.auth?.role,
        authId: req.auth?.id
      });
      return res.status(403).json({
        success: false,
        message: "Only doctors or anonymous QR can request access",
        debug: {
          hasAuth: !!req.auth,
          providedRole: req.auth?.role,
          requiredRole: "doctor|anonymous"
        }
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
    
    // For anonymous, skip duplicate check bound to doctorId
    let existingSession = null;
    if (req.auth.role === 'doctor') {
      console.log('🔍 Checking for existing session between doctor', req.auth.id, 'and patient', patientId);
      existingSession = await Session.findOne({
        doctorId: req.auth.id,
        patientId: patientId,
        status: { $in: ["pending", "accepted"] },
        expiresAt: { $gt: new Date() }
      });
    }
    
    if (existingSession) {
      console.log('🚫 Existing session found:', existingSession.status, 'expires:', existingSession.expiresAt);
      return res.status(409).json({
        success: false,
        message: `You already have a ${existingSession.status} session with this patient`,
        debug: {
          existingSessionId: existingSession._id,
          status: existingSession.status,
          expiresAt: existingSession.expiresAt
        }
      });
    }
    
    console.log('✅ No existing session found, creating new one');
    
    // Create new session request (anonymous doctor has null doctorId and a label)
    const isAnon = req.auth.role === 'anonymous';
    const doctorIdToSave = isAnon ? undefined : req.auth.id;
    const requestLabel = isAnon ? (requestMessage || "Anonymous Doctor is requesting access") : (requestMessage || "");

    console.log('🔄 Creating session with data:', {
      doctorId: doctorIdToSave || null,
      patientId: patientId,
      requestMessage: requestLabel,
      status: "pending"
    });
    
    const session = new Session({
      ...(doctorIdToSave ? { doctorId: doctorIdToSave } : {}),
      patientId: patientId,
      requestMessage: requestLabel,
      status: "pending",
      expiresAt: new Date(Date.now() + 20 * 60 * 1000) // Explicitly set expiration
    });
    
    console.log('💾 Saving session to database...');
    await session.save();
    console.log('✅ Session saved with ID:', session._id);
    
    // Populate doctor info for response if exists
    if (session.doctorId) {
      console.log('🔄 Populating doctor info...');
      await session.populate('doctorId', 'name email profilePicture experience specialization');
      console.log(`📋 New session request: Dr. ${session.doctorId.name} → Patient ${patientId}`);
    } else {
      console.log(`📋 New session request: Anonymous Doctor → Patient ${patientId}`);
    }
    
    // Send notification to patient about the new session request
    try {
      const doctorName = session.doctorId ? session.doctorId.name : 'Anonymous Doctor';
      const doctorIdForNotif = session.doctorId ? session.doctorId._id.toString() : null;
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
    } catch (notificationError) {
      console.error("❌ Failed to send session request notification:", notificationError);
      // Don't fail the request if notification fails
    }
    
    res.status(201).json({
      success: true,
      message: "Access request sent successfully",
      session: session,
      doctorLabel: session.doctorId ? `Dr. ${session.doctorId.name}` : 'Anonymous Doctor'
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
// GET /api/sessions/:id/status (allows anonymous polling)
router.get("/:id/status", optionalAuth, async (req, res) => {
  try {
    const sessionId = req.params.id;
    
    const session = await Session.findById(sessionId)
      .populate('doctorId', 'name email profilePicture experience specialization')
      .populate('patientId', 'name email');
    
    if (!session) {
      return res.status(404).json({
        success: false,
        message: "Session not found"
      });
    }
    
    // Check if requester is authorized to view this session
    const isDoctor = req.auth?.role === "doctor" && session.doctorId && session.doctorId._id.toString() === req.auth.id.toString();
    const isPatient = req.auth?.role !== "doctor" && session.patientId._id.toString() === req.auth.id.toString();
    const isAnonymous = req.auth?.role === "anonymous" && session.doctorId === null; // Anonymous sessions have no doctorId
    
    if (!isDoctor && !isPatient && !isAnonymous) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized to view this session"
      });
    }
    
    // Check if session has expired
    const isExpired = session.expiresAt <= new Date();
    const actualStatus = isExpired ? "expired" : session.status;
    
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
        doctor: session.doctorId ? {
          name: session.doctorId.name,
          email: session.doctorId.email,
          profilePicture: session.doctorId.profilePicture,
          experience: session.doctorId.experience,
          specialization: session.doctorId.specialization
        } : null,
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
    .populate('doctorId', 'name email profilePicture experience specialization createdAt')
    .sort({ createdAt: -1 }); // Most recent first
    
    console.log(`📋 Found ${requests.length} pending requests for patient ${req.auth.id}`);
    
    res.json({
      success: true,
      count: requests.length,
      requests: requests.map(session => ({
        _id: session._id,
        doctor: {
          _id: session.doctorId._id,
          name: session.doctorId.name,
          email: session.doctorId.email,
          profilePicture: session.doctorId.profilePicture,
          experience: session.doctorId.experience,
          specialization: session.doctorId.specialization,
          memberSince: session.doctorId.createdAt
        },
        requestMessage: session.requestMessage,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        status: session.status
      }))
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
      .populate('doctorId', 'name email profilePicture experience specialization');
    
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
    
    // If accepted, extend the session for 20 minutes from now
    if (status === "accepted") {
      const newExpiresAt = new Date(Date.now() + 20 * 60 * 1000);
      session.expiresAt = newExpiresAt;
      console.log('⏰ Session accepted, setting expiration:', {
        now: new Date(),
        expiresAt: newExpiresAt,
        minutesFromNow: 20
      });
    }
    
    console.log('💾 Saving session with data:', {
      _id: session._id,
      doctorId: session.doctorId._id,
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
      await sendNotificationToDoctor(
        session.doctorId._id.toString(),
        `Session Request ${status === 'accepted' ? 'Accepted' : 'Declined'}`,
        `Patient ${req.auth.role === 'patient' ? 'you' : 'has'} ${status} your access request`,
        {
          type: "SESSION_RESPONSE",
          sessionId: session._id.toString(),
          status: status,
          patientId: session.patientId.toString(),
          expiresAt: session.expiresAt.toISOString()
        }
      );
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
    
    res.json({
      success: true,
      message: `Session request ${status} successfully`,
      session: {
        _id: session._id,
        doctor: {
          name: session.doctorId.name,
          email: session.doctorId.email
        },
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
      status: "accepted",
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
      .populate('doctorId', 'name email profilePicture experience specialization')
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
      message: `Cleaned up ${result.deletedCount} expired sessions`
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

export default router;
