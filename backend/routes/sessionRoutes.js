import express from "express";
import { auth } from "../middleware/auth.js";
import { Session } from "../models/Session.js";
import { User } from "../models/User.js";
import { DoctorUser } from "../models/DoctorUser.js";

const router = express.Router();

// All routes require authentication
router.use(auth);

// ---------------- Doctor Requests Access ----------------
// POST /api/sessions/request
router.post("/request", async (req, res) => {
  try {
    const { patientId, requestMessage } = req.body;
    
    // Ensure the requester is a doctor
    if (req.auth.role !== "doctor") {
      return res.status(403).json({
        success: false,
        message: "Only doctors can request patient access"
      });
    }
    
    // Validate required fields
    if (!patientId) {
      return res.status(400).json({
        success: false,
        message: "Patient ID is required"
      });
    }
    
    // Check if patient exists
    const patient = await User.findById(patientId);
    if (!patient) {
      return res.status(404).json({
        success: false,
        message: "Patient not found"
      });
    }
    
    // Check if there's already a pending or active session
    const existingSession = await Session.findOne({
      doctorId: req.auth.id,
      patientId: patientId,
      status: { $in: ["pending", "accepted"] },
      expiresAt: { $gt: new Date() }
    });
    
    if (existingSession) {
      return res.status(409).json({
        success: false,
        message: `You already have a ${existingSession.status} session with this patient`
      });
    }
    
    // Create new session request
    const session = new Session({
      doctorId: req.auth.id,
      patientId: patientId,
      requestMessage: requestMessage || "",
      status: "pending"
      // expiresAt will be set automatically by pre-save middleware
    });
    
    await session.save();
    
    // Populate doctor info for response
    await session.populate('doctorId', 'name email profilePicture experience specialization');
    
    console.log(`📋 New session request: Dr. ${session.doctorId.name} → Patient ${patientId}`);
    
    res.status(201).json({
      success: true,
      message: "Access request sent successfully",
      session: session
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
    session.status = status;
    session.respondedAt = new Date();
    
    // If accepted, extend the session for 20 minutes from now
    if (status === "accepted") {
      session.expiresAt = new Date(Date.now() + 20 * 60 * 1000);
    }
    
    await session.save();
    
    console.log(`📋 Session ${sessionId} ${status} by patient ${req.auth.id}`);
    
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
