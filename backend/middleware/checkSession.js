import { Session } from "../models/Session.js";

/**
 * Middleware to check if a doctor has an active session with a patient
 * Only applies when:
 * - The requester is a doctor
 * - They're trying to access patient data (user routes, files)
 * 
 * Patients can always access their own data without session checks
 */
export const checkSession = async (req, res, next) => {
  try {
    // If the requester is not a doctor, skip session check
    if (req.auth.role !== "doctor") {
      return next();
    }

    // Extract patientId from different possible locations
    let patientId = null;
    
    // Check URL parameters (e.g., /api/users/:id, /api/files/user/:userId)
    if (req.params.id) {
      patientId = req.params.id;
    } else if (req.params.userId) {
      patientId = req.params.userId;
    } else if (req.params.patientId) {
      patientId = req.params.patientId;
    }
    
    // Check query parameters (e.g., ?patientId=...)
    if (!patientId && req.query.patientId) {
      patientId = req.query.patientId;
    }
    
    // Check request body for patientId
    if (!patientId && req.body && req.body.patientId) {
      patientId = req.body.patientId;
    }

    // If no patientId found, this might not be a patient-specific request
    if (!patientId) {
      console.log("⚠️ No patientId found in request, allowing access");
      return next();
    }

    // Clean up expired sessions first
    await Session.cleanExpiredSessions();

    // Check if doctor has an active session with this patient
    const activeSession = await Session.findOne({
      doctorId: req.auth.id,
      patientId: patientId,
      status: "accepted",
      expiresAt: { $gt: new Date() }
    }).populate('patientId', 'name email');

    if (!activeSession) {
      console.log(`🚫 Doctor ${req.auth.id} has no active session with patient ${patientId}`);
      return res.status(403).json({
        success: false,
        message: "Access denied. No active session with this patient.",
        code: "NO_ACTIVE_SESSION",
        patientId: patientId
      });
    }

    // Session is valid, add session info to request for potential use
    req.session = activeSession;
    req.patientId = patientId;

    console.log(`✅ Doctor ${req.auth.id} has active session with patient ${patientId} (expires: ${activeSession.expiresAt})`);
    next();

  } catch (error) {
    console.error("Session check middleware error:", error);
    res.status(500).json({
      success: false,
      message: "Session validation failed",
      error: error.message
    });
  }
};

/**
 * Middleware specifically for file access routes that use email parameter
 * Converts email to userId for session checking
 */
export const checkSessionByEmail = async (req, res, next) => {
  try {
    // If the requester is not a doctor, skip session check
    if (req.auth.role !== "doctor") {
      return next();
    }

    const email = req.params.email;
    if (!email) {
      return next();
    }

    // Import User model to find userId by email
    const { User } = await import("../models/User.js");
    
    const patient = await User.findOne({ email: email }).select('_id');
    if (!patient) {
      return res.status(404).json({
        success: false,
        message: "Patient not found"
      });
    }

    // Add patientId to params so regular checkSession can handle it
    req.params.id = patient._id.toString();
    
    // Call regular session check
    return checkSession(req, res, next);

  } catch (error) {
    console.error("Email-based session check error:", error);
    res.status(500).json({
      success: false,
      message: "Session validation failed",
      error: error.message
    });
  }
};

/**
 * Optional middleware for routes that should bypass session check
 * (for backward compatibility or special cases)
 */
export const bypassSessionCheck = (req, res, next) => {
  req.bypassSession = true;
  next();
};
