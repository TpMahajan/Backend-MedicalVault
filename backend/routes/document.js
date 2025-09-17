import express from "express";
import multer from "multer";
import path from "path";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import { v2 as cloudinary } from "cloudinary";
import axios from "axios";
import { auth } from "../middleware/auth.js";  // ✅ auth middleware
import { Document } from "../models/File.js"; // ✅ unified Document model

const router = express.Router();

// ---------------- Cloudinary Config ----------------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ---------------- Cloudinary Storage ----------------
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const baseName = path.parse(file.originalname).name.replace(/\s+/g, "_");
    const ext = path.extname(file.originalname).toLowerCase();

    return {
      folder: "medical-vault",
      public_id: `${Date.now()}-${baseName}`,
      resource_type: "auto",
      format: ext === ".pdf" ? "pdf" : undefined,
    };
  },
});

// ---------------- Multer ----------------
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === ".pdf" && file.mimetype === "application/octet-stream") {
      file.mimetype = "application/pdf"; // fix for some clients
    }
    cb(null, true);
  },
});

// ---------------- Upload ----------------
router.post("/upload", auth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ msg: "No file uploaded" });

    const { patientId, userId, title, category, date, notes } = req.body;
    const actualPatientId = patientId || userId || req.auth.id;

    const doc = await Document.create({
      patientId: actualPatientId,
      doctorId: req.auth?.role === "doctor" ? req.auth.id : undefined,
      title: title || req.file.originalname,
      type: category || "Other",
      description: notes || "",
      cloudinaryUrl: req.file.path,
      cloudinaryPublicId: req.file.filename,
      fileType: req.file.mimetype,
      fileSize: req.file.size,
      uploadedAt: date || new Date(),
    });

    res.json({ success: true, document: doc });
  } catch (err) {
    res.status(500).json({ msg: "Upload failed", error: err.message });
  }
});

// ---------------- List Files ----------------
router.get("/patient/:patientId", auth, async (req, res) => {
  try {
    const docs = await Document.find({ patientId: req.params.patientId }).sort({ createdAt: -1 });
    res.json({ success: true, count: docs.length, documents: docs });
  } catch (err) {
    res.status(500).json({ success: false, msg: "Error fetching files", error: err.message });
  }
});

// ---------------- Grouped Files ----------------
router.get("/patient/:patientId/grouped", auth, async (req, res) => {
  try {
    const docs = await Document.find({ patientId: req.params.patientId });

    const grouped = {
      reports: docs.filter(d => d.type?.toLowerCase() === "lab report" || d.type?.toLowerCase() === "imaging"),
      prescriptions: docs.filter(d => d.type?.toLowerCase() === "prescription"),
      bills: docs.filter(d => d.type?.toLowerCase() === "bill"),
      insurance: docs.filter(d => d.type?.toLowerCase() === "insurance"),
      others: docs.filter(d =>
        !["lab report", "imaging", "prescription", "bill", "insurance"].includes(d.type?.toLowerCase())
      ),
    };

    res.json({
      success: true,
      patientId: req.params.patientId,
      counts: Object.fromEntries(Object.entries(grouped).map(([k, v]) => [k, v.length])),
      records: grouped,
    });
  } catch (err) {
    res.status(500).json({ success: false, msg: "Error grouping files", error: err.message });
  }
});

// ---------------- Preview ----------------
router.get("/:id/preview", auth, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ msg: "File not found" });

    // Return Cloudinary secure URL
    res.json({ success: true, url: doc.cloudinaryUrl });
  } catch (err) {
    res.status(500).json({ msg: "Preview failed", error: err.message });
  }
});

// ---------------- Download ----------------
router.get("/:id/download", auth, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ msg: "File not found" });

    const downloadUrl = cloudinary.url(doc.cloudinaryPublicId, {
      resource_type: "auto",
      secure: true,
      flags: "attachment",
    });

    res.redirect(downloadUrl);
  } catch (err) {
    res.status(500).json({ msg: "Download failed", error: err.message });
  }
});

// ---------------- Proxy (for inline preview) ----------------
router.get("/:id/proxy", auth, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ msg: "File not found" });

    const previewUrl = cloudinary.url(doc.cloudinaryPublicId, {
      resource_type: "auto",
      secure: true,
      format: doc.fileType?.includes("pdf") ? "pdf" : undefined,
    });

    const response = await axios.get(previewUrl, { responseType: "arraybuffer" });

    res.setHeader("Content-Type", doc.fileType || "application/octet-stream");
    res.send(response.data);
  } catch (err) {
    res.status(500).json({ msg: "Proxy failed", error: err.message });
  }
});

// ---------------- Delete ----------------
router.delete("/:id", auth, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ msg: "File not found" });

    if (doc.cloudinaryPublicId) {
      await cloudinary.uploader.destroy(doc.cloudinaryPublicId, { resource_type: "auto" });
    }

    await doc.deleteOne();
    res.json({ success: true, msg: "File deleted successfully" });
  } catch (err) {
    res.status(500).json({ msg: "Delete failed", error: err.message });
  }
});

export default router;
