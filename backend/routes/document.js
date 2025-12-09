import express from "express";
import multer from "multer";
import multerS3 from "multer-s3";
import path from "path";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import axios from "axios";
import { auth } from "../middleware/auth.js";
import { requireVerified } from "../middleware/requireVerified.js";
import { Document } from "../models/File.js";
import { User } from "../models/User.js";
import { DoctorUser } from "../models/DoctorUser.js";
import { checkSession, checkSessionByEmail } from "../middleware/checkSession.js";
import { Session } from "../models/Session.js";
import s3Client, { BUCKET_NAME, REGION } from "../config/s3.js";
import { generateSignedUrl, generatePreviewUrl, generateDownloadUrl } from "../utils/s3Utils.js";
import { sendNotification } from "../utils/notifications.js";

const router = express.Router();

// ---------------- AWS S3 Storage ----------------
const storage = multerS3({
  s3: s3Client,
  bucket: BUCKET_NAME,
  key: (req, file, cb) => {
    const baseName = path.parse(file.originalname).name.replace(/\s+/g, "_");
    const ext = path.extname(file.originalname).toLowerCase();
    const fileName = `medical-vault/${Date.now()}-${baseName}${ext}`;
    cb(null, fileName);
  },
  contentType: multerS3.AUTO_CONTENT_TYPE,
  metadata: (req, file, cb) => {
    cb(null, {
      fieldName: file.fieldname,
      originalName: file.originalname,
      uploadedBy: req.auth?.id || 'unknown'
    });
  }
});

const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ---------------- Upload ----------------
router.post("/upload", auth, requireVerified, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ msg: "No file uploaded" });

    const { title, category, date, notes, userId } = req.body;
    
    console.log('📤 Upload request received:', {
      title,
      category,
      date,
      notes,
      userId,
      authId: req.auth.id,
      authRole: req.auth?.role
    });
    
    console.log('📅 Date processing:', {
      originalDate: date,
      dateType: typeof date,
      isEmpty: !date || date.trim() === '',
      currentTime: new Date().toISOString()
    });

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

    // ✅ Store S3 information
    const s3Key = req.file.key;
    const s3Bucket = req.file.bucket;

    // ✅ Support both doctor uploads (userId from req.body) and patient uploads (userId from req.auth.id)
    const targetUserId = req.body.userId || req.auth.id;
    
    console.log('🎯 Target userId determined:', {
      fromBody: req.body.userId,
      fromAuth: req.auth.id,
      finalTarget: targetUserId,
      isDoctorUpload: !!req.body.userId
    });
    
    // ✅ Properly handle date conversion
    let uploadDate = new Date(); // Default to current time
    if (date && date.trim() !== '') {
      try {
        const parsedDate = new Date(date);
        if (!isNaN(parsedDate.getTime())) {
          uploadDate = parsedDate;
        }
      } catch (error) {
        console.log('⚠️ Invalid date provided, using current time:', error.message);
      }
    }
    
    console.log('📅 Final upload date:', {
      uploadDate: uploadDate.toISOString(),
      uploadTimestamp: uploadDate.getTime()
    });

    const doc = await Document.create({
      userId: targetUserId,
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
      s3Key: s3Key,
      s3Bucket: s3Bucket,
      s3Region: REGION,
      url: req.file.location, // S3 public URL (if bucket is public) or will be replaced with signed URL
      uploadedAt: uploadDate,
    });

    // ✅ Link the document to the target user's medicalRecords array
    await User.findByIdAndUpdate(targetUserId, { $push: { medicalRecords: doc._id } });
    
    console.log('✅ Document created and linked:', {
      docId: doc._id,
      targetUserId: targetUserId,
      category: chosenCategory,
      title: doc.title
    });

    // Send notification to patient if doctor uploaded the document
    if (req.auth?.role === "doctor" && req.body.userId) {
      try {
        // Get doctor info for the notification
        const doctor = await DoctorUser.findById(req.auth.id);
        if (doctor) {
          // Create notification record in database
          const { Notification } = await import('../models/Notification.js');
          const notification = new Notification({
            title: "New Document Uploaded",
            body: `Dr. ${doctor.name} uploaded a new ${chosenCategory.toLowerCase()} to your medical records`,
            type: "document",
            data: {
              documentId: doc._id.toString(),
              category: chosenCategory,
              doctorId: doctor._id.toString(),
              doctorName: doctor.name,
              title: doc.title
            },
            recipientId: targetUserId,
            recipientRole: "patient",
            senderId: doctor._id.toString(),
            senderRole: "doctor"
          });
          await notification.save();
          
          // Send push notification
          await sendNotification(
            targetUserId,
            "New Document Uploaded",
            `Dr. ${doctor.name} uploaded a new ${chosenCategory.toLowerCase()} to your medical records`,
            {
              type: "FILE_UPLOAD",
              documentId: doc._id.toString(),
              category: chosenCategory,
              doctorId: doctor._id.toString(),
              doctorName: doctor.name,
              title: doc.title
            }
          );
          
          // Broadcast to SSE connections
          const { broadcastNotification } = await import('../controllers/notificationController.js');
          await broadcastNotification(notification);
          
          console.log('✅ Document upload notification created and sent');
        }
      } catch (notificationError) {
        console.error("❌ Failed to send file upload notification:", notificationError);
        // Don't fail the upload if notification fails
      }
    }

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
    
    // Generate signed URLs for each document
    const docsWithUrl = await Promise.all(
      docs.map(async (doc) => {
        try {
          const signedUrl = await generateSignedUrl(doc.s3Key, doc.s3Bucket);
          return {
            ...doc.toObject(),
            url: signedUrl,
          };
        } catch (error) {
          console.error(`Error generating URL for doc ${doc._id}:`, error);
          return {
            ...doc.toObject(),
            url: null,
            error: "Failed to generate access URL"
          };
        }
      })
    );
    
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
    
    // Generate signed URLs for each document
    const docsWithUrl = await Promise.all(
      docs.map(async (doc) => {
        try {
          const signedUrl = await generateSignedUrl(doc.s3Key, doc.s3Bucket);
          return {
            ...doc.toObject(),
            url: signedUrl,
          };
        } catch (error) {
          console.error(`Error generating URL for doc ${doc._id}:`, error);
          return {
            ...doc.toObject(),
            url: null,
            error: "Failed to generate access URL"
          };
        }
      })
    );
    
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

    // Generate signed URLs for each group
    const groupedWithUrl = Object.fromEntries(
      await Promise.all(
        Object.entries(grouped).map(async ([key, docs]) => [
          key,
          await Promise.all(
            docs.map(async (doc) => {
              try {
                const signedUrl = await generateSignedUrl(doc.s3Key, doc.s3Bucket);
                return {
                  ...doc.toObject(),
                  url: signedUrl,
                };
              } catch (error) {
                console.error(`Error generating URL for doc ${doc._id}:`, error);
                return {
                  ...doc.toObject(),
                  url: null,
                  error: "Failed to generate access URL"
                };
              }
            })
          ),
        ])
      )
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

    // Generate signed URLs for each group
    const groupedWithUrl = Object.fromEntries(
      await Promise.all(
        Object.entries(grouped).map(async ([key, docs]) => [
          key,
          await Promise.all(
            docs.map(async (doc) => {
              try {
                const signedUrl = await generateSignedUrl(doc.s3Key, doc.s3Bucket);
                return {
                  ...doc.toObject(),
                  url: signedUrl,
                };
              } catch (error) {
                console.error(`Error generating URL for doc ${doc._id}:`, error);
                return {
                  ...doc.toObject(),
                  url: null,
                  error: "Failed to generate access URL"
                };
              }
            })
          ),
        ])
      )
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
router.get("/:id/preview", auth, checkSession, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ msg: "File not found" });

    // Check if user owns this document or has active doctor-patient session
    const isOwner = doc.userId.toString() === req.auth.id.toString();
    let hasSessionAccess = false;
    if (!isOwner && req.auth?.role === "doctor") {
      // Validate active session explicitly in case middleware didn't populate req.session
      await Session.cleanExpiredSessions();
      const activeSession = await Session.findOne({
        doctorId: req.auth.id,
        patientId: doc.userId.toString(),
        status: "accepted",
        expiresAt: { $gt: new Date() },
      });
      hasSessionAccess = !!activeSession;
    }
    
    if (!isOwner && !hasSessionAccess && req.auth?.role !== 'anonymous') {
      return res.status(403).json({ msg: "Unauthorized access" });
    }

    const previewUrl = await generatePreviewUrl(doc.s3Key, doc.s3Bucket, doc.mimeType);
    const mode = req.auth?.role === 'anonymous' ? 'anonymous' : (req.auth?.role === 'doctor' ? 'doctor' : (isOwner ? 'patient' : 'unknown'));
    res.json({ success: true, signedUrl: previewUrl, mode });
  } catch (err) {
    res.status(500).json({ msg: "Preview failed", error: err.message });
  }
});

// ---------------- Download ----------------
router.get("/:id/download", auth, checkSession, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ msg: "File not found" });

    // Check if user owns this document or has active doctor-patient session
    const isOwner = doc.userId.toString() === req.auth.id.toString();
    let hasSessionAccess = false;
    if (!isOwner && req.auth?.role === "doctor") {
      await Session.cleanExpiredSessions();
      const activeSession = await Session.findOne({
        doctorId: req.auth.id,
        patientId: doc.userId.toString(),
        status: "accepted",
        expiresAt: { $gt: new Date() },
      });
      hasSessionAccess = !!activeSession;
    }
    
    if (!isOwner && !hasSessionAccess && req.auth?.role !== 'anonymous') {
      return res.status(403).json({ msg: "Unauthorized access" });
    }

    if (!doc.s3Key) {
      return res.status(400).json({ msg: "Missing S3 key" });
    }

    // Generate a signed URL for download with attachment flag
    const downloadUrl = await generateDownloadUrl(doc.s3Key, doc.s3Bucket);

    // If client prefers JSON (e.g., web app), return the URL instead of redirecting
    const acceptHeader = String(req.headers["accept"] || "").toLowerCase();
    if (acceptHeader.includes("application/json") || req.query.json === "true") {
      const mode = req.auth?.role === 'anonymous' ? 'anonymous' : (req.auth?.role === 'doctor' ? 'doctor' : (isOwner ? 'patient' : 'unknown'));
      return res.json({ success: true, signedUrl: downloadUrl, mode });
    }

    // Default behavior: redirect (good for mobile clients following redirects)
    res.redirect(downloadUrl);
  } catch (err) {
    console.error("Download error:", err);
    res.status(500).json({ msg: "Download failed", error: err.message });
  }
});

// ---------------- Proxy (for inline preview) ----------------
router.get("/:id/proxy", auth, checkSession, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ msg: "File not found" });

    // Check if user owns this document or has session access
    const isOwner = doc.userId.toString() === req.auth.id.toString();
    const hasSessionAccess = req.session && req.session.status === 'accepted';
    
    if (!isOwner && !hasSessionAccess) {
      return res.status(403).json({ msg: "Unauthorized access" });
    }

    if (!doc.s3Key) {
      return res.status(400).json({ msg: "Missing S3 key" });
    }

    // Generate a signed URL for preview
    const previewUrl = await generatePreviewUrl(doc.s3Key, doc.s3Bucket, doc.mimeType);

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

// ---------------- Update Document ----------------
router.put("/:id", auth, requireVerified, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, msg: "File not found" });

    // Check if user owns this document
    if (doc.userId.toString() !== req.auth.id.toString()) {
      return res.status(403).json({ success: false, msg: "Unauthorized access" });
    }

    const { title, category, date, description, notes } = req.body;

    // Validate and normalize category
    const validCategories = ["Report", "Prescription", "Bill", "Insurance"];
    let chosenCategory = doc.category || "Report"; // Keep existing if not provided
    
    if (category) {
      const normalizedCategory = String(category).toLowerCase().trim();
      if (normalizedCategory.includes("report")) {
        chosenCategory = "Report";
      } else if (normalizedCategory.includes("prescription")) {
        chosenCategory = "Prescription";
      } else if (normalizedCategory.includes("bill")) {
        chosenCategory = "Bill";
      } else if (normalizedCategory.includes("insurance")) {
        chosenCategory = "Insurance";
      }
    }

    // Prepare update object
    const updateData = {};
    if (title !== undefined) updateData.title = title;
    if (chosenCategory) {
      updateData.category = chosenCategory;
      updateData.type = chosenCategory;
    }
    if (description !== undefined) updateData.description = description;
    if (notes !== undefined) updateData.notes = notes;
    if (date !== undefined && date.trim() !== '') {
      try {
        const parsedDate = new Date(date);
        if (!isNaN(parsedDate.getTime())) {
          updateData.uploadedAt = parsedDate;
          updateData.date = date;
        }
      } catch (error) {
        console.log('⚠️ Invalid date provided, keeping existing date:', error.message);
      }
    }

    // Update document
    const updatedDoc = await Document.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    // Generate signed URL for response
    let signedUrl = null;
    if (updatedDoc.s3Key) {
      try {
        signedUrl = await generateSignedUrl(updatedDoc.s3Key, updatedDoc.s3Bucket);
      } catch (error) {
        console.error("Error generating signed URL:", error);
      }
    }

    res.json({
      success: true,
      document: {
        ...updatedDoc.toObject(),
        url: signedUrl,
      },
    });
  } catch (err) {
    console.error("Update error:", err);
    res.status(500).json({ success: false, msg: "Update failed", error: err.message });
  }
});

// ---------------- Delete ----------------
router.delete("/:id", auth, requireVerified, async (req, res) => {
  try {
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ msg: "File not found" });

    // Check if user owns this document or is authorized to delete it
    if (doc.userId.toString() !== req.auth.id.toString()) {
      return res.status(403).json({ msg: "Unauthorized access" });
    }

    // Delete from S3 if key exists
    if (doc.s3Key) {
      try {
        const deleteCommand = new DeleteObjectCommand({
          Bucket: doc.s3Bucket,
          Key: doc.s3Key,
        });
        
        await s3Client.send(deleteCommand);
        console.log("S3 deletion successful for key:", doc.s3Key);
      } catch (s3Err) {
        console.error("S3 deletion error:", s3Err);
        // Continue with database deletion even if S3 fails
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
