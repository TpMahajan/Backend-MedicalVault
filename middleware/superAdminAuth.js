import jwt from "jsonwebtoken";

export const requireSuperAdminAuth = (req, res, next) => {
  try {
    const token = req.header("Authorization")?.replace("Bearer ", "");
    if (!token) {
      return res
        .status(401)
        .json({ success: false, message: "SuperAdmin authorization required" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded || decoded.role !== "SUPERADMIN" || !decoded.email) {
      return res
        .status(403)
        .json({ success: false, message: "SuperAdmin access denied" });
    }

    req.superAdmin = {
      email: String(decoded.email).toLowerCase(),
      role: decoded.role,
    };
    next();
  } catch (error) {
    if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
      return res
        .status(401)
        .json({ success: false, message: "Invalid or expired superadmin token" });
    }
    return res
      .status(500)
      .json({ success: false, message: "Failed to authenticate superadmin" });
  }
};
