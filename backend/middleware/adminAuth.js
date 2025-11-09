import jwt from "jsonwebtoken";
import { AdminUser } from "../models/AdminUser.js";

export const requireAdminAuth = async (req, res, next) => {
  try {
    const token = req.header("Authorization")?.replace("Bearer ", "");
    if (!token) {
      return res
        .status(401)
        .json({ success: false, message: "Admin authorization required" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded?.adminId || decoded?.role !== "admin") {
      return res
        .status(403)
        .json({ success: false, message: "Admin access denied" });
    }

    const admin = await AdminUser.findById(decoded.adminId).select("-password");
    if (!admin || admin.isActive === false) {
      return res
        .status(403)
        .json({ success: false, message: "Admin account inactive" });
    }

    req.admin = admin;
    next();
  } catch (err) {
    console.error("Admin auth error:", err);
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res
        .status(401)
        .json({ success: false, message: "Invalid or expired admin token" });
    }
    return res
      .status(500)
      .json({ success: false, message: "Failed to authenticate admin" });
  }
};

