import { auth } from "./auth.js";

export const requireAdminAuth = (req, res, next) => {
  return auth(req, res, () => {
    const role = String(req.auth?.role || "").toLowerCase();
    if (role !== "admin" && role !== "superadmin") {
      return res.status(403).json({ success: false, message: "Admin access denied" });
    }
    return next();
  });
};
