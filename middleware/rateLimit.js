import rateLimit from 'express-rate-limit';

// General API rate limiting
export const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100, // limit each IP to 100 requests per windowMs
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter rate limiting for auth routes
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 requests per windowMs
  message: {
    success: false,
    message: 'Too many authentication attempts, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
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
  standardHeaders: true,
  legacyHeaders: false,
});

// High-cost AI routes
export const aiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: parseInt(process.env.AI_RATE_LIMIT_MAX || "20", 10),
  message: {
    success: false,
    message: "Too many AI requests. Please try again shortly.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// File uploads
export const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: parseInt(process.env.UPLOAD_RATE_LIMIT_MAX || "30", 10),
  message: {
    success: false,
    message: "Too many upload attempts. Please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});
