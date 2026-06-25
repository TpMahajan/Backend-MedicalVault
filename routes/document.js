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
import DocumentReader from "../services/documentReader.js";

const router = express.Router();

const privilegedRoles = new Set(["admin", "superadmin"]);
const MALWARE_SCAN_API_URL = String(process.env.MALWARE_SCAN_API_URL || "").trim();
const MALWARE_SCAN_FAIL_CLOSED =
  String(process.env.MALWARE_SCAN_FAIL_CLOSED || "false").toLowerCase() === "true";
const OPENAI_API_KEY = String(process.env.OPENAI_API_KEY || "").trim();
const DOCUMENT_CLASSIFIER_MODEL = String(
  process.env.DOCUMENT_CLASSIFIER_MODEL || "gpt-4o-mini"
).trim();
const DOCUMENT_CATEGORY_CLASSIFIER_MODEL = String(
  process.env.DOCUMENT_CATEGORY_CLASSIFIER_MODEL ||
    DOCUMENT_CLASSIFIER_MODEL ||
    "gpt-4o-mini"
).trim();
const DOCUMENT_REJECT_MESSAGE =
  "Only medical-related documents are allowed. Please upload valid reports, prescriptions, or health records.";
const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const MIN_MEDICAL_TEXT_LENGTH = 40;
const MAX_AI_CLASSIFIER_CHARS = 800;
const MAX_AI_CATEGORY_CHARS = 350;
const DEFAULT_CLASSIFIER_TIMEOUT_MS = 2500;
const DEFAULT_CATEGORY_CLASSIFIER_TIMEOUT_MS = 3000;
const DEFAULT_VALIDATION_PDF_PAGES = 2;
const VALIDATION_PDF_PAGES = parsePositiveInteger(
  process.env.DOCUMENT_VALIDATION_PDF_PAGES,
  DEFAULT_VALIDATION_PDF_PAGES
);
const VALIDATION_OCR_LANGUAGES = String(
  process.env.DOCUMENT_VALIDATION_OCR_LANGUAGES || "eng+hin"
).trim();
const ALLOW_INCONCLUSIVE_MEDICAL_UPLOADS =
  String(process.env.ALLOW_INCONCLUSIVE_MEDICAL_UPLOADS || "false").toLowerCase() === "true";
const validDocumentCategories = ["Report", "Prescription", "Bill", "Insurance"];
const allowedMimeTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);
const magicSignatureByMime = {
  "application/pdf": [[0x25, 0x50, 0x44, 0x46]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47]],
};

const validateUploadFilename = (name = "") => {
  const normalized = String(name || "").toLowerCase();
  return /\.(pdf|jpg|jpeg|png)$/.test(normalized);
};
const isValidObjectId = (value) => /^[a-fA-F0-9]{24}$/.test(String(value || ""));
const documentReader = new DocumentReader();

const clinicalMedicalKeywords = [
  "prescription",
  "diagnosis",
  "doctor",
  "hospital",
  "blood test",
  "x-ray",
  "xray",
  "mri",
  "ct scan",
  "medication",
  "medicine",
  "lab",
  "laboratory",
  "clinic",
  "dosage",
  "dose",
  "tablet",
  "capsule",
  "syrup",
  "injection",
  "radiology",
  "pathology",
  "hemoglobin",
  "wbc",
  "rbc",
  "platelet",
  "glucose",
  "creatinine",
  "cholesterol",
  "blood pressure",
  "bp",
  "ecg",
  "ekg",
  "rx",
  "discharge",
  "admission",
  "opd",
  "ipd",
  "symptoms",
  "treatment",
];

const supportingMedicalDocumentKeywords = [
  "patient name",
  "patient",
  "report",
  "test",
  "result",
  "insurance",
  "bill",
  "invoice",
  "claim",
  "receipt",
  "policy",
  "charges",
  "paid",
];

const highSignalMedicalPhrases = [
  "medical report",
  "lab report",
  "laboratory report",
  "pathology report",
  "radiology report",
  "diagnostic report",
  "discharge summary",
  "blood test",
  "blood report",
  "x-ray",
  "mri",
  "ct scan",
  "ultrasound",
  "prescription",
  "prescribed by",
  "hospital bill",
  "medical bill",
  "doctor bill",
  "clinic bill",
  "health insurance",
  "medical insurance",
  "mediclaim",
  "medical claim",
  "hospital claim",
];

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

const cleanupRejectedUpload = async ({
  usingS3Storage,
  s3Bucket,
  s3Key,
  localFilePath,
}) => {
  if (usingS3Storage && s3Bucket && s3Key) {
    try {
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: s3Bucket,
          Key: s3Key,
        })
      );
    } catch (cleanupError) {
      console.error("Failed to cleanup rejected S3 upload:", cleanupError.message);
    }
    return;
  }

  if (localFilePath && fs.existsSync(localFilePath)) {
    try {
      fs.unlinkSync(localFilePath);
    } catch (cleanupError) {
      console.error("Failed to cleanup rejected local upload:", cleanupError.message);
    }
  }
};

const normalizeExtractedText = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7E]+/g, " ")
    .trim()
    .toLowerCase();

const escapeRegex = (value) =>
  String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const hasMedicalTerm = (normalizedText, term) => {
  const normalizedTerm = normalizeExtractedText(term);
  if (!normalizedText || !normalizedTerm) return false;
  if (normalizedTerm.includes(" ")) {
    return normalizedText.includes(normalizedTerm);
  }

  const termPattern = new RegExp(
    `(^|[^a-z0-9])${escapeRegex(normalizedTerm)}([^a-z0-9]|$)`
  );
  return termPattern.test(normalizedText);
};

const buildVerificationPayload = ({
  status = "pending",
  label = "UNKNOWN",
  method = "inconclusive",
  reason = "",
  confidence = "unknown",
  keywordDecision = null,
} = {}) => ({
  status,
  label,
  method,
  reason,
  confidence,
  checkedAt: new Date(),
  keywordHits: keywordDecision?.keywordHits || 0,
  matchedKeywords: keywordDecision?.matched || [],
});

const evaluateMedicalKeywordConfidence = (normalizedText) => {
  if (!normalizedText) {
    return { level: "none", keywordHits: 0, highSignal: false, matched: [] };
  }

  const matchedHighSignal = highSignalMedicalPhrases.filter((phrase) =>
    hasMedicalTerm(normalizedText, phrase)
  );
  const matchedClinical = clinicalMedicalKeywords.filter((keyword) =>
    hasMedicalTerm(normalizedText, keyword)
  );
  const matchedSupporting = supportingMedicalDocumentKeywords.filter((keyword) =>
    hasMedicalTerm(normalizedText, keyword)
  );
  const matchedKeywords = [
    ...new Set([
      ...matchedHighSignal,
      ...matchedClinical,
      ...matchedSupporting,
    ]),
  ];
  const highSignal = matchedHighSignal.length > 0;
  const clinicalHits = matchedClinical.length;
  const supportingHits = matchedSupporting.length;
  const keywordHits = matchedKeywords.length;

  const level =
    highSignal || clinicalHits >= 2 || (clinicalHits >= 1 && supportingHits >= 1)
      ? "strong"
      : clinicalHits === 1 || supportingHits >= 2
        ? "weak"
        : "none";

  return {
    level,
    keywordHits,
    highSignal,
    clinicalHits,
    supportingHits,
    matched: matchedKeywords.slice(0, 12),
  };
};

const normalizeDocumentCategory = (category = "") => {
  const normalized = String(category || "").toLowerCase().trim();
  if (!normalized) return "";
  if (normalized.includes("prescription") || normalized.includes("rx")) {
    return "Prescription";
  }
  if (normalized.includes("insurance") || normalized.includes("claim")) {
    return "Insurance";
  }
  if (
    normalized.includes("bill") ||
    normalized.includes("invoice") ||
    normalized.includes("receipt")
  ) {
    return "Bill";
  }
  if (
    normalized.includes("report") ||
    normalized.includes("lab") ||
    normalized.includes("test") ||
    normalized.includes("scan")
  ) {
    return "Report";
  }
  return "";
};

const categoryKeywordGroups = {
  Report: [
    "report",
    "lab",
    "test",
    "result",
    "blood",
    "cbc",
    "hemoglobin",
    "radiology",
    "x-ray",
    "xray",
    "mri",
    "ct scan",
    "ultrasound",
    "diagnosis",
  ],
  Prescription: [
    "prescription",
    "rx",
    "tablet",
    "capsule",
    "syrup",
    "dosage",
    "dose",
    "medicine",
    "medication",
    "take",
    "daily",
  ],
  Bill: [
    "bill",
    "invoice",
    "receipt",
    "amount",
    "total",
    "paid",
    "payment",
    "charges",
    "fee",
    "tax",
  ],
  Insurance: [
    "insurance",
    "policy",
    "claim",
    "cashless",
    "insurer",
    "tpa",
    "coverage",
    "premium",
    "mediclaim",
  ],
};

const buildCategoryClassificationText = ({
  title,
  notes,
  originalName,
  normalizedText,
}) =>
  normalizeExtractedText(
    [title, originalName, notes, normalizedText].filter(Boolean).join(" ")
  );

const inferDocumentCategoryByHeuristic = (classificationText) => {
  const text = normalizeExtractedText(classificationText);
  if (!text) return "Report";

  const scores = Object.fromEntries(
    validDocumentCategories.map((category) => [category, 0])
  );

  for (const [category, keywords] of Object.entries(categoryKeywordGroups)) {
    for (const keyword of keywords) {
      if (text.includes(keyword)) scores[category] += 1;
    }
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (ranked[0]?.[1] > 0 && ranked[0][1] > (ranked[1]?.[1] || 0)) {
    return ranked[0][0];
  }

  return "Report";
};

const classifyDocumentCategoryWithAI = async ({
  title,
  notes,
  originalName,
  normalizedText,
}) => {
  const classificationText = buildCategoryClassificationText({
    title,
    notes,
    originalName,
    normalizedText,
  });
  const fallbackCategory = inferDocumentCategoryByHeuristic(classificationText);
  const textSample = classificationText.slice(0, MAX_AI_CATEGORY_CHARS);

  if (!OPENAI_API_KEY || textSample.length < 4) {
    return { category: fallbackCategory, method: "heuristic" };
  }

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: DOCUMENT_CATEGORY_CLASSIFIER_MODEL,
        temperature: 0,
        max_tokens: 3,
        messages: [
          {
            role: "system",
            content:
              "Return only one: Report, Prescription, Bill, Insurance.",
          },
          {
            role: "user",
            content: textSample,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: Number(
          process.env.DOCUMENT_CATEGORY_CLASSIFIER_TIMEOUT_MS ||
            DEFAULT_CATEGORY_CLASSIFIER_TIMEOUT_MS
        ),
      }
    );

    const raw = String(
      response?.data?.choices?.[0]?.message?.content || ""
    ).trim();
    const aiCategory = normalizeDocumentCategory(raw);
    return {
      category: aiCategory || fallbackCategory,
      method: aiCategory ? "ai" : "heuristic",
    };
  } catch (error) {
    console.error("Document category AI fallback failed:", error.message);
    return { category: fallbackCategory, method: "heuristic" };
  }
};

const classifyMedicalTextWithAI = async (normalizedText) => {
  if (!OPENAI_API_KEY) {
    return { success: false, label: "UNKNOWN", reason: "missing_openai_key" };
  }

  const textSample = String(normalizedText || "").slice(0, MAX_AI_CLASSIFIER_CHARS);
  if (!textSample) {
    return { success: false, label: "UNKNOWN", reason: "empty_text" };
  }

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: DOCUMENT_CLASSIFIER_MODEL,
        temperature: 0,
        max_tokens: 5,
        messages: [
          {
            role: "system",
            content:
              "Classify text strictly as MEDICAL or NON_MEDICAL. Return only one word.",
          },
          {
            role: "user",
            content: `Classify this text as:\\n- MEDICAL\\n- NON_MEDICAL\\n\\nText: ${textSample}\\n\\nReturn only one word.`,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: Number(
          process.env.DOCUMENT_CLASSIFIER_TIMEOUT_MS ||
            DEFAULT_CLASSIFIER_TIMEOUT_MS
        ),
      }
    );

    const raw = String(
      response?.data?.choices?.[0]?.message?.content || ""
    )
      .trim()
      .toUpperCase()
      .replace(/[^A-Z_]/g, "");
    const label = raw === "MEDICAL" || raw === "NON_MEDICAL" ? raw : "NON_MEDICAL";
    return { success: true, label, reason: "ai_classified" };
  } catch (error) {
    console.error("Medical classifier AI fallback failed:", error.message);
    return { success: false, label: "UNKNOWN", reason: "ai_request_failed" };
  }
};

const extractTextForMedicalValidation = async ({
  usingS3Storage,
  s3Key,
  s3Bucket,
  localFilePath,
  mimeType,
}) => {
  if (usingS3Storage && s3Key && s3Bucket) {
    const extracted = await documentReader.extractTextFromS3(s3Key, s3Bucket, {
      pdfParseParams: { first: VALIDATION_PDF_PAGES },
      imageOcrOptions: { languages: VALIDATION_OCR_LANGUAGES },
    });
    if (!extracted?.success) {
      return { success: false, text: "", reason: extracted?.error || "s3_extract_failed" };
    }
    return { success: true, text: extracted.text || "" };
  }

  if (!localFilePath || !fs.existsSync(localFilePath)) {
    return { success: false, text: "", reason: "local_file_missing" };
  }

  try {
    if (String(mimeType || "").toLowerCase() === "application/pdf") {
      const extracted = await documentReader.extractFromPDF(localFilePath, {
        parseParams: { first: VALIDATION_PDF_PAGES },
      });
      return { success: true, text: extracted?.text || "" };
    }

    const extracted = await documentReader.extractFromImage(localFilePath, {
      languages: VALIDATION_OCR_LANGUAGES,
    });
    return { success: true, text: extracted?.text || "" };
  } catch (error) {
    return { success: false, text: "", reason: error.message || "local_extract_failed" };
  }
};

const validateMedicalDocumentContent = async ({
  usingS3Storage,
  s3Key,
  s3Bucket,
  localFilePath,
  mimeType,
  title,
  originalName,
}) => {
  // User-entered labels can help later categorization, but they cannot prove
  // the uploaded file itself is medical.
  const metadataText = normalizeExtractedText(
    [title, originalName].filter(Boolean).join(" ")
  );

  const extracted = await extractTextForMedicalValidation({
    usingS3Storage,
    s3Key,
    s3Bucket,
    localFilePath,
    mimeType,
  });

  const normalizedText = normalizeExtractedText(extracted?.text || "");
  const classificationText = normalizeExtractedText(
    [normalizedText, metadataText].filter(Boolean).join(" ")
  );
  if (!extracted?.success || normalizedText.length < MIN_MEDICAL_TEXT_LENGTH) {
    const partialKeywordDecision = evaluateMedicalKeywordConfidence(normalizedText);
    if (
      ALLOW_INCONCLUSIVE_MEDICAL_UPLOADS &&
      partialKeywordDecision.level === "strong"
    ) {
      return {
        allow: true,
        reason: "partial_keyword_medical_accept",
        normalizedText,
        classificationText: classificationText || normalizedText,
        keywordDecision: partialKeywordDecision,
        verification: buildVerificationPayload({
          status: "accepted",
          label: "MEDICAL",
          method: "keyword",
          reason:
            "Readable text was limited, but the extracted content contained strong medical terms.",
          confidence: "low",
          keywordDecision: partialKeywordDecision,
        }),
      };
    }

    return {
      allow: false,
      reason: "insufficient_text",
      message: `${DOCUMENT_REJECT_MESSAGE} Upload a clearer and complete medical document.`,
      normalizedText,
      classificationText: classificationText || metadataText,
      verification: buildVerificationPayload({
        status: "rejected",
        label: "UNKNOWN",
        method: "inconclusive",
        reason: "Could not extract enough readable text to verify the document.",
        confidence: "low",
      }),
    };
  }

  const keywordDecision = evaluateMedicalKeywordConfidence(normalizedText);
  if (keywordDecision.level === "strong") {
    return {
      allow: true,
      reason: "keyword_strong_allow",
      normalizedText,
      classificationText: classificationText || normalizedText || metadataText,
      keywordDecision,
      verification: buildVerificationPayload({
        status: "verified",
        label: "MEDICAL",
        method: "keyword",
        reason: "Medical terms were found in the document text.",
        confidence: "high",
        keywordDecision,
      }),
    };
  }

  let aiDecision = null;
  const shouldUseAiClassifier =
    keywordDecision.level === "weak" && (keywordDecision.clinicalHits || 0) > 0;
  if (shouldUseAiClassifier) {
    aiDecision = await classifyMedicalTextWithAI(normalizedText);
    if (aiDecision.success && aiDecision.label === "MEDICAL") {
      return {
        allow: true,
        reason: "ai_medical_allow",
        normalizedText,
        classificationText: classificationText || normalizedText || metadataText,
        keywordDecision,
        aiDecision,
        verification: buildVerificationPayload({
          status: "verified",
          label: "MEDICAL",
          method: "ai",
          reason: "AI classified the document as medical.",
          confidence: "medium",
          keywordDecision,
        }),
      };
    }
  }

  return {
    allow: false,
    reason: "non_medical_reject",
    message: DOCUMENT_REJECT_MESSAGE,
    normalizedText,
    classificationText: classificationText || normalizedText || metadataText,
    keywordDecision,
    aiDecision,
    verification: buildVerificationPayload({
      status: "rejected",
      label: "NON_MEDICAL",
      method: aiDecision?.success ? "ai" : "keyword",
      reason: aiDecision?.success
        ? "AI classified the document as non-medical."
        : "The document text did not contain reliable medical evidence.",
      confidence: aiDecision?.success ? "medium" : "low",
      keywordDecision,
    }),
  };
};

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

        const message = err?.message || "Upload failed";
        const statusCode =
          err?.code === "LIMIT_FILE_SIZE" || /unsupported file/i.test(message)
            ? 400
            : 500;
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

    const requestedCategory = normalizeDocumentCategory(category);
    const categoryWasProvided = Boolean(requestedCategory);
    let chosenCategory = requestedCategory;
    let categoryDetectionMethod = categoryWasProvided ? "manual" : "ai";

    // ✅ Store S3 information
    const usingS3Storage = req.documentUploadStorage !== "local";
    const s3Key = req.file.key;
    const s3Bucket = req.file.bucket;
    const localFilePath = usingS3Storage ? "" : String(req.file.path || "");
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
        await cleanupRejectedUpload({
          usingS3Storage,
          s3Bucket,
          s3Key,
          localFilePath,
        });

        return res.status(400).json({
          success: false,
          msg: "Uploaded file failed security checks",
        });
      }
    }

    // ✅ Properly handle date conversion
    const validationResult = await validateMedicalDocumentContent({
      usingS3Storage,
      s3Key,
      s3Bucket,
      localFilePath,
      mimeType: req.file.mimetype,
      title,
      originalName: req.file.originalname,
    });

    if (!validationResult.allow) {
      await cleanupRejectedUpload({
        usingS3Storage,
        s3Bucket,
        s3Key,
        localFilePath,
      });

      return res.status(400).json({
        success: false,
        code: "DOCUMENT_NOT_MEDICAL",
        msg: validationResult.message || DOCUMENT_REJECT_MESSAGE,
        medicalVerification: validationResult.verification,
      });
    }

    const medicalVerification =
      validationResult.verification ||
      buildVerificationPayload({
        status: "accepted",
        label: "MEDICAL",
        method: "inconclusive",
        reason: "The file passed upload validation.",
        confidence: "unknown",
      });

    if (!categoryWasProvided) {
      const categoryDecision = await classifyDocumentCategoryWithAI({
        title,
        notes,
        originalName: req.file.originalname,
        normalizedText:
          validationResult.classificationText ||
          validationResult.normalizedText ||
          "",
      });
      chosenCategory = categoryDecision.category || "Report";
      categoryDetectionMethod = categoryDecision.method || "heuristic";
    }

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
      medicalVerified:
        medicalVerification.status === "verified" &&
        medicalVerification.label === "MEDICAL",
      medicalVerification,
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
      metadata: {
        category: chosenCategory,
        categoryAutoDetected: !categoryWasProvided,
        categoryDetectionMethod,
        mimeType: req.file.mimetype,
        medicalVerificationStatus: medicalVerification.status,
        medicalVerificationMethod: medicalVerification.method,
      },
    });

    res.json({
      success: true,
      msg:
        medicalVerification.status === "verified"
          ? "Medical document verified and uploaded"
          : "Document uploaded and accepted for your medical vault",
      medicalVerification,
      categoryAutoDetected: !categoryWasProvided,
      categoryDetectionMethod,
      document: doc,
    });
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
      previewUrl =
        resolveStoredDocumentUrl(req, doc) ||
        buildProxyUrl(req, doc._id.toString(), "inline");
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
