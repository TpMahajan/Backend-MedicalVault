import { Session } from "../models/Session.js";

/**
 * Middleware to check if a doctor has an active session with a patient
 * Only applies when a doctor is trying to access patient data
 * Patients can always access their own data without session checks
 */
export const checkSession = async (req, res, next) => {
  try {
    console.log('🔐 checkSession middleware called:', {
      method: req.method,
      url: req.url,
      params: req.params,
      hasAuth: !!req.auth,
      authRole: req.auth?.role,
      authId: req.auth?.id
    });

    // Skip session check if no authentication (public access)
    if (!req.auth) {
      console.log("✅ No authentication, allowing public access");
      return next();
    }

    // Skip session check if not a doctor
    if (req.auth.role !== "doctor") {
      console.log("✅ Non-doctor user, skipping session check");
      return next();
    }

    // Extract patientId from URL parameters or from document
    let patientId = req.params.id || req.params.userId || req.params.patientId;
    
    // For file routes like /files/:id/proxy, we need to get patientId from the document
    if (!patientId && req.route?.path?.includes('/files/')) {
      try {
        const { Document } = await import("../models/File.js");
        const doc = await Document.findById(req.params.id).select('userId');
        if (doc) {
          patientId = doc.userId.toString();
          console.log('📄 Found patientId from document:', patientId);
        }
      } catch (error) {
        console.error('Error fetching document for session check:', error);
      }
    }
    
    console.log('🔍 Doctor session check:', {
      doctorId: req.auth.id,
      patientId: patientId,
      route: req.route?.path || req.url
    });

    // If no patientId, this might not be a patient-specific request
    if (!patientId) {
      console.log("⚠️ No patientId found, allowing access");
      return next();
    }

    // Clean up expired sessions first
    await Session.cleanExpiredSessions();

    // Query for active session
    const sessionQuery = {
      doctorId: req.auth.id,
      patientId: patientId,
      status: "accepted",
      expiresAt: { $gt: new Date() }
    };
    
    console.log('🔍 Searching for session with query:', sessionQuery);
    
    const activeSession = await Session.findOne(sessionQuery);
    
    console.log('📋 Session query result:', {
      found: !!activeSession,
      sessionId: activeSession?._id,
      status: activeSession?.status,
      expiresAt: activeSession?.expiresAt,
      doctorId: activeSession?.doctorId,
      patientId: activeSession?.patientId
    });

    if (!activeSession) {
      console.log(`🚫 No active session found for doctor ${req.auth.id} with patient ${patientId}`);
      
      // Debug: Check all sessions for this doctor-patient pair
      const allSessions = await Session.find({
        doctorId: req.auth.id,
        patientId: patientId
      }).sort({ createdAt: -1 });
      
      console.log('🔍 All sessions for debugging:', allSessions.map(s => ({
        _id: s._id,
        status: s.status,
        expiresAt: s.expiresAt,
        isExpired: s.expiresAt <= new Date(),
        createdAt: s.createdAt
      })));
      
      return res.status(403).json({
        success: false,
        message: "Session validation failed",
        msg: "Session validation failed", // Alternative message field
        code: "NO_ACTIVE_SESSION"
      });
    }

    // Session found and valid
    req.session = activeSession;
    req.patientId = patientId;

    console.log(`✅ Active session validated for doctor ${req.auth.id} with patient ${patientId}`);
    next();

  } catch (error) {
    console.error("❌ Session check middleware error:", error);
    
    // Always allow access on middleware errors to prevent breaking the system
    console.log("⚠️ Session check failed, allowing access as fallback");
    next();
  }
};

/**
 * Middleware specifically for file access routes that use email parameter
 * Converts email to userId for session checking
 */
export const checkSessionByEmail = async (req, res, next) => {
  try {
    console.log('📧 checkSessionByEmail called:', {
      email: req.params.email,
      authRole: req.auth?.role,
      authId: req.auth?.id
    });

    // Skip if no auth or not a doctor
    if (!req.auth || req.auth.role !== "doctor") {
      console.log("✅ Non-doctor or no auth, skipping email-based session check");
      return next();
    }

    const email = req.params.email;
    if (!email) {
      console.log("⚠️ No email parameter found");
      return next();
    }

    // Import User model to find userId by email
    const { User } = await import("../models/User.js");
    
    console.log('🔍 Looking for patient with email:', email);
    const patient = await User.findOne({ email: email }).select('_id');
    
    if (!patient) {
      console.log('🚫 Patient not found with email:', email);
      return res.status(404).json({
        success: false,
        message: "Patient not found"
      });
    }

    console.log('✅ Patient found, ID:', patient._id);
    
    // Add patientId to params so regular checkSession can handle it
    req.params.id = patient._id.toString();
    
    // Call regular session check
    return checkSession(req, res, next);

  } catch (error) {
    console.error("❌ Email-based session check error:", error);
    
    // Allow access on errors to prevent breaking the system
    console.log("⚠️ Email-based session check failed, allowing access as fallback");
    next();
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
