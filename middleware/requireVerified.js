import { User } from "../models/User.js";
import { DoctorUser } from "../models/DoctorUser.js";

/**
 * Middleware to ensure email is verified (only for email/password users)
 * Google OAuth users are always considered verified
 * 
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next
 */
export const requireVerified = async (req, res, next) => {
  try {
    const userId = req.userId || req.auth?.id || req.user?._id;
    const role = req.auth?.role || "patient";

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    let user;
    if (role === "doctor") {
      user = await DoctorUser.findById(userId);
      // Doctors are considered verified by default
      if (!user) {
        return res.status(401).json({
          success: false,
          message: "Doctor not found",
        });
      }
      return next();
    } else {
      user = await User.findById(userId);
    }

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User not found",
      });
    }

    // Google users are always considered verified
    if (user.googleId || user.loginType === "google") {
      console.log("[requireVerified] Google user - auto verified:", { userId: user._id });
      return next();
    }

    // Check email verification status
    if (!user.emailVerified) {
      console.log("[requireVerified] User not verified:", { userId: user._id, email: user.email });
      return res.status(403).json({
        success: false,
        message: "Please verify your email to continue",
        emailVerified: false,
      });
    }

    console.log("[requireVerified] User verified:", { userId: user._id, email: user.email });
    next();
  } catch (error) {
    console.error("RequireVerified middleware error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

