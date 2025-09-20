import express from "express";
import multer from "multer";
import path from "path";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import { v2 as cloudinary } from "cloudinary";
import axios from "axios";
import { auth } from "../middleware/auth.js";
import { Document } from "../models/File.js";
import { User } from "../models/User.js";
import { checkSession, checkSessionByEmail } from "../middleware/checkSession.js";

const router = express.Router();

// ---------------- Cloudinary Config ----------------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ---------------- Storage ----------------
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

const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ---------------- Upload ----------------
router.post("/upload", auth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ msg: "No file uploaded" });

    const { title, category, date, notes } = req.body;

    const validCategories = ["Report", "Prescription", "Bill", "Insurance"];
    let chosenCategory = "Report"; // Default
    
    // Normalize the category to match valid categories
    const normalizedCategory = String(category || "").toLowerCase().trim();
    if (normalizedCategory.includes("report")) {
      chosenCategory = "Report";
    } else if (normalizedCategory.includes("prescription")) {
      chosenCategory = "Prescription";
    } else if (normalizedCategory.includes("bill")) {
      chosenCategory = "Bill";
    } else if (normalizedCategory.includes("insurance")) {
      chosenCategory = "Insurance";
    }

    // ✅ Ensure correct Cloudinary public_id is stored
    const publicId =
      req.file.public_id ||
      req.file.filename ||
      (req.file.path ? req.file.path.split("/").slice(-2).join("/") : null);

    const doc = await Document.create({
      userId: req.auth.id,
      doctorId: req.auth?.role === "doctor" ? req.auth.id : undefined,
      title: title || req.file.originalname,
      description: notes || "",
      type: chosenCategory,
      category: chosenCategory,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      fileType: req.file.mimetype,
      size: req.file.size,
      fileSize: req.file.size,
      cloudinaryUrl: req.file.path,
      cloudinaryPublicId: publicId,
      url: req.file.path,
      uploadedAt: date || new Date(),
    });

    // ✅ Link the document to the user's medicalRecords array
    await User.findByIdAndUpdate(req.auth.id, { $push: { medicalRecords: doc._id } });

    res.json({ success: true, document: doc });
  } catch (err) {
    res.status(500).json({ msg: "Upload failed", error: err.message });
  }
});

// ---------------- List Files ----------------
router.get("/user/:userId", auth, checkSession, async (req, res) => {
  try {
    const docs = await Document.find({ userId: req.params.userId }).sort({
      createdAt: -1,
    });
    const docsWithUrl = docs.map((doc) => ({
      ...doc.toObject(),
      url: doc.cloudinaryUrl,
    }));
    res.json({
      success: true,
      count: docsWithUrl.length,
      documents: docsWithUrl,
    });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, msg: "Error fetching files", error: err.message });
  }
});

// ---------------- Patient Files (alias for user) ----------------
router.get("/patient/:patientId", auth, checkSession, async (req, res) => {
  try {
    const docs = await Document.find({
      userId: req.params.patientId,
    }).sort({ createdAt: -1 });
    const docsWithUrl = docs.map((doc) => ({
      ...doc.toObject(),
      url: doc.cloudinaryUrl,
    }));
    res.json({
      success: true,
      count: docsWithUrl.length,
      documents: docsWithUrl,
    });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, msg: "Error fetching files", error: err.message });
  }
});

// ---------------- Grouped Files ----------------
router.get("/user/:userId/grouped", auth, checkSession, async (req, res) => {
  try {
    const docs = await Document.find({ userId: req.params.userId });

    const grouped = {
      reports: docs.filter((d) => d.category?.toLowerCase() === "report"),
      prescriptions: docs.filter(
        (d) => d.category?.toLowerCase() === "prescription"
      ),
      bills: docs.filter((d) => d.category?.toLowerCase() === "bill"),
      insurance: docs.filter((d) => d.category?.toLowerCase() === "insurance"),
    };

    const groupedWithUrl = Object.fromEntries(
      Object.entries(grouped).map(([key, docs]) => [
        key,
        docs.map((doc) => ({
          ...doc.toObject(),
          url: doc.cloudinaryUrl,
        })),
      ])
    );

    res.json({
      success: true,
      userId: req.params.userId,
      counts: Object.fromEntries(
        Object.entries(groupedWithUrl).map(([k, v]) => [k, v.length])
      ),
      records: groupedWithUrl,
    });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, msg: "Error grouping files", error: err.message });
  }
});

// ---------------- Grouped by Email ----------------
router.get("/grouped/:email", auth, checkSessionByEmail, async (req, res) => {
  try {
    console.log(`🔍 Fetching grouped docs for email: ${req.params.email}`);
    
    const user = await User.findOne({ email: req.params.email });
    if (!user) {
      console.log(`❌ User not found for email: ${req.params.email}`);
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    console.log(`✅ User found: ${user._id}`);
    
    const docs = await Document.find({ userId: user._id.toString() });
    console.log(`📁 Found ${docs.length} documents for user`);

    const grouped = {
      reports: docs.filter((d) => {
        const cat = d.category?.toLowerCase()?.trim();
        return cat === "report";
      }),
      prescriptions: docs.filter((d) => {
        const cat = d.category?.toLowerCase()?.trim();
        return cat === "prescription";
      }),
      bills: docs.filter((d) => {
        const cat = d.category?.toLowerCase()?.trim();
        return cat === "bill";
      }),
      insurance: docs.filter((d) => {
        const cat = d.category?.toLowerCase()?.trim();
        return cat === "insurance";
      }),
    };

    console.log(`📊 Grouped counts: Reports: ${grouped.reports.length}, Prescriptions: ${grouped.prescriptions.length}, Bills: ${grouped.bills.length}, Insurance: ${grouped.insurance.length}`);

    const groupedWithUrl = Object.fromEntries(
      Object.entries(grouped).map(([key, docs]) => [
        key,
        docs.map((doc) => ({
          ...doc.toObject(),
          url: doc.cloudinaryUrl,
        })),
      ])
    );

    const response = {
      success: true,
      userId: user._id.toString(),
      counts: Object.fromEntries(
        Object.entries(groupedWithUrl).map(([k, v]) => [k, v.length])
      ),
      records: groupedWithUrl,
    };

    console.log(`✅ Sending response with ${Object.values(response.records).map((list) => list.length).join(', ')} documents`);
    res.json(response);
  } catch (err) {
    console.error("❌ Grouped fetch error:", err);
    res
      .status(500)
      .json({ success: false, msg: "Error grouping files", error: err.message });
  }
});

// ---------------- Preview ----------------
router.get("/:id/preview", auth, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ msg: "File not found" });

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

    // Check if user owns this document or is authorized to access it
    if (doc.userId.toString() !== req.auth.id.toString()) {
      return res.status(403).json({ msg: "Unauthorized access" });
    }

    if (!doc.cloudinaryPublicId) {
      return res.status(400).json({ msg: "Missing Cloudinary publicId" });
    }

    // Generate a signed URL for download with attachment flag
    const downloadUrl = cloudinary.url(doc.cloudinaryPublicId, {
      resource_type: "auto",
      secure: true,
      flags: "attachment",
      sign_url: true,
      expires_at: Math.floor(Date.now() / 1000) + 3600, // 1 hour expiry
    });

    res.redirect(downloadUrl);
  } catch (err) {
    console.error("Download error:", err);
    res.status(500).json({ msg: "Download failed", error: err.message });
  }
});

// ---------------- Proxy (for inline preview) ----------------
router.get("/:id/proxy", auth, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ msg: "File not found" });

    // Check if user owns this document or is authorized to access it
    if (doc.userId.toString() !== req.auth.id.toString()) {
      return res.status(403).json({ msg: "Unauthorized access" });
    }

    if (!doc.cloudinaryPublicId) {
      return res.status(400).json({ msg: "Missing Cloudinary publicId" });
    }

    // Generate a signed URL for preview
    const previewUrl = cloudinary.url(doc.cloudinaryPublicId, {
      resource_type: "auto",
      secure: true,
      sign_url: true,
      expires_at: Math.floor(Date.now() / 1000) + 3600, // 1 hour expiry
      format: doc.fileType?.includes("pdf") ? "pdf" : undefined,
    });

    const response = await axios.get(previewUrl, { 
      responseType: "arraybuffer",
      timeout: 10000 // 10 second timeout
    });

    res.setHeader("Content-Type", doc.fileType || "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=3600"); // Cache for 1 hour
    res.send(response.data);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ msg: "Proxy failed", error: err.message });
  }
});

// ---------------- Delete ----------------
router.delete("/:id", auth, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ msg: "File not found" });

    // Check if user owns this document or is authorized to delete it
    if (doc.userId.toString() !== req.auth.id.toString()) {
      return res.status(403).json({ msg: "Unauthorized access" });
    }

    // Delete from Cloudinary if public ID exists
    if (doc.cloudinaryPublicId) {
      try {
        const cloudinaryResult = await cloudinary.uploader.destroy(doc.cloudinaryPublicId, {
          resource_type: "auto",
        });
        console.log("Cloudinary deletion result:", cloudinaryResult);
      } catch (cloudinaryErr) {
        console.error("Cloudinary deletion error:", cloudinaryErr);
        // Continue with database deletion even if Cloudinary fails
      }
    }

    // Delete from database
    await doc.deleteOne();
    
    // ✅ Remove the document reference from user's medicalRecords array
    await User.findByIdAndUpdate(doc.userId, { $pull: { medicalRecords: req.params.id } });
    
    console.log(`Document ${req.params.id} deleted successfully`);
    res.json({ success: true, msg: "File deleted successfully" });
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({ msg: "Delete failed", error: err.message });
  }
});

export default router;
