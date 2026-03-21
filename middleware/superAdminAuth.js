import { SuperAdminCredential } from "../models/SuperAdminCredential.js";
import { parseBearerToken, parseCookies, verifyAccessToken } from "../services/tokenService.js";

const PASSWORD_CHANGE_ALLOWED_PATHS = new Set([
  "/auth/change-password",
  "/auth/logout",
  "/auth/me",
  "/auth/refresh",
]);

export const requireSuperAdminAuth = async (req, res, next) => {
  try {
    const bearer = parseBearerToken(req);
    const cookies = parseCookies(req);
    const token = bearer || cookies.mv_at || "";

    if (!token) {
      return res
        .status(401)
        .json({ success: false, message: "SuperAdmin authorization required" });
    }

    const decoded = verifyAccessToken(token);
    const role = String(decoded?.role || "").trim().toLowerCase();
    const email = String(decoded?.email || "").trim().toLowerCase();

    if (!decoded || role !== "superadmin" || !email) {
      return res
        .status(403)
        .json({ success: false, message: "SuperAdmin access denied" });
    }

    const credential = await SuperAdminCredential.findOne({ email })
      .select("mustChangePassword")
      .lean();
    if (!credential) {
      return res
        .status(403)
        .json({ success: false, message: "SuperAdmin access denied" });
    }
    const mustChangePassword = credential?.mustChangePassword === true;

    if (mustChangePassword && !PASSWORD_CHANGE_ALLOWED_PATHS.has(req.path)) {
      return res.status(403).json({
        success: false,
        code: "PASSWORD_CHANGE_REQUIRED",
        message: "Password change required before accessing this resource",
      });
    }

    req.superAdmin = {
      email,
      role: "SUPERADMIN",
      mustChangePassword,
    };
    req.auth = { id: email, role: "superadmin", email };

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
