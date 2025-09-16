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
import authRoutes from "./routes/authRoutes.js";
import documentRoutes from "./routes/document.js";
import qrRoutes from "./routes/qrRoutes.js";


const app = express();
const PORT = process.env.PORT || 5000;
const ENV = process.env.NODE_ENV || "development";

// -------------------- Middleware --------------------
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
app.use("/uploads", express.static(process.env.UPLOAD_DIR || path.join(__dirname, "../uploads")));

// -------------------- Routes --------------------
app.use("/api/auth", authRoutes);
app.use("/api/files", documentRoutes);
app.use("/api/qr", qrRoutes);


// Health check
app.get("/health", (req, res) =>
  res.json({ ok: true, env: ENV, time: new Date().toISOString() })
);

// -------------------- Start Server --------------------
const startServer = async () => {
  try {
    await connectDB();
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
      console.log(`📚 Health check: http://0.0.0.0:${PORT}/health`);
      console.log(`📂 Serving uploads at: http://0.0.0.0:${PORT}/uploads`);
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
