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

// Config imports
import connectDB from "./config/database.js";

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
import adminAuthRoutes from "./routes/adminAuth.js";    // admin auth
import lostFoundRoutes from "./routes/lostFound.js";    // lost & found (user)
import adminLostFoundRoutes from "./routes/adminLostFound.js"; // lost & found admin
import adminInventoryRoutes from "./routes/adminInventory.js"; // admin inventory
import inventoryRoutes from "./routes/inventory.js";           // public inventory (checkout)
import { Session } from "./models/Session.js";
import { checkEmailConfig } from "./utils/emailService.js";

const app = express();
const PORT = process.env.PORT || 5000;
const ENV = process.env.NODE_ENV || "development";

// -------------------- Middleware --------------------
// Behind Render/Proxies: trust first proxy so rate limiter and IPs work
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS || 1));
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false, // Allow images to be loaded from different origins
  })
);
app.use(cors({ origin: "*", credentials: true }));
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
    res.setHeader('Access-Control-Allow-Origin', '*');
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
app.use("/api/qr", qrRoutes);                 // QR
app.use("/api/users", userRoutes);            // user management
app.use("/api/sessions", sessionRoutes);      // session requests
app.use("/api/notifications", notificationRoutes); // notifications
app.use("/api/profiles", profileRoutes);      // profile switching
app.use("/api/ai", aiAssistantRoutes);        // AI assistant ✅
app.use("/api/sos", sosRoutes);               // SOS
app.use("/api/admin", adminAuthRoutes);       // admin auth
app.use("/api/lost-found", lostFoundRoutes);  // lost & found
app.use("/api/admin/lost-found", adminLostFoundRoutes); // admin lost & found
app.use("/api/admin/inventory", adminInventoryRoutes);  // admin inventory ✅
app.use("/api", inventoryRoutes);                       // inventory/order API
app.use("/api/inventory", inventoryRoutes);             // compatibility mount

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
      "/api/admin",
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

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
      console.log(`📚 Health check: http://0.0.0.0:${PORT}/health`);
      console.log(`📂 Serving uploads at: http://0.0.0.0:${PORT}/uploads`);
      console.log(`⏰ Cron jobs initialized for reminders`);
    });
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

