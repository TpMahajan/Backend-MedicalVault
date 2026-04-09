import express from "express";
import multer from "multer";
import multerS3 from "multer-s3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import axios from "axios";
import { auth } from "../middleware/auth.js";
import { requireVerified } from "../middleware/requireVerified.js";
import { Document } from "../models/File.js";
import { User } from "../models/User.js";
import { DoctorUser } from "../models/DoctorUser.js";
import { Session } from "../models/Session.js";
import { checkSession, checkSessionByEmail } from "../middleware/checkSession.js";
import s3Client, { BUCKET_NAME, REGION } from "../config/s3.js";
import { generateSignedUrl, generatePreviewUrl, generateDownloadUrl } from "../utils/s3Utils.js";
import { sendNotification } from "../utils/notifications.js";
import { canDoctorAccessPatient } from "../services/accessControl.js";
import { writeAuditLog } from "../middleware/auditLogger.js";
import { uploadLimiter } from "../middleware/rateLimit.js";

const router = express.Router();

const privilegedRoles = new Set(["admin", "superadmin"]);
const MALWARE_SCAN_API_URL = String(process.env.MALWARE_SCAN_API_URL || "").trim();
const MALWARE_SCAN_FAIL_CLOSED =
  String(process.env.MALWARE_SCAN_FAIL_CLOSED || "false").toLowerCase() === "true";
const allowedMimeTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const magicSignatureByMime = {
  "application/pdf": [[0x25, 0x50, 0x44, 0x46]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47]],
  "image/webp": [[0x52, 0x49, 0x46, 0x46]], // RIFF....WEBP
  "application/msword": [[0xd0, 0xcf, 0x11, 0xe0]],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [[0x50, 0x4b, 0x03, 0x04]],
};

const validateUploadFilename = (name = "") => {
  const normalized = String(name || "").toLowerCase();
  return /\.(pdf|jpg|jpeg|png|webp|doc|docx)$/.test(normalized);
};
const isValidObjectId = (value) => /^[a-fA-F0-9]{24}$/.test(String(value || ""));

const isRole = (req, role) => String(req.auth?.role || "").toLowerCase() === role;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const localUploadsRoot = path.resolve(__dirname, "../uploads");
const localMedicalVaultUploadsRoot = path.resolve(localUploadsRoot, "medical-vault");

const getApiBaseUrl = (req) => {
  const protoHeader = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const hostHeader = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  const proto = protoHeader || req.protocol || "http";
  const host = hostHeader || `localhost:${process.env.PORT || 5000}`;
  return `${proto}://${host}`;
};

const buildProxyUrl = (req, docId, disposition = "inline") => {
  const safeDisposition = disposition === "attachment" ? "attachment" : "inline";
  return `${getApiBaseUrl(req)}/api/files/${docId}/proxy?disposition=${safeDisposition}`;
};

const buildLocalUploadUrl = (req, fileName) =>
  `${getApiBaseUrl(req)}/uploads/medical-vault/${encodeURIComponent(String(fileName || "").trim())}`;

const getOptionalDocumentField = (doc, key) => doc?.get?.(key) ?? doc?.[key] ?? null;

const resolveStoredDocumentUrl = (req, doc) => {
  const candidates = [
    getOptionalDocumentField(doc, "url"),
    getOptionalDocumentField(doc, "fileUrl"),
    getOptionalDocumentField(doc, "documentUrl"),
    getOptionalDocumentField(doc, "location"),
  ].filter((value) => typeof value === "string" && value.trim());

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }
    if (trimmed.startsWith("/uploads/")) {
      return `${getApiBaseUrl(req)}${trimmed}`;
    }
    if (trimmed.startsWith("uploads/")) {
      return `${getApiBaseUrl(req)}/${trimmed}`;
    }
  }

  return null;
};

const resolveLocalDocumentPath = (doc) => {
  const candidates = [];

  const addUploadRelativePath = (rawValue) => {
    if (!rawValue) return;
    const normalized = rawValue.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^uploads\//i, "");
    if (!normalized) return;
    candidates.push(path.resolve(process.cwd(), "uploads", normalized));
    candidates.push(path.resolve(localUploadsRoot, normalized));
  };

  const addCandidate = (rawValue) => {
    if (!rawValue || typeof rawValue !== "string") return;
    const trimmed = rawValue.trim();
    if (!trimmed) return;

    try {
      if (/^https?:\/\//i.test(trimmed)) {
        const pathname = decodeURIComponent(new URL(trimmed).pathname || "");
        const uploadsIndex = pathname.toLowerCase().lastIndexOf("/uploads/");
        if (uploadsIndex >= 0) {
          addUploadRelativePath(pathname.slice(uploadsIndex + "/uploads/".length));
        }
        return;
      }
    } catch {
      // Fall through to direct path resolution.
    }

    const normalized = trimmed.replace(/\\/g, "/");
    const uploadsIndex = normalized.toLowerCase().lastIndexOf("/uploads/");
    if (uploadsIndex >= 0) {
      addUploadRelativePath(normalized.slice(uploadsIndex + "/uploads/".length));
    } else if (normalized.toLowerCase().startsWith("uploads/")) {
      addUploadRelativePath(normalized.slice("uploads/".length));
    }

    candidates.push(path.resolve(trimmed));
    candidates.push(path.resolve(process.cwd(), normalized.replace(/^\/+/, "")));
    candidates.push(path.resolve(localUploadsRoot, normalized.replace(/^uploads\/+/i, "").replace(/^\/+/, "")));
  };

  [
    "path",
    "filePath",
    "localFilePath",
    "url",
    "fileUrl",
    "documentUrl",
    "location",
  ].forEach((field) => addCandidate(getOptionalDocumentField(doc, field)));

  const fileName =
    getOptionalDocumentField(doc, "filename") ||
    getOptionalDocumentField(doc, "fileName") ||
    getOptionalDocumentField(doc, "originalName");

  if (typeof fileName === "string" && fileName.trim()) {
    candidates.push(path.resolve(process.cwd(), "uploads", fileName.trim()));
    candidates.push(path.resolve(process.cwd(), "uploads", "medical-vault", fileName.trim()));
    candidates.push(path.resolve(localUploadsRoot, fileName.trim()));
    candidates.push(path.resolve(localUploadsRoot, "medical-vault", fileName.trim()));
  }

  return [...new Set(candidates.filter(Boolean))].find((candidatePath) => fs.existsSync(candidatePath)) || "";
};

const resolvePreviewFallbackUrl = (req, doc) => {
  if (resolveLocalDocumentPath(doc)) {
    return buildProxyUrl(req, doc._id.toString(), "inline");
  }
  return resolveStoredDocumentUrl(req, doc) || buildProxyUrl(req, doc._id.toString(), "inline");
};

const resolveDownloadFallbackUrl = (req, doc) =>
  buildProxyUrl(req, doc._id.toString(), "attachment");

const tryProxyStoredDocument = async (req, res, doc, disposition = "inline") => {
  const storedUrl = resolveStoredDocumentUrl(req, doc);
  if (!storedUrl) return false;

  try {
    const response = await axios.get(storedUrl, {
      responseType: "arraybuffer",
      timeout: 10000,
    });
    res.setHeader("Content-Type", response.headers["content-type"] || doc.fileType || "application/octet-stream");
    res.setHeader("Content-Disposition", disposition === "attachment" ? "attachment" : "inline");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.end(Buffer.from(response.data));
    return true;
  } catch (error) {
    console.error(`Stored URL proxy failed for doc ${doc?._id}:`, error?.message || error);
    return false;
  }
};

const canAccessDocument = async (req, doc) => {
  const role = String(req.auth?.role || "").toLowerCase();
  const requesterId = String(req.auth?.id || "");
  const patientId = String(doc.userId || "");

  if (privilegedRoles.has(role)) return true;
  if (role === "patient") return requesterId === patientId;
  if (role === "doctor") {
    return canDoctorAccessPatient(requesterId, patientId);
  }
  return false;
};

const runMalwareScan = async ({ bucket, key, mimeType, size }) => {
  if (!MALWARE_SCAN_API_URL) {
    if (MALWARE_SCAN_FAIL_CLOSED) {
      throw new Error("Malware scan service is not configured");
    }
    return { status: "skipped", clean: true };
  }

  const response = await axios.post(
    MALWARE_SCAN_API_URL,
    { bucket, key, mimeType, size },
    { timeout: Number(process.env.MALWARE_SCAN_TIMEOUT_MS || 15000) }
  );

  const clean = response?.data?.clean === true;
  if (!clean) {
    throw new Error(response?.data?.message || "Malware scan failed");
  }

  return { status: "passed", clean: true };
};

const readStreamToBuffer = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const hasSignature = (buffer, signature) => signature.every((byte, idx) => buffer[idx] === byte);

const validateMagicBytes = async ({ bucket, key, mimeType }) => {
  const allowedSignatures = magicSignatureByMime[String(mimeType || "").toLowerCase()];
  if (!allowedSignatures || allowedSignatures.length === 0) return true;
  const object = await s3Client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: "bytes=0-15",
    })
  );
  const firstBytes = await readStreamToBuffer(object.Body);
  if (String(mimeType).toLowerCase() === "image/webp") {
    return hasSignature(firstBytes, [0x52, 0x49, 0x46, 0x46]) && firstBytes.includes(Buffer.from("WEBP"));
  }
  return allowedSignatures.some((signature) => hasSignature(firstBytes, signature));
};

// ---------------- AWS S3 Storage ----------------
const s3Storage = multerS3({
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
      uploadedBy: req.auth?.id || "unknown",
    });
  },
});

const localDiskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(localMedicalVaultUploadsRoot, { recursive: true });
    cb(null, localMedicalVaultUploadsRoot);
  },
  filename: (req, file, cb) => {
    const baseName = path.parse(file.originalname).name.replace(/\s+/g, "_");
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${baseName}${ext}`);
  },
});

const createUploadMiddleware = (storage) =>
  multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (!allowedMimeTypes.has(String(file.mimetype || "").toLowerCase())) {
        return cb(new Error("Unsupported file type"), false);
      }
      if (!validateUploadFilename(file.originalname)) {
        return cb(new Error("Unsupported file extension"), false);
      }
      return cb(null, true);
    },
  });

const s3Upload = createUploadMiddleware(s3Storage);
const localUpload = createUploadMiddleware(localDiskStorage);

const canUseS3Upload = async () => {
  try {
    const credentialProvider = s3Client?.config?.credentials;
    if (!credentialProvider) return false;
    const credentials =
      typeof credentialProvider === "function" ? await credentialProvider() : await credentialProvider;
    return Boolean(credentials?.accessKeyId && credentials?.secretAccessKey);
  } catch (error) {
    const message = String(error?.message || "");
    if (message) {
      console.warn(`[document-upload] S3 credentials unavailable, using local storage fallback: ${message}`);
    }
    return false;
  }
};

const singleDocumentUpload = (req, res, next) => {
  canUseS3Upload()
    .then((useS3Upload) => {
      req.documentUploadStorage = useS3Upload ? "s3" : "local";
      const selectedUpload = useS3Upload ? s3Upload : localUpload;

      selectedUpload.single("file")(req, res, (err) => {
        if (!err) {
          if (req.file && req.documentUploadStorage === "local") {
            const storedFileName = req.file.filename || path.basename(req.file.path || "");
            req.file.key = `medical-vault/${storedFileName}`;
            req.file.bucket = "local";
            req.file.location = buildLocalUploadUrl(req, storedFileName);
          }
          return next();
        }

        const statusCode = err?.code === "LIMIT_FILE_SIZE" ? 400 : 500;
        const message = err?.message || "Upload failed";
        console.error("Document upload middleware error:", err);
        return res.status(statusCode).json({
          success: false,
          msg: message,
          error: message,
        });
      });
    })
    .catch((err) => {
      const message = err?.message || "Upload failed";
      console.error("Document upload middleware bootstrap error:", err);
      return res.status(500).json({
        success: false,
        msg: message,
        error: message,
      });
    });
};

// ---------------- Upload ----------------
router.post("/upload", auth, requireVerified, uploadLimiter, singleDocumentUpload, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ msg: "No file uploaded" });

    const { title, category, date, notes, userId } = req.body;

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
    const usingS3Storage = req.documentUploadStorage !== "local";
    const s3Key = req.file.key;
    const s3Bucket = req.file.bucket;
    const storedUrl =
      req.file.location ||
      (req.file.filename ? buildLocalUploadUrl(req, req.file.filename) : "");

    // ✅ Support both doctor uploads (userId from req.body) and patient uploads (userId from req.auth.id)
    const requesterRole = String(req.auth?.role || "").toLowerCase();
    const requesterId = String(req.auth?.id || "");
    const requestedTargetId = String(req.body.userId || req.body.patientId || "").trim();
    let targetUserId = requesterId;

    if (requesterRole === "patient") {
      if (requestedTargetId && requestedTargetId !== requesterId) {
        return res.status(403).json({ success: false, msg: "Patients can only upload to their own records" });
      }
      targetUserId = requesterId;
    } else if (requesterRole === "doctor") {
      let activeSessionPatientId = "";
      if (requestedTargetId && isValidObjectId(requestedTargetId)) {
        const activeSession = await Session.findOne({
          doctorId: requesterId,
          patientId: requestedTargetId,
          status: "accepted",
          isActive: true,
          expiresAt: { $gt: new Date() },
        })
          .select("patientId")
          .lean();

        activeSessionPatientId = String(activeSession?.patientId || "").trim();
      }

      targetUserId = activeSessionPatientId || requestedTargetId || "";
      if (!targetUserId) {
        return res.status(400).json({ success: false, msg: "Doctors must provide target patient userId" });
      }
      if (!isValidObjectId(targetUserId)) {
        return res.status(400).json({ success: false, msg: "Invalid target patient userId" });
      }
      const allowed = await canDoctorAccessPatient(requesterId, targetUserId);
      if (!allowed) {
        return res.status(403).json({ success: false, msg: "No active doctor-patient relationship" });
      }
    } else if (privilegedRoles.has(requesterRole)) {
      targetUserId = requestedTargetId || "";
      if (!targetUserId) {
        return res.status(400).json({ success: false, msg: "target userId is required" });
      }
      if (!isValidObjectId(targetUserId)) {
        return res.status(400).json({ success: false, msg: "Invalid target userId" });
      }
    } else {
      return res.status(403).json({ success: false, msg: "Unauthorized role for upload" });
    }

    const targetUser = await User.findById(targetUserId).select("_id").lean();
    if (!targetUser) {
      return res.status(404).json({ success: false, msg: "Target user not found" });
    }

    if (usingS3Storage) {
      try {
        const magicOk = await validateMagicBytes({
          bucket: s3Bucket,
          key: s3Key,
          mimeType: req.file.mimetype,
        });
        if (!magicOk) {
          throw new Error("Magic-byte validation failed");
        }
        await runMalwareScan({
          bucket: s3Bucket,
          key: s3Key,
          mimeType: req.file.mimetype,
          size: req.file.size,
        });
      } catch (scanError) {
        try {
          await s3Client.send(
            new DeleteObjectCommand({
              Bucket: s3Bucket,
              Key: s3Key,
            })
          );
        } catch (cleanupError) {
          console.error("Failed to cleanup untrusted upload:", cleanupError.message);
        }

        return res.status(400).json({
          success: false,
          msg: "Uploaded file failed security checks",
        });
      }
    }

    // ✅ Properly handle date conversion
    let uploadDate = new Date(); // Default to current time
    if (date && date.trim() !== '') {
      try {
        const parsedDate = new Date(date);
        if (!isNaN(parsedDate.getTime())) {
          uploadDate = parsedDate;
        }
      } catch (error) {
        // Keep default upload date when input is malformed.
      }
    }

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
      url: storedUrl,
      uploadedAt: uploadDate,
    });

    // ✅ Link the document to the target user's medicalRecords array
    await User.findByIdAndUpdate(targetUserId, { $push: { medicalRecords: doc._id } });


    // Send notification to patient if doctor uploaded the document
    if (req.auth?.role === "doctor" && (req.body.userId || req.body.patientId)) {
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

    await writeAuditLog({
      req,
      action: "UPLOAD_DOCUMENT",
      resourceType: "DOCUMENT",
      resourceId: doc._id?.toString(),
      patientId: targetUserId,
      statusCode: 200,
      metadata: { category: chosenCategory, mimeType: req.file.mimetype },
    });

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

// ---------------- Grouped Files (patient alias for web compatibility) ----------------
// GET /api/files/patient/:patientId/grouped
router.get("/patient/:patientId/grouped", auth, checkSession, async (req, res) => {
  try {
    // Delegate to the canonical user grouping logic
    const userId = req.params.patientId;
    const docs = await Document.find({ userId });

    const grouped = {
      reports: docs.filter((d) => d.category?.toLowerCase() === "report"),
      prescriptions: docs.filter((d) => d.category?.toLowerCase() === "prescription"),
      bills: docs.filter((d) => d.category?.toLowerCase() === "bill"),
      insurance: docs.filter((d) => d.category?.toLowerCase() === "insurance"),
    };

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
                  error: "Failed to generate access URL",
                };
              }
            })
          ),
        ])
      )
    );

    res.json({
      success: true,
      userId,
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
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ msg: "Invalid file id" });
    }
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ msg: "File not found" });

    const allowed = await canAccessDocument(req, doc);
    if (!allowed) {
      return res.status(403).json({ msg: "Unauthorized access" });
    }

    const localFilePath = resolveLocalDocumentPath(doc);
    let previewUrl;
    if (localFilePath) {
      previewUrl = buildProxyUrl(req, doc._id.toString(), "inline");
    } else {
      try {
        previewUrl = await generatePreviewUrl(doc.s3Key, doc.s3Bucket, doc.mimeType);
      } catch (error) {
        console.error(`Preview signed URL fallback for doc ${doc?._id}:`, error?.message || error);
        previewUrl = resolvePreviewFallbackUrl(req, doc);
      }
    }

    const isDocumentNavigation =
      String(req.headers["sec-fetch-dest"] || "").toLowerCase() === "document";
    if (isDocumentNavigation) {
      try {
        if (localFilePath && fs.existsSync(localFilePath)) {
          res.setHeader("Content-Type", doc.mimeType || doc.fileType || "application/octet-stream");
          res.setHeader("Content-Disposition", "inline");

          return fs.createReadStream(localFilePath).pipe(res);
        }
      } catch (err) {
        console.error("Preview error:", err);
      }

      if (previewUrl) {
        return res.redirect(previewUrl);
      }
    }

    const mode = String(req.auth?.role || "patient").toLowerCase();
    await writeAuditLog({
      req,
      action: "PREVIEW_DOCUMENT",
      resourceType: "DOCUMENT",
      resourceId: doc._id?.toString(),
      patientId: doc.userId?.toString?.() || "",
      statusCode: 200,
    });
    res.json({
      success: true,
      signedUrl: previewUrl,
      fileUrl: previewUrl,
      proxyUrl: buildProxyUrl(req, doc._id.toString(), "inline"),
      mode,
    });
  } catch (err) {
    res.status(500).json({ msg: "Preview failed", error: err.message });
  }
});

// ---------------- Download ----------------
router.get("/:id/download", auth, checkSession, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ msg: "Invalid file id" });
    }
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ msg: "File not found" });

    const allowed = await canAccessDocument(req, doc);
    if (!allowed) {
      return res.status(403).json({ msg: "Unauthorized access" });
    }

    let downloadUrl;
    if (doc.s3Key) {
      try {
        downloadUrl = await generateDownloadUrl(doc.s3Key, doc.s3Bucket);
      } catch (error) {
        console.error(`Download signed URL fallback for doc ${doc?._id}:`, error?.message || error);
        downloadUrl = resolveDownloadFallbackUrl(req, doc);
      }
    } else {
      downloadUrl = resolveDownloadFallbackUrl(req, doc);
    }

    // If client prefers JSON (e.g., web app), return the URL instead of redirecting
    const acceptHeader = String(req.headers["accept"] || "").toLowerCase();
    if (acceptHeader.includes("application/json") || req.query.json === "true") {
      const mode = String(req.auth?.role || "patient").toLowerCase();
      await writeAuditLog({
        req,
        action: "DOWNLOAD_DOCUMENT",
        resourceType: "DOCUMENT",
        resourceId: doc._id?.toString(),
        patientId: doc.userId?.toString?.() || "",
        statusCode: 200,
      });
      return res.json({
        success: true,
        signedUrl: downloadUrl,
        fileUrl: downloadUrl,
        proxyUrl: buildProxyUrl(req, doc._id.toString(), "attachment"),
        mode,
      });
    }

    // Default behavior: redirect (good for mobile clients following redirects)
    await writeAuditLog({
      req,
      action: "DOWNLOAD_DOCUMENT",
      resourceType: "DOCUMENT",
      resourceId: doc._id?.toString(),
      patientId: doc.userId?.toString?.() || "",
      statusCode: 302,
    });
    res.redirect(downloadUrl);
  } catch (err) {
    console.error("Download error:", err);
    res.status(500).json({ msg: "Download failed", error: err.message });
  }
});

// ---------------- Proxy (for inline preview) ----------------
router.get("/:id/proxy", auth, checkSession, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ msg: "Invalid file id" });
    }
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ msg: "File not found" });

    const allowed = await canAccessDocument(req, doc);
    if (!allowed) {
      return res.status(403).json({ msg: "Unauthorized access" });
    }

    const localFilePath = resolveLocalDocumentPath(doc);
    if (localFilePath) {
      res.setHeader("Content-Type", doc.mimeType || doc.fileType || "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        req.query.disposition === "attachment" ? "attachment" : "inline"
      );
      res.setHeader("Cache-Control", "public, max-age=3600");
      await writeAuditLog({
        req,
        action: "PROXY_DOCUMENT",
        resourceType: "DOCUMENT",
        resourceId: doc._id?.toString(),
        patientId: doc.userId?.toString?.() || "",
        statusCode: 200,
      });
      return fs.createReadStream(localFilePath).pipe(res);
    }

    if (doc.s3Key) {
      try {
        const previewUrl = await generatePreviewUrl(doc.s3Key, doc.s3Bucket, doc.mimeType);

        const response = await axios.get(previewUrl, {
          responseType: "arraybuffer",
          timeout: 10000 // 10 second timeout
        });

        res.setHeader("Content-Type", doc.fileType || "application/octet-stream");
        res.setHeader(
          "Content-Disposition",
          req.query.disposition === "attachment" ? "attachment" : "inline"
        );
        res.setHeader("Cache-Control", "public, max-age=3600"); // Cache for 1 hour
        await writeAuditLog({
          req,
          action: "PROXY_DOCUMENT",
          resourceType: "DOCUMENT",
          resourceId: doc._id?.toString(),
          patientId: doc.userId?.toString?.() || "",
          statusCode: 200,
        });
        return res.end(Buffer.from(response.data));
      } catch (error) {
        console.error(`Proxy S3 fallback for doc ${doc?._id}:`, error?.message || error);
      }
    }

    if (await tryProxyStoredDocument(req, res, doc, req.query.disposition)) {
      await writeAuditLog({
        req,
        action: "PROXY_DOCUMENT",
        resourceType: "DOCUMENT",
        resourceId: doc._id?.toString(),
        patientId: doc.userId?.toString?.() || "",
        statusCode: 200,
      });
      return;
    }

    try {
      const file = await Document.findById(req.params.id);
      const filePath = file?.path ? path.resolve(file.path) : "";

      if (filePath && fs.existsSync(filePath)) {
        res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
        res.setHeader("Content-Disposition", "inline");
        await writeAuditLog({
          req,
          action: "PROXY_DOCUMENT",
          resourceType: "DOCUMENT",
          resourceId: doc._id?.toString(),
          patientId: doc.userId?.toString?.() || "",
          statusCode: 200,
        });
        return fs.createReadStream(filePath).pipe(res);
      }
    } catch (err) {
      console.error("Preview error:", err);
    }

    await writeAuditLog({
      req,
      action: "PROXY_DOCUMENT",
      resourceType: "DOCUMENT",
      resourceId: doc._id?.toString(),
      patientId: doc.userId?.toString?.() || "",
      statusCode: 400,
    });
    return res.status(404).end();
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).json({ msg: "Proxy failed", error: err.message });
  }
});

// ---------------- Update Document ----------------
router.put("/:id", auth, requireVerified, checkSession, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, msg: "Invalid file id" });
    }
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, msg: "File not found" });

    const allowed = await canAccessDocument(req, doc);
    if (!allowed) {
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
router.delete("/:id", auth, requireVerified, checkSession, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ msg: "Invalid file id" });
    }
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ msg: "File not found" });

    const allowed = await canAccessDocument(req, doc);
    if (!allowed) {
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
