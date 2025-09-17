import jwt from "jsonwebtoken";
import { User } from "../models/User.js";
import { DoctorUser } from "../models/DoctorUser.js";

// Middleware for required authentication
export const auth = async (req, res, next) => {
  try {
    const token = req.header("Authorization")?.replace("Bearer ", "");
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Access denied. No token provided.",
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    let account;
    if (decoded.role === "doctor") {
      account = await DoctorUser.findById(decoded.userId).select("-password");
      if (!account) {
        return res.status(401).json({ success: false, message: "Doctor not found" });
      }
      req.doctor = account;
    } else {
      account = await User.findById(decoded.userId).select("-password");
      if (!account) {
        return res.status(401).json({ success: false, message: "User not found" });
      }
      if (account.isActive === false) {
        return res.status(401).json({ success: false, message: "Account is deactivated." });
      }
      req.user = account;
    }

    req.auth = { id: decoded.userId, role: decoded.role };
    next();
  } catch (error) {
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ success: false, message: "Invalid token." });
    }
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ success: false, message: "Token expired." });
    }
    console.error("Auth middleware error:", error);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// Middleware for optional authentication
export const optionalAuth = async (req, res, next) => {
  try {
    const token = req.header("Authorization")?.replace("Bearer ", "");
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.role === "doctor") {
        const doctor = await DoctorUser.findById(decoded.userId).select("-password");
        if (doctor) req.doctor = doctor;
      } else {
        const user = await User.findById(decoded.userId).select("-password");
        if (user && user.isActive !== false) req.user = user;
      }
      req.auth = { id: decoded.userId, role: decoded.role };
    }
    next();
  } catch (err) {
    console.warn("Optional auth failed:", err.message);
    next(); // continue without authentication
  }
};
