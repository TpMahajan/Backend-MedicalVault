import express from "express";
import multer from "multer";
import path from "path";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import { v2 as cloudinary } from "cloudinary";
import axios from "axios";   // ✅ add this
import File from "../models/File.js";

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

    if (ext === ".pdf") {
      return {
        folder: "medical-vault",
        public_id: `${Date.now()}-${baseName}`,
        resource_type: "auto",
        format: "pdf",   // ✅ force pdf format
      };
    }

    return {
      folder: "medical-vault",
      public_id: `${Date.now()}-${baseName}`,
      resource_type: "auto",
    };
  },
});

// ---------------- Multer Fix ----------------
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === ".pdf" && file.mimetype === "application/octet-stream") {
      console.log(`🔧 FILEFILTER: Fixing PDF mimetype → application/pdf`);
      file.mimetype = "application/pdf";
    }
    cb(null, true);
  },
});

// ---------------- Upload ----------------
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ msg: "No file uploaded" });

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext === ".pdf" && req.file.mimetype !== "application/pdf") {
      req.file.mimetype = "application/pdf";
    }

    console.log("📂 Uploaded file:", req.file);

    const { email, title, category, date, notes } = req.body;

    const newFile = await File.create({
      userId: email,
      title: title || req.file.originalname,
      notes: notes || "",
      date: date || new Date().toISOString(),
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      url: req.file.path,
      publicId: req.file.filename,
      resourceType: "auto",
      category: category || "Other",
    });

    res.json({
      ok: true,
      file: {
        id: newFile._id.toString(),
        userId: newFile.userId,
        title: newFile.title,
        notes: newFile.notes,
        date: newFile.date,
        fileName: newFile.originalName,
        fileType: newFile.mimeType?.split("/").pop() || "file",
        uploadedAt: newFile.createdAt,
        url: newFile.url,
        category: newFile.category,
        resourceType: newFile.resourceType,
        publicId: newFile.publicId,
      },
    });
  } catch (err) {
    res.status(500).json({ msg: "Upload failed", err: err.message });
  }
});

// ---------------- List Files ----------------
router.get("/", async (req, res) => {
  try {
    const { email, category } = req.query;
    const query = {};
    if (email) query.userId = email;
    if (category) query.category = { $regex: new RegExp(`^${category}$`, "i") };

    const files = await File.find(query).sort({ createdAt: -1 });

    res.json({
      success: true,
      count: files.length,
      documents: files.map((f) => ({
        id: f._id.toString(),
        userId: f.userId,
        title: f.title || f.originalName,
        notes: f.notes,
        date: f.date,
        fileName: f.originalName,
        fileType: f.mimeType?.split("/").pop() || "file",
        uploadedAt: f.createdAt,
        url: f.url,
        category: f.category,
        resourceType: f.resourceType || "auto",
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, msg: "Error fetching files", err: err.message });
  }
});

// ---------------- Download ----------------
router.get("/download/:id", async (req, res) => {
  try {
    const file = await File.findById(req.params.id);
    if (!file) return res.status(404).json({ msg: "File not found" });

    const downloadUrl = cloudinary.url(file.publicId, {
      resource_type: file.resourceType || "auto",
      secure: true,
      flags: "attachment",
    });

    return res.redirect(downloadUrl);
  } catch (err) {
    res.status(500).json({ msg: "Error downloading file", err: err.message });
  }
});

// ---------------- Proxy for Preview ----------------
router.get("/proxy/:id", async (req, res) => {
  try {
    const file = await File.findById(req.params.id);
    if (!file) return res.status(404).json({ msg: "File not found" });

    // ✅ Generate a proper Cloudinary delivery URL instead of using stored file.url
    const previewUrl = cloudinary.url(file.publicId, {
      resource_type: file.resourceType || "auto",
      secure: true,
      format: file.originalName.toLowerCase().endsWith(".pdf") ? "pdf" : undefined
    });

    console.log(`📄 Proxy fetching from: ${previewUrl}`);

    const response = await axios.get(previewUrl, { responseType: "arraybuffer" });

    // Force correct content type
    if (file.originalName.toLowerCase().endsWith(".pdf")) {
      res.setHeader("Content-Type", "application/pdf");
    } else {
      res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
    }

    res.send(response.data);
  } catch (err) {
    console.error("❌ Proxy error:", err.message);
    res.status(500).json({ msg: "Error proxying file", err: err.message });
  }
});


// ---------------- Delete ----------------
router.delete("/:id", async (req, res) => {
  try {
    const file = await File.findById(req.params.id);
    if (!file) return res.status(404).json({ msg: "File not found" });

    if (file.publicId) {
      try {
        await cloudinary.uploader.destroy(file.publicId, {
          resource_type: file.resourceType || "auto",
        });
      } catch (cloudinaryErr) {
        console.error("⚠️ Cloudinary deletion failed:", cloudinaryErr);
      }
    }

    await File.deleteOne({ _id: file._id });

    res.json({
      ok: true,
      msg: "File deleted successfully",
      deletedFile: { id: file._id.toString(), title: file.title, fileName: file.originalName },
    });
  } catch (err) {
    res.status(500).json({ msg: "Error deleting file", err: err.message });
  }
});

// ---------------- Grouped Files by Category ----------------
router.get("/grouped/:email", async (req, res) => {
  try {
    const { email } = req.params;
    const files = await File.find({ userId: email });

    const grouped = {
      reports: files.filter(f => f.category?.toLowerCase() === "report"),
      prescriptions: files.filter(f => f.category?.toLowerCase() === "prescription"),
      bills: files.filter(f => f.category?.toLowerCase() === "bill"),
      insurance: files.filter(f => f.category?.toLowerCase() === "insurance"),
      others: files.filter(
        f =>
          !["report", "prescription", "bill", "insurance"].includes(
            f.category?.toLowerCase()
          )
      ),
    };

    res.json({
      success: true,
      email,
      counts: {
        reports: grouped.reports.length,
        prescriptions: grouped.prescriptions.length,
        bills: grouped.bills.length,
        insurance: grouped.insurance.length,
        others: grouped.others.length,
      },
      records: grouped,
    });
  } catch (error) {
    console.error("❌ Error fetching grouped files:", error);
    res.status(500).json({ message: "Failed to fetch grouped files" });
  }
});


export default router;
