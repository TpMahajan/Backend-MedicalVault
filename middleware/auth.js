import { User } from "../models/User.js";
import { DoctorUser } from "../models/DoctorUser.js";
import { AdminUser } from "../models/AdminUser.js";
import { RefreshToken } from "../models/RefreshToken.js";
import { parseBearerToken, parseCookies, verifyAccessToken } from "../services/tokenService.js";

const normalizeRole = (role) => String(role || "").trim().toLowerCase();
const asText = (value) => (value == null ? "" : String(value).trim());
const SESSION_INVALID_MESSAGE =
  "You have been logged out due to login from another device";
const USER_DISABLED_MESSAGE =
  "Your account has been deactivated by admin.";
const TOKEN_VERSION_MISMATCH_MESSAGE =
  "Your session is no longer valid. Please login again.";
const HEARTBEAT_TOUCH_WINDOW_MS = 15_000;
const toTokenVersion = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
};

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
    tokenVersion: toTokenVersion(payload.tokenVersion),
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
    if (!user) {
      return null;
    }
    return {
      auth: {
        id,
        role,
        email: user.email || email,
        sid,
        tokenVersion: toTokenVersion(user.tokenVersion),
      },
      user,
    };
  }

  if (role === "doctor") {
    const doctor = await DoctorUser.findById(id).select("-password");
    if (!doctor) {
      return null;
    }
    return {
      auth: {
        id,
        role,
        email: doctor.email || email,
        sid,
        tokenVersion: toTokenVersion(doctor.tokenVersion),
      },
      doctor,
    };
  }

  if (role === "admin") {
    const admin = await AdminUser.findById(id).select("-password");
    if (!admin) {
      return null;
    }
    return {
      auth: {
        id,
        role,
        email: admin.email || email,
        sid,
        tokenVersion: toTokenVersion(admin.tokenVersion),
      },
      admin,
    };
  }

  if (role === "superadmin") {
    const configuredEmail = String(process.env.SUPERADMIN_EMAIL || "").trim().toLowerCase();
    const candidateEmail = String(email || "").trim().toLowerCase();
    if (!configuredEmail || candidateEmail !== configuredEmail) {
      return null;
    }
    return {
      auth: {
        id: configuredEmail,
        role,
        email: configuredEmail,
        sid,
        tokenVersion: 0,
      },
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

const buildInvalidState = (
  code = "SESSION_INVALID",
  message = SESSION_INVALID_MESSAGE,
  reason = ""
) => ({
  valid: false,
  code,
  message,
  reason: asText(reason),
});

const validateSessionState = async ({ principal }) => {
  const role = normalizeRole(principal?.role);
  const principalId = asText(principal?.id);
  const sessionId = asText(principal?.sid);
  const tokenVersion = toTokenVersion(principal?.tokenVersion);

  if (!principalId || !role) {
    return buildInvalidState("SESSION_INVALID", SESSION_INVALID_MESSAGE, "missing_principal");
  }

  if (role === "patient") {
    const user = await User.findById(principalId)
      .select("allowMultipleSessions currentSessionId isActive status tokenVersion")
      .lean();
    if (!user) {
      return buildInvalidState("SESSION_INVALID", SESSION_INVALID_MESSAGE, "account_not_found");
    }
    if (user.isActive === false || user.status === "BLOCKED") {
      return buildInvalidState("USER_DISABLED", USER_DISABLED_MESSAGE, "account_inactive");
    }

    if (toTokenVersion(user.tokenVersion) !== tokenVersion) {
      return buildInvalidState(
        "TOKEN_VERSION_MISMATCH",
        TOKEN_VERSION_MISMATCH_MESSAGE,
        "token_version_mismatch"
      );
    }

    if (!sessionId) {
      return { valid: true };
    }

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
      return buildInvalidState("SESSION_INVALID", SESSION_INVALID_MESSAGE, "session_revoked");
    }

    const currentSessionId = asText(user.currentSessionId);
    if (
      user.allowMultipleSessions !== true &&
      currentSessionId &&
      currentSessionId !== sessionId
    ) {
      return buildInvalidState("SESSION_INVALID", SESSION_INVALID_MESSAGE, "session_not_current");
    }

    await touchSessionHeartbeat({ principalId, role, sessionId });
    return { valid: true };
  }

  if (role === "doctor") {
    const doctor = await DoctorUser.findById(principalId)
      .select("isActive status tokenVersion")
      .lean();
    if (!doctor) {
      return buildInvalidState("SESSION_INVALID", SESSION_INVALID_MESSAGE, "account_not_found");
    }
    if (doctor.isActive === false || doctor.status === "BLOCKED") {
      return buildInvalidState("USER_DISABLED", USER_DISABLED_MESSAGE, "account_inactive");
    }
    if (toTokenVersion(doctor.tokenVersion) !== tokenVersion) {
      return buildInvalidState(
        "TOKEN_VERSION_MISMATCH",
        TOKEN_VERSION_MISMATCH_MESSAGE,
        "token_version_mismatch"
      );
    }
  }

  if (role === "admin") {
    const admin = await AdminUser.findById(principalId)
      .select("isActive status accessExpiresAt tokenVersion")
      .lean();
    if (!admin) {
      return buildInvalidState("SESSION_INVALID", SESSION_INVALID_MESSAGE, "account_not_found");
    }
    if (
      admin.isActive === false ||
      admin.status === "BLOCKED" ||
      (admin.accessExpiresAt && admin.accessExpiresAt <= new Date())
    ) {
      return buildInvalidState("USER_DISABLED", USER_DISABLED_MESSAGE, "account_inactive");
    }
    if (toTokenVersion(admin.tokenVersion) !== tokenVersion) {
      return buildInvalidState(
        "TOKEN_VERSION_MISMATCH",
        TOKEN_VERSION_MISMATCH_MESSAGE,
        "token_version_mismatch"
      );
    }
  }

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
    return buildInvalidState("SESSION_INVALID", SESSION_INVALID_MESSAGE, "session_revoked");
  }

  await touchSessionHeartbeat({ principalId, role, sessionId });
  return { valid: true };
};

const verifyTokenAndHydrate = async (req) => {
  const { ordered } = resolveTokenCandidates(req);
  if (!ordered.length) {
    return { token: "", principal: null, hydrated: null, invalidState: null };
  }

  let lastError = null;
  let invalidState = null;
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
          invalidState = sessionState;
          continue;
        }
        return { token, principal, hydrated, invalidState: null };
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return { token: "", principal: null, hydrated: null, invalidState };
};

// Middleware for required authentication
export const auth = async (req, res, next) => {
  try {
    const { hydrated, invalidState } = await verifyTokenAndHydrate(req);

    if (!hydrated) {
      if (invalidState?.code) {
        return res.status(401).json({
          success: false,
          code: invalidState.code,
          message: asText(invalidState.message) || SESSION_INVALID_MESSAGE,
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

        const sessionState = await validateSessionState({ principal });
        if (!sessionState.valid) {
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
