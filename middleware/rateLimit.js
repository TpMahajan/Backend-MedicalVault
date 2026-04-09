import rateLimit from 'express-rate-limit';

const parseEnvInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const disableApiLimiterInDev =
  String(process.env.DISABLE_API_RATE_LIMIT_IN_DEV || 'true').toLowerCase() === 'true';
const disableAuthLimiterInDev =
  String(process.env.DISABLE_AUTH_RATE_LIMIT_IN_DEV || 'true').toLowerCase() === 'true';

const sharedOptions = {
  standardHeaders: true,
  legacyHeaders: false,
};

const noopLimiter = (_req, _res, next) => next();

// General API rate limiting
export const apiLimiter =
  !isProduction && disableApiLimiterInDev
    ? noopLimiter
    : rateLimit({
        windowMs: parseEnvInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000), // 15 minutes
        max: parseEnvInt(process.env.RATE_LIMIT_MAX_REQUESTS, 100), // limit each IP to 100 requests per windowMs
        message: {
          success: false,
          message: 'Too many requests from this IP, please try again later.'
        },
        skip: (req) => req.method === 'OPTIONS',
        ...sharedOptions,
      });

// Stricter rate limiting for auth routes
export const authLimiter =
  !isProduction && disableAuthLimiterInDev
    ? noopLimiter
    : rateLimit({
        windowMs: parseEnvInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000), // 15 minutes
        max: parseEnvInt(process.env.AUTH_RATE_LIMIT_MAX_REQUESTS, 20), // less aggressive default for shared networks
        message: {
          success: false,
          message: 'Too many authentication attempts, please try again later.'
        },
        ...sharedOptions,
        skip: (req) => req.method === 'OPTIONS',
        skipSuccessfulRequests: true, // Don't count successful requests
      });

// Rate limiting for FCM token updates
export const fcmLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // limit each IP to 10 requests per minute
  message: {
    success: false,
    message: 'Too many FCM token updates, please try again later.'
  },
  ...sharedOptions,
});

// High-cost AI routes
export const aiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: parseInt(process.env.AI_RATE_LIMIT_MAX || "20", 10),
  message: {
    success: false,
    message: "Too many AI requests. Please try again shortly.",
  },
  ...sharedOptions,
});

// File uploads
export const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: parseInt(process.env.UPLOAD_RATE_LIMIT_MAX || "30", 10),
  message: {
    success: false,
    message: "Too many upload attempts. Please try again later.",
  },
  ...sharedOptions,
});
