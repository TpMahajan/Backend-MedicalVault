import express from "express";
import multer from "multer";
import multerS3 from "multer-s3";
import path from "path";
import { auth } from "../middleware/auth.js";
import {
  createLostReport,
  createFoundReport,
  getMyLostReports,
} from "../controllers/lostFoundController.js";
import s3Client, { BUCKET_NAME } from "../config/s3.js";

const router = express.Router();

const photoUpload = multer({
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
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.post("/lost", auth, createLostReport);
router.post("/found", auth, createFoundReport);
router.get("/my-lost-reports", auth, getMyLostReports);

router.post(
  "/upload-photo",
  auth,
  photoUpload.single("photo"),
  (req, res) => {
    if (!req.file || !req.file.location) {
      return res
        .status(400)
        .json({ success: false, message: "Photo upload failed" });
    }

    res.status(201).json({
      success: true,
      data: {
        photoUrl: req.file.location,
        key: req.file.key,
      },
    });
  }
);

export default router;

