import express from "express";
import fs from "fs";
import multer from "multer";
import multerS3 from "multer-s3";
import path from "path";
import { fileURLToPath } from "url";
import { auth } from "../middleware/auth.js";
import {
  createLostReport,
  createFoundReport,
  getMyLostReports,
  searchLostReports,
  searchLostReportsByPhoto,
  getLostReportDetail,
  getLostReportNameSuggestions,
} from "../controllers/lostFoundController.js";
import {
  lostPhotoSearchLimiter,
  lostReportLimiter,
} from "../middleware/rateLimit.js";
import s3Client, { BUCKET_NAME } from "../config/s3.js";
import { generateSignedUrl } from "../utils/s3Utils.js";
import { resolveUploadStorage } from "../services/uploadStoragePolicy.js";

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const lostFoundUploadsRoot = path.resolve(__dirname, "../uploads/lost-found");
const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const PHOTO_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const PHOTO_SEARCH_MAX_BYTES = parsePositiveInt(
  process.env.LOST_PHOTO_SEARCH_MAX_BYTES,
  4 * 1024 * 1024,
);

const allowedPhotoMimeTypes = new Set(["image/jpeg", "image/png"]);

const validatePhotoFilename = (name = "") =>
  /\.(jpg|jpeg|png)$/i.test(String(name || ""));

const buildLocalPhotoUrl = (req, fileName) => {
  const protoHeader = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const hostHeader = String(
    req.headers["x-forwarded-host"] || req.headers.host || "",
  )
    .split(",")[0]
    .trim();
  const proto = protoHeader || req.protocol || "http";
  const host = hostHeader || `localhost:${process.env.PORT || 5000}`;
  return `${proto}://${host}/uploads/lost-found/${encodeURIComponent(String(fileName || "").trim())}`;
};

const fileFilter = (req, file, cb) => {
  if (!allowedPhotoMimeTypes.has(String(file.mimetype || "").toLowerCase())) {
    return cb(new Error("Only JPG and PNG photos are allowed"), false);
  }
  if (!validatePhotoFilename(file.originalname)) {
    return cb(new Error("Unsupported photo extension"), false);
  }
  return cb(null, true);
};

const s3PhotoUpload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,
    key: (req, file, cb) => {
      const ext = path.extname(file.originalname) || ".jpg";
      const baseName = path
        .parse(file.originalname)
        .name.replace(/\s+/g, "_")
        .slice(0, 40);
      const unique = Math.random().toString(36).slice(2, 10);
      const fileName = `lost-found/${Date.now()}-${unique}-${baseName}${ext}`;
      cb(null, fileName);
    },
    contentType: multerS3.AUTO_CONTENT_TYPE,
    metadata: (req, file, cb) => {
      cb(null, {
        fieldName: file.fieldname,
        uploadedBy: req.auth?.id || "unknown",
      });
    },
  }),
  limits: { fileSize: PHOTO_UPLOAD_MAX_BYTES },
  fileFilter,
});

const localPhotoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(lostFoundUploadsRoot, { recursive: true });
      cb(null, lostFoundUploadsRoot);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || ".jpg";
      const baseName = path
        .parse(file.originalname)
        .name.replace(/\s+/g, "_")
        .slice(0, 40);
      const unique = Math.random().toString(36).slice(2, 10);
      cb(null, `${Date.now()}-${unique}-${baseName}${ext}`);
    },
  }),
  limits: { fileSize: PHOTO_UPLOAD_MAX_BYTES },
  fileFilter,
});

const photoSearchUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PHOTO_SEARCH_MAX_BYTES },
  fileFilter,
});

const singlePhotoUpload = (req, res, next) => {
  resolveUploadStorage("lost-found-upload")
    .then((storageMode) => {
      req.lostFoundUploadStorage = storageMode;
      const selectedUpload = storageMode === "s3" ? s3PhotoUpload : localPhotoUpload;

      selectedUpload.single("photo")(req, res, (err) => {
        if (!err) return next();
        const message = err?.message || "Photo upload failed";
        const statusCode =
          err?.code === "LIMIT_FILE_SIZE" ||
          /unsupported|only jpg|png/i.test(message)
            ? 400
            : 500;
        return res.status(statusCode).json({
          success: false,
          message,
        });
      });
    })
    .catch((error) => {
      return res.status(Number(error?.statusCode) || 500).json({
        success: false,
        message: error?.message || "Photo upload failed",
      });
    });
};

const singlePhotoSearchUpload = (req, res, next) => {
  photoSearchUpload.single("photo")(req, res, (err) => {
    if (!err) return next();
    const message =
      err?.code === "LIMIT_FILE_SIZE"
        ? "Photo search image is too large. Please use a JPG or PNG under 4 MB."
        : err?.message || "Photo search upload failed";
    return res.status(400).json({
      success: false,
      code:
        err?.code === "LIMIT_FILE_SIZE"
          ? "PHOTO_SEARCH_FILE_TOO_LARGE"
          : "PHOTO_SEARCH_UPLOAD_INVALID",
      errorCode:
        err?.code === "LIMIT_FILE_SIZE"
          ? "PHOTO_SEARCH_FILE_TOO_LARGE"
          : "PHOTO_SEARCH_UPLOAD_INVALID",
      message,
    });
  });
};

router.post("/lost", auth, lostReportLimiter, createLostReport);
router.post("/found", auth, lostReportLimiter, createFoundReport);
router.get("/my-lost-reports", auth, getMyLostReports);
// Search + detail (privacy-safe, open reports). Must precede any ":id" params.
router.get("/name-suggestions", auth, getLostReportNameSuggestions);
router.get("/search", auth, searchLostReports);
router.post(
  "/search-photo",
  auth,
  lostPhotoSearchLimiter,
  singlePhotoSearchUpload,
  searchLostReportsByPhoto,
);
router.get("/lost/:id", auth, getLostReportDetail);

router.post("/upload-photo", auth, singlePhotoUpload, async (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: "Photo upload failed" });
    }

    if (req.lostFoundUploadStorage === "local") {
      const fileName = req.file.filename || path.basename(req.file.path || "");
      return res.status(201).json({
        success: true,
        data: {
          photoUrl: buildLocalPhotoUrl(req, fileName),
          key: `lost-found/${fileName}`,
          storage: "local",
        },
      });
    }

    if (!req.file.key) {
      return res
        .status(400)
        .json({ success: false, message: "Photo upload failed" });
    }

    const signedUrl = await generateSignedUrl(
      req.file.key,
      BUCKET_NAME,
      3600 * 24 * 7,
    );

    res.status(201).json({
      success: true,
      data: {
        photoUrl: signedUrl,
        key: req.file.key,
        storage: "s3",
      },
    });
  } catch (error) {
    console.error("Error generating signed URL for photo:", error);
    res.status(201).json({
      success: true,
      data: {
        photoUrl:
          req.file.location ||
          `https://${BUCKET_NAME}.s3.amazonaws.com/${req.file.key}`,
        key: req.file.key,
        storage: req.lostFoundUploadStorage || "s3",
      },
    });
  }
});

export default router;
