import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import path from "path";
import { fileURLToPath } from "url";

// Load env
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
  })
);
app.use(cors({ origin: "*", credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(compression());
app.use(morgan("dev"));

// -------------------- Static File Serving --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve uploads folder publicly
app.use(
  "/uploads",
  express.static(process.env.UPLOAD_DIR || path.join(__dirname, "../uploads"))
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
