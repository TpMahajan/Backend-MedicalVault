import crypto from "crypto";
import jwt from "jsonwebtoken";

const ACCESS_TTL = process.env.JWT_ACCESS_EXPIRES_IN || "15m";
const REFRESH_TTL = process.env.JWT_REFRESH_EXPIRES_IN || "7d";

const getAccessSecret = () => {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is required");
  }
  return process.env.JWT_SECRET;
};

const getRefreshSecret = () => process.env.JWT_REFRESH_SECRET || getAccessSecret();

const toRole = (role) => String(role || "").trim().toLowerCase();

export const buildAccessPayload = ({ principalId, role, email = "" }) => ({
  sub: String(principalId),
  userId: String(principalId),
  role: toRole(role),
  ...(email ? { email: String(email).toLowerCase() } : {}),
});

export const signAccessToken = ({ principalId, role, email = "" }) =>
  jwt.sign(buildAccessPayload({ principalId, role, email }), getAccessSecret(), {
    expiresIn: ACCESS_TTL,
  });

export const signRefreshToken = ({ principalId, role, familyId, email = "" }) => {
  const jti = crypto.randomUUID();
  const payload = {
    sub: String(principalId),
    role: toRole(role),
    typ: "refresh",
    jti,
    familyId: familyId || crypto.randomUUID(),
    ...(email ? { email: String(email).toLowerCase() } : {}),
  };
  const token = jwt.sign(payload, getRefreshSecret(), { expiresIn: REFRESH_TTL });
  return { token, payload };
};

export const verifyAccessToken = (token) => jwt.verify(token, getAccessSecret());
export const verifyRefreshToken = (token) => jwt.verify(token, getRefreshSecret());

export const hashToken = (token) =>
  crypto.createHash("sha256").update(String(token)).digest("hex");

export const parseBearerToken = (req) => {
  const header = req.header("Authorization") || "";
  if (!header.startsWith("Bearer ")) return "";
  const token = header.slice(7).trim();
  if (!token) return "";

  const lowered = token.toLowerCase();
  // Common front-end placeholder leakage should be treated as "no token"
  // so cookie-based auth can still be used safely.
  if (["null", "undefined", "nan"].includes(lowered)) {
    return "";
  }

  return token;
};

export const parseCookies = (req) => {
  const raw = String(req.headers?.cookie || "");
  if (!raw) return {};
  return raw.split(";").reduce((acc, part) => {
    const idx = part.indexOf("=");
    if (idx <= 0) return acc;
    const key = decodeURIComponent(part.slice(0, idx).trim());
    const value = decodeURIComponent(part.slice(idx + 1).trim());
    acc[key] = value;
    return acc;
  }, {});
};

const isSecureCookie = () => String(process.env.COOKIE_SECURE || "true").toLowerCase() === "true";
const cookieDomain = process.env.COOKIE_DOMAIN || undefined;

export const setAuthCookies = (res, { accessToken, refreshToken }) => {
  const secure = isSecureCookie();
  const sameSite = secure ? "None" : "Lax";

  res.cookie("mv_at", accessToken, {
    httpOnly: true,
    secure,
    sameSite,
    domain: cookieDomain,
    path: "/",
    maxAge: 15 * 60 * 1000,
  });

  if (refreshToken) {
    res.cookie("mv_rt", refreshToken, {
      httpOnly: true,
      secure,
      sameSite,
      domain: cookieDomain,
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }
};

export const clearAuthCookies = (res) => {
  const secure = isSecureCookie();
  const sameSite = secure ? "None" : "Lax";

  const options = {
    httpOnly: true,
    secure,
    sameSite,
    domain: cookieDomain,
    path: "/",
  };

  res.clearCookie("mv_at", options);
  res.clearCookie("mv_rt", options);
};

export const issueAuthTokenSet = ({ principalId, role, email = "", familyId }) => {
  const accessToken = signAccessToken({ principalId, role, email });
  const refresh = signRefreshToken({ principalId, role, familyId, email });
  return {
    accessToken,
    refreshToken: refresh.token,
    refreshMeta: refresh.payload,
    expiresIn: ACCESS_TTL,
  };
};

export const ACCESS_TOKEN_TTL = ACCESS_TTL;
export const REFRESH_TOKEN_TTL = REFRESH_TTL;
