import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";

// Load env (.env first, then legacy db.env fallback)
dotenv.config();
dotenv.config({ path: "./db.env" });
validateStartupConfig();

// Config imports
import connectDB from "./config/database.js";
import { validateStartupConfig } from "./config/startupValidation.js";

// Routes
import authRoutes from "./routes/authRoutes.js";        // patient auth
import documentRoutes from "./routes/document.js";      // file/documents
import qrRoutes from "./routes/qrRoutes.js";            // QR
import doctorAuthRoutes from "./routes/doctorAuth.js";  // doctor auth ✅
import appointmentRoutes from "./routes/appointments.js"; // appointments ✅
import userRoutes from "./routes/user.js";              // user management
import sessionRoutes from "./routes/sessionRoutes.js";  // session requests
import notificationRoutes from "./routes/notifications.js"; // notifications
import profileRoutes from "./routes/profiles.js";       // profile switching
import aiAssistantRoutes from "./routes/aiAssistant.js"; // AI assistant ✅
import sosRoutes from "./routes/sosRoutes.js";          // SOS messages
import appUpdateRoutes from "./routes/appUpdate.js";
import adminAuthRoutes from "./routes/adminAuth.js";    // admin auth
import adminSecurityRoutes from "./routes/adminSecurity.js";
import superAdminRoutes from "./routes/superAdmin.js";
import publicConfigRoutes from "./routes/publicConfig.js";
import lostFoundRoutes from "./routes/lostFound.js";    // lost & found (user)
import adminLostFoundRoutes from "./routes/adminLostFound.js"; // lost & found admin
import adminInventoryRoutes from "./routes/adminInventory.js"; // admin inventory
import inventoryRoutes from "./routes/inventory.js";           // public inventory (checkout)
import { Session } from "./models/Session.js";
import { checkEmailConfig } from "./utils/emailService.js";
import patientAppointmentRoutes from "./routes/patientAppointments.js"; // patient appointments (Flutter)
import { initPublicConfigRealtime } from "./services/publicConfigRealtime.js";
import { initAuthSessionRealtime } from "./services/authSessionRealtime.js";
import { apiLimiter } from "./middleware/rateLimit.js";

const app = express();
const PORT = process.env.PORT || 5000;
const ENV = process.env.NODE_ENV || "development";

// -------------------- Middleware --------------------
// Behind Render/Proxies: trust first proxy so rate limiter and IPs work
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS || 1));
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https:"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
    hsts: ENV !== "development" ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    frameguard: { action: "deny" },
    noSniff: true,
    referrerPolicy: { policy: "no-referrer" },
    crossOriginResourcePolicy: { policy: "same-site" },
  })
);

const defaultCorsOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://health-vault-web.vercel.app",
  "https://medicalvault-aially.vercel.app",
  "https://www.medicalvault-aially.vercel.app",
];

const envCorsOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const defaultCorsOriginPatterns = [
  /^https:\/\/health-vault-web(?:-[a-z0-9-]+)?\.vercel\.app$/i,
  /^https:\/\/medicalvault-aially(?:-[a-z0-9-]+)?\.vercel\.app$/i,
];

const envCorsOriginPatterns = (process.env.CORS_ORIGIN_PATTERNS || "")
  .split(",")
  .map((pattern) => pattern.trim())
  .filter(Boolean)
  .flatMap((pattern) => {
    try {
      return [new RegExp(pattern, "i")];
    } catch (error) {
      console.warn(`[cors] ignoring invalid CORS_ORIGIN_PATTERNS entry: ${pattern}`, error);
      return [];
    }
  });

const allowedCorsOrigins = new Set([
  ...defaultCorsOrigins,
  ...envCorsOrigins,
]);

const allowedCorsOriginPatterns = [
  ...defaultCorsOriginPatterns,
  ...envCorsOriginPatterns,
];

const isAllowedCorsOrigin = (origin) => {
  if (!origin) return true;
  if (allowedCorsOrigins.has(origin)) return true;
  return allowedCorsOriginPatterns.some((pattern) => pattern.test(origin));
};

const corsOptions = {
  origin: (origin, callback) => {
    if (isAllowedCorsOrigin(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "Origin"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
if (String(process.env.ENFORCE_HTTPS || "false").toLowerCase() === "true") {
  app.use((req, res, next) => {
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
    if (req.secure || forwardedProto === "https") return next();
    return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  });
}
app.use("/api", apiLimiter);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(compression({
  filter: (req, res) => {
    // Don't compress if the client doesn't want it or for SSE
    if (req.headers['x-no-compression'] || res.getHeader('Content-Type') === 'text/event-stream') {
      return false;
    }
    // Fallback to standard filter
    return compression.filter(req, res);
  }
}));
app.use(morgan("dev"));

// -------------------- Static File Serving --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve uploads folder publicly with CORS headers
app.use(
  "/uploads",
  (req, res, next) => {
    const requestOrigin = req.headers.origin;
    if (requestOrigin && isAllowedCorsOrigin(requestOrigin)) {
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    }
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  },
  express.static(process.env.UPLOAD_DIR || path.join(__dirname, "uploads"))
);

// -------------------- Routes --------------------
app.use("/api/auth", authRoutes);             // patients
app.use("/api/doctors", doctorAuthRoutes);    // doctors ✅
app.use("/api/files", documentRoutes);        // documents
app.use("/api/appointments", appointmentRoutes); // appointments ✅
app.use("/api/patient", patientAppointmentRoutes); // patient appointments (Flutter) ✅
app.use("/api/qr", qrRoutes);                 // QR
app.use("/api/users", userRoutes);            // user management
app.use("/api/sessions", sessionRoutes);      // session requests
app.use("/api/notifications", notificationRoutes); // notifications
app.use("/api/profiles", profileRoutes);      // profile switching
app.use("/api/ai", aiAssistantRoutes);        // AI assistant ✅
app.use("/api/sos", sosRoutes);               // SOS
app.use("/api/app", appUpdateRoutes);
app.use("/api/admin", adminAuthRoutes);       // admin auth
app.use("/api/admin", adminSecurityRoutes);   // admin security logs/alerts
app.use("/api/superadmin", superAdminRoutes);
app.use("/api/public", publicConfigRoutes);
app.use("/api/lost-found", lostFoundRoutes);  // lost & found
app.use("/api/admin/lost-found", adminLostFoundRoutes); // admin lost & found
app.use("/api/admin/inventory", adminInventoryRoutes);  // admin inventory ✅
app.use("/api", inventoryRoutes);                       // inventory/order API
app.use("/api/inventory", inventoryRoutes);             // compatibility mount

// Non-breaking versioned API mounts (v1)
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/doctors", doctorAuthRoutes);
app.use("/api/v1/files", documentRoutes);
app.use("/api/v1/appointments", appointmentRoutes);
app.use("/api/v1/patient", patientAppointmentRoutes);
app.use("/api/v1/qr", qrRoutes);
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/sessions", sessionRoutes);
app.use("/api/v1/notifications", notificationRoutes);
app.use("/api/v1/profiles", profileRoutes);
app.use("/api/v1/ai", aiAssistantRoutes);
app.use("/api/v1/sos", sosRoutes);
app.use("/api/v1/app", appUpdateRoutes);
app.use("/api/v1/admin", adminAuthRoutes);
app.use("/api/v1/admin", adminSecurityRoutes);
app.use("/api/v1/superadmin", superAdminRoutes);
app.use("/api/v1/public", publicConfigRoutes);
app.use("/api/v1/lost-found", lostFoundRoutes);
app.use("/api/v1/admin/lost-found", adminLostFoundRoutes);
app.use("/api/v1/admin/inventory", adminInventoryRoutes);
app.use("/api/v1", inventoryRoutes);

// -------------------- Health Check --------------------
app.get("/health", (req, res) =>
  res.json({
    ok: true,
    env: ENV,
    time: new Date().toISOString(),
    routes: [
      "/api/auth",
      "/api/doctors",
      "/api/files",
      "/api/appointments",
      "/api/qr",
      "/api/users",
      "/api/sessions",
      "/api/notifications",
      "/api/profiles",
      "/api/ai",
      "/api/app",
      "/api/admin",
      "/api/superadmin",
      "/api/public",
    ],
  })
);

// -------------------- Start Server --------------------
const startServer = async () => {
  try {
    await connectDB();
    // Log email configuration readiness at startup
    checkEmailConfig();

    // Initialize cron jobs for reminders
    const { initializeCronJobs } = await import('./services/cronService.js');
    initializeCronJobs();

    const sessionCleanupIntervalMs = Number(process.env.SESSION_HISTORY_FLUSH_INTERVAL_MS || 30000);
    const sessionCleanupTimer = setInterval(async () => {
      try {
        await Session.cleanExpiredSessions();
      } catch (cleanupError) {
        console.error("Session cleanup error:", cleanupError);
      }
    }, sessionCleanupIntervalMs);

    if (typeof sessionCleanupTimer.unref === "function") {
      sessionCleanupTimer.unref();
    }

    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
      console.log(`📚 Health check: http://0.0.0.0:${PORT}/health`);
      console.log(`📂 Serving uploads at: http://0.0.0.0:${PORT}/uploads`);
      console.log(`⏰ Cron jobs initialized for reminders`);
    });

    initPublicConfigRealtime(server);
    initAuthSessionRealtime(server);
  } catch (err) {
    console.error("❌ Failed to start server:", err);
    process.exit(1);
  }
};

// Graceful crash handling
process.on("unhandledRejection", (err) => {
  console.error("❌ Unhandled Promise Rejection:", err);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
  process.exit(1);
});

startServer();
