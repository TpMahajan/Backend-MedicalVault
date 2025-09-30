import jwt from "jsonwebtoken";
import { User } from "../models/User.js";
import { DoctorUser } from "../models/DoctorUser.js";

// Middleware for required authentication
export const auth = async (req, res, next) => {
  try {
    // Check for token in Authorization header first, then query parameter
    let token = req.header("Authorization")?.replace("Bearer ", "");
    let tokenSource = "header";
    if (!token) {
      token = req.query.token;
      tokenSource = token ? "query" : "none";
    }
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Access denied. No token provided.",
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Handle different token formats
    let userId, role;
    if (decoded.userId && decoded.role) {
      // Standard/anon format: { userId, role }
      userId = decoded.userId;
      role = decoded.role;
    } else if (decoded.uid && decoded.typ) {
      // Legacy vault_share format: { uid, typ }
      userId = decoded.uid;
      role = decoded.typ === "vault_share" ? "patient" : decoded.typ;
    } else {
      return res.status(401).json({ success: false, message: "Invalid token format." });
    }

    console.log("[auth] tokenSource=", tokenSource, "role=", role, "userId=", userId, "path=", req.originalUrl);

    let account;
    if (role === "doctor") {
      account = await DoctorUser.findById(userId).select("-password");
      if (!account) {
        return res.status(401).json({ success: false, message: "Doctor not found" });
      }
      req.doctor = account;
    } else {
      account = await User.findById(userId).select("-password");
      if (!account) {
        return res.status(401).json({ success: false, message: "User not found" });
      }
      if (account.isActive === false) {
        return res.status(401).json({ success: false, message: "Account is deactivated." });
      }
      req.user = account;
    }

    req.auth = { id: userId, role: role };

    // If anonymous role, enforce allowlist at middleware level
    if (role === "anonymous") {
      const method = req.method.toUpperCase();
      const path = req.path || "";

      const allow = (
        // Allow auth/me to return anonymous context
        (method === "GET" && /^\/api\/auth\/me$/i.test(req.originalUrl.replace(/\?.*$/, ""))) ||
        // GET /users/:id
        (method === "GET" && /^\/api\/users\/[a-f\d]{24}$/i.test(req.originalUrl.replace(/\?.*$/, ""))) ||
        // GET /users/:id/records
        (method === "GET" && /^\/api\/users\/[a-f\d]{24}\/records$/i.test(req.originalUrl.replace(/\?.*$/, ""))) ||
        // GET /files/:id/preview
        (method === "GET" && /^\/api\/files\/[a-f\d]{24}\/preview$/i.test(req.originalUrl.replace(/\?.*$/, ""))) ||
        // GET /files/:id/download
        (method === "GET" && /^\/api\/files\/[a-f\d]{24}\/download$/i.test(req.originalUrl.replace(/\?.*$/, "")))
      );

      if (!allow) {
        console.log("[auth] anonymous blocked path:", req.originalUrl);
      }
      if (!allow) {
        return res.status(403).json({ success: false, message: "Anonymous access not permitted for this endpoint" });
      }
    }
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
    let token = req.header("Authorization")?.replace("Bearer ", "");
    if (!token) {
      token = req.query.token;
    }
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      // Handle different token formats
      let userId, role;
      if (decoded.userId && decoded.role) {
        // Standard format: { userId, role }
        userId = decoded.userId;
        role = decoded.role;
      } else if (decoded.uid && decoded.typ) {
        // Vault share format: { uid, typ }
        userId = decoded.uid;
        role = decoded.typ === "vault_share" ? "patient" : decoded.typ;
      } else {
        console.warn("Invalid token format in optional auth");
        next();
        return;
      }
      
      if (role === "doctor") {
        const doctor = await DoctorUser.findById(userId).select("-password");
        if (doctor) req.doctor = doctor;
      } else {
        const user = await User.findById(userId).select("-password");
        if (user && user.isActive !== false) req.user = user;
      }
      req.auth = { id: userId, role: role };
    }
    next();
  } catch (err) {
    console.warn("Optional auth failed:", err.message);
    next(); // continue without authentication
  }
};
