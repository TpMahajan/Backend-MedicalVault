import { User } from "../models/User.js";
import { DoctorUser } from "../models/DoctorUser.js";
import { AdminUser } from "../models/AdminUser.js";
import { RefreshToken } from "../models/RefreshToken.js";
import { parseBearerToken, parseCookies, verifyAccessToken } from "../services/tokenService.js";

const normalizeRole = (role) => String(role || "").trim().toLowerCase();
const asText = (value) => (value == null ? "" : String(value).trim());
const SESSION_INVALID_MESSAGE =
  "You have been logged out due to login from another device";
const HEARTBEAT_TOUCH_WINDOW_MS = 15_000;

const extractPrincipalFromPayload = (payload) => {
  if (!payload) return null;

  const role = normalizeRole(payload.role || payload.typ);
  const principalId =
    payload.sub ||
    payload.userId ||
    payload.id ||
    payload.doctorId ||
    payload.adminId ||
    payload.uid ||
    "";

  if (!role || !principalId) return null;

  // Legacy vault_share compatibility maps to patient role.
  const mappedRole = role === "vault_share" ? "patient" : role;

  return {
    role: mappedRole,
    id: String(principalId),
    email: payload.email ? String(payload.email).toLowerCase() : "",
    sid: asText(payload.sid),
  };
};

const resolveTokenCandidates = (req) => {
  const headerToken = parseBearerToken(req);
  const cookies = parseCookies(req);
  const cookieToken = cookies.mv_at || "";

  return {
    headerToken,
    cookieToken,
    ordered: [headerToken, cookieToken].filter(Boolean),
  };
};

const hydratePrincipal = async (principal) => {
  if (!principal) return null;

  const { id, role, email, sid } = principal;

  if (role === "patient") {
    const user = await User.findById(id).select("-password");
    if (!user || user.isActive === false || user.status === "BLOCKED") {
      return null;
    }
    return {
      auth: { id, role, email: user.email || email, sid },
      user,
    };
  }

  if (role === "doctor") {
    const doctor = await DoctorUser.findById(id).select("-password");
    if (!doctor || doctor.isActive === false || doctor.status === "BLOCKED") {
      return null;
    }
    return { auth: { id, role, email: doctor.email || email, sid }, doctor };
  }

  if (role === "admin") {
    const admin = await AdminUser.findById(id).select("-password");
    if (!admin || admin.isActive === false || admin.status === "BLOCKED") {
      return null;
    }
    if (admin.accessExpiresAt && admin.accessExpiresAt <= new Date()) {
      return null;
    }
    return { auth: { id, role, email: admin.email || email, sid }, admin };
  }

  if (role === "superadmin") {
    const configuredEmail = String(process.env.SUPERADMIN_EMAIL || "").trim().toLowerCase();
    const candidateEmail = String(email || "").trim().toLowerCase();
    if (!configuredEmail || candidateEmail !== configuredEmail) {
      return null;
    }
    return {
      auth: { id: configuredEmail, role, email: configuredEmail, sid },
      superAdmin: { email: configuredEmail, role: "SUPERADMIN" },
    };
  }

  // Security hardening: reject unknown roles instead of falling back.
  return null;
};

const applyPrincipalToRequest = (req, hydrated) => {
  req.auth = hydrated.auth;
  req.userId = hydrated.auth.id;

  if (hydrated.user) req.user = hydrated.user;
  if (hydrated.doctor) req.doctor = hydrated.doctor;
  if (hydrated.admin) req.admin = hydrated.admin;
  if (hydrated.superAdmin) req.superAdmin = hydrated.superAdmin;
};

const touchSessionHeartbeat = async ({ principalId, role, sessionId }) => {
  if (!principalId || !role || !sessionId) return;
  const now = new Date();
  const staleBefore = new Date(now.getTime() - HEARTBEAT_TOUCH_WINDOW_MS);

  await RefreshToken.updateOne(
    {
      principalId,
      role,
      jti: sessionId,
      revokedAt: null,
      expiresAt: { $gt: now },
      $or: [{ lastActiveAt: { $lt: staleBefore } }, { lastActiveAt: null }],
    },
    { $set: { lastActiveAt: now } }
  );

  if (role === "patient") {
    await User.updateOne(
      {
        _id: principalId,
        $or: [{ lastActiveAt: { $lt: staleBefore } }, { lastActiveAt: null }],
      },
      { $set: { lastActiveAt: now } }
    );
  }
};

const validateSessionState = async ({ principal }) => {
  const role = normalizeRole(principal?.role);
  const principalId = asText(principal?.id);
  const sessionId = asText(principal?.sid);

  if (!principalId || !role) return { valid: false };

  // Backward compatibility for tokens issued before sid support.
  if (!sessionId) return { valid: true };

  const tokenSession = await RefreshToken.findOne({
    principalId,
    role,
    jti: sessionId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .select("jti")
    .lean();

  if (!tokenSession) {
    return { valid: false, reason: "session_revoked" };
  }

  if (role === "patient") {
    const user = await User.findById(principalId)
      .select("allowMultipleSessions currentSessionId isActive status")
      .lean();
    if (!user || user.isActive === false || user.status === "BLOCKED") {
      return { valid: false, reason: "account_inactive" };
    }

    const currentSessionId = asText(user.currentSessionId);
    if (
      user.allowMultipleSessions !== true &&
      currentSessionId &&
      currentSessionId !== sessionId
    ) {
      return { valid: false, reason: "session_not_current" };
    }
  }

  await touchSessionHeartbeat({ principalId, role, sessionId });
  return { valid: true };
};

const verifyTokenAndHydrate = async (req) => {
  const { ordered } = resolveTokenCandidates(req);
  if (!ordered.length) {
    return { token: "", principal: null, hydrated: null, sessionInvalid: false };
  }

  let lastError = null;
  let sessionInvalid = false;
  for (const token of ordered) {
    try {
      const payload = verifyAccessToken(token);
      const principal = extractPrincipalFromPayload(payload);
      if (!principal) {
        continue;
      }

      const hydrated = await hydratePrincipal(principal);
      if (hydrated) {
        const sessionState = await validateSessionState({ principal });
        if (!sessionState.valid) {
          sessionInvalid = true;
          continue;
        }
        return { token, principal, hydrated, sessionInvalid: false };
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return { token: "", principal: null, hydrated: null, sessionInvalid };
};

// Middleware for required authentication
export const auth = async (req, res, next) => {
  try {
    const { hydrated, sessionInvalid } = await verifyTokenAndHydrate(req);

    if (!hydrated) {
      if (sessionInvalid) {
        return res.status(401).json({
          success: false,
          code: "SESSION_INVALID",
          message: SESSION_INVALID_MESSAGE,
        });
      }
      return res.status(401).json({
        success: false,
        message: "Access denied. Invalid or missing token.",
      });
    }

    applyPrincipalToRequest(req, hydrated);
    return next();
  } catch (error) {
    if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
      return res.status(401).json({ success: false, message: "Invalid or expired token." });
    }

    console.error("Auth middleware error:", error);
    return res.status(403).json({ success: false, message: "Access denied" });
  }
};

// Middleware for optional authentication
export const optionalAuth = async (req, res, next) => {
  try {
    const { ordered } = resolveTokenCandidates(req);
    if (!ordered.length) {
      return next();
    }

    for (const token of ordered) {
      try {
        const payload = verifyAccessToken(token);
        const principal = extractPrincipalFromPayload(payload);
        if (!principal) {
          continue;
        }

        const hydrated = await hydratePrincipal(principal);
        if (!hydrated) {
          continue;
        }

        applyPrincipalToRequest(req, hydrated);
        return next();
      } catch (error) {
        if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
          continue;
        }
        throw error;
      }
    }

    return next();
  } catch (error) {
    console.error("Optional auth error:", error);
    return res.status(403).json({ success: false, message: "Access denied" });
  }
};

// Role guards (used by route modules)
export const requireDoctor = (req, res, next) => {
  if (normalizeRole(req.auth?.role) !== "doctor") {
    return res.status(403).json({ success: false, message: "Doctor access required" });
  }
  return next();
};

export const requirePatient = (req, res, next) => {
  if (normalizeRole(req.auth?.role) !== "patient") {
    return res.status(403).json({ success: false, message: "Patient access required" });
  }
  return next();
};

export const requireAdmin = (req, res, next) => {
  if (normalizeRole(req.auth?.role) !== "admin") {
    return res.status(403).json({ success: false, message: "Admin access required" });
  }
  return next();
};

export const requireSuperAdmin = (req, res, next) => {
  if (normalizeRole(req.auth?.role) !== "superadmin") {
    return res.status(403).json({ success: false, message: "SuperAdmin access required" });
  }
  return next();
};
