import rateLimit from "express-rate-limit";

export const guestClinicalSessionLimiter = rateLimit({
  windowMs: Number(process.env.GUEST_PUBLIC_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.GUEST_PUBLIC_RATE_LIMIT_MAX || 30),
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: "This invitation is unavailable or cannot be completed." },
  skip: (req) => req.method === "OPTIONS",
});
