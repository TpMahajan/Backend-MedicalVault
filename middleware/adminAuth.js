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

export const requireAdminPermissions = (...requiredPermissions) => {
  const required = requiredPermissions
    .flat()
    .map((entry) => String(entry || "").trim().toUpperCase())
    .filter(Boolean);

  return (req, res, next) => {
    return requireAdminAuth(req, res, () => {
      if (String(req.auth?.role || "").toLowerCase() === "superadmin") {
        return next();
      }

      const adminRole = String(req.admin?.role || "").toUpperCase();
      if (adminRole === "SUPER_ADMIN") {
        return next();
      }

      const assigned = new Set(
        (Array.isArray(req.admin?.permissions) ? req.admin.permissions : [])
          .map((entry) => String(entry || "").trim().toUpperCase())
      );

      const missing = required.filter((permission) => !assigned.has(permission));
      if (missing.length > 0) {
        return res.status(403).json({
          success: false,
          message: "Insufficient permissions",
          required,
          missing,
        });
      }
      return next();
    });
  };
};
