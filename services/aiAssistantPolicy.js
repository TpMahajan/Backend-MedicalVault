const ROLE_TO_PERSONA = {
  patient: "patient",
  doctor: "doctor",
  admin: "admin",
  superadmin: "superadmin",
};

const LANGUAGE_ALIASES = {
  en: "english",
  english: "english",
  hi: "hindi",
  hindi: "hindi",
  mr: "marathi",
  marathi: "marathi",
  gu: "gujarati",
  gujarati: "gujarati",
  hinglish: "hinglish",
  es: "spanish",
  spanish: "spanish",
  ru: "russian",
  russian: "russian",
  ko: "korean",
  korean: "korean",
  ja: "japanese",
  japanese: "japanese",
  zh: "chinese",
  chinese: "chinese",
};

const PATIENT_SENSITIVE_KEYWORDS = [
  "patient",
  "record",
  "report",
  "lab",
  "prescription",
  "bill",
  "insurance",
  "diagnosis",
  "medication",
  "allergy",
  "symptom",
  "test result",
  "history",
  "medical",
  "document",
  "documents",
];

const OPERATIONAL_KEYWORDS = [
  "compliance",
  "audit",
  "security",
  "dashboard",
  "incident",
  "inventory",
  "order",
  "product",
  "ticket",
  "alert",
  "admin",
  "analytics",
  "metric",
];

export const normalizeRole = (role) => String(role || "").trim().toLowerCase();

export const resolvePersona = (role) => {
  const normalized = normalizeRole(role);
  return ROLE_TO_PERSONA[normalized] || "patient";
};

export const normalizeLanguage = (value) => {
  if (!value) return null;
  const normalized = String(value).trim().toLowerCase();
  return LANGUAGE_ALIASES[normalized] || normalized || null;
};

export const detectInputLanguage = (text) => {
  const value = String(text || "");
  if (!value.trim()) return "english";

  const devanagariMatches = (value.match(/[\u0900-\u097F]/g) || []).length;
  const gujaratiMatches = (value.match(/[\u0A80-\u0AFF]/g) || []).length;
  const englishMatches = (value.match(/[a-zA-Z]/g) || []).length;

  if (gujaratiMatches > englishMatches && gujaratiMatches > 0) {
    return "gujarati";
  }
  if (devanagariMatches > englishMatches && devanagariMatches > 0) {
    return "hindi";
  }
  if (devanagariMatches > 0 && englishMatches > 0) {
    return "hinglish";
  }
  return "english";
};

const promptRequestsSpecificLanguage = (prompt = "", targetLanguage = "") => {
  const lowerPrompt = String(prompt || "").toLowerCase();
  if (!lowerPrompt || !targetLanguage) return false;

  const markers = {
    english: ["in english"],
    hindi: ["in hindi", "hindi me", "हिंदी"],
    marathi: ["in marathi", "मराठी"],
    gujarati: ["in gujarati", "ગુજરાતી"],
    hinglish: ["hinglish"],
  };

  return (markers[targetLanguage] || []).some((entry) =>
    lowerPrompt.includes(entry)
  );
};

export const resolveLanguage = ({
  prompt,
  context = {},
  principal = {},
}) => {
  const preferredRaw =
    context.preferredLanguage ||
    principal?.preferences?.language ||
    principal?.preferredLanguage ||
    principal?.language ||
    null;

  const preferredLanguage = normalizeLanguage(preferredRaw) || "english";
  const userInputLanguage = normalizeLanguage(context.userInputLanguage);
  const detectedLanguage = detectInputLanguage(prompt);

  let resolvedLanguage = preferredLanguage;

  if (userInputLanguage && userInputLanguage !== preferredLanguage) {
    resolvedLanguage = userInputLanguage;
  } else if (
    detectedLanguage &&
    detectedLanguage !== preferredLanguage &&
    (detectedLanguage !== "english" ||
      promptRequestsSpecificLanguage(prompt, detectedLanguage))
  ) {
    resolvedLanguage = detectedLanguage;
  }

  return {
    preferredLanguage,
    userInputLanguage: userInputLanguage || null,
    detectedLanguage,
    resolvedLanguage,
  };
};

export const isPatientSensitiveIntent = (
  prompt,
  {
    isDocumentRequest = false,
    requestedDocumentId = null,
    requestedTitle = null,
    isScheduleRequest = false,
    isPatientsList = false,
  } = {}
) => {
  if (isScheduleRequest || isPatientsList) return false;
  if (isDocumentRequest || requestedDocumentId || requestedTitle) return true;

  const lowerPrompt = String(prompt || "").toLowerCase();
  return PATIENT_SENSITIVE_KEYWORDS.some((keyword) =>
    lowerPrompt.includes(keyword)
  );
};

export const isOperationalIntent = (prompt) => {
  const lowerPrompt = String(prompt || "").toLowerCase();
  if (!lowerPrompt) return false;
  return OPERATIONAL_KEYWORDS.some((keyword) => lowerPrompt.includes(keyword));
};

export const buildAuthorizedScope = ({
  role,
  requesterId,
  patientId = null,
  sessionScope = null,
}) => {
  const normalizedRole = normalizeRole(role);
  const normalizedPatientId = patientId ? String(patientId) : null;

  if (normalizedRole === "patient") {
    return {
      role: "patient",
      requesterId: String(requesterId || ""),
      patientId: String(requesterId || ""),
      mode: "self",
      sessionScope: sessionScope || "self_profile",
    };
  }

  if (normalizedRole === "doctor") {
    return {
      role: "doctor",
      requesterId: String(requesterId || ""),
      patientId: normalizedPatientId,
      mode: normalizedPatientId ? "patient_context" : "doctor_general",
      sessionScope: sessionScope || (normalizedPatientId ? "patient_session" : "none"),
    };
  }

  if (normalizedRole === "admin" || normalizedRole === "superadmin") {
    return {
      role: normalizedRole,
      requesterId: String(requesterId || ""),
      patientId: normalizedPatientId,
      mode: normalizedPatientId ? "explicit_patient_context" : "operational_only",
      sessionScope: sessionScope || "admin_operational",
    };
  }

  return {
    role: normalizedRole || "unknown",
    requesterId: String(requesterId || ""),
    patientId: normalizedPatientId,
    mode: "unknown",
    sessionScope: sessionScope || "unknown",
  };
};

export const estimateExtractionConfidence = ({ metadata = {}, text = "" } = {}) => {
  const reasons = [];
  let level = "high";

  const textLength = String(text || "").trim().length;
  const fallbackUsed = metadata?.fallbackUsed === true;
  const extractionError = metadata?.extractionError;
  const ocrEngine = String(metadata?.ocrEngine || "");

  if (fallbackUsed || extractionError) {
    level = "low";
    reasons.push("Extraction used fallback due to parser/OCR limitations.");
  }

  if (textLength < 80) {
    level = "low";
    reasons.push("Extracted text is very short.");
  } else if (textLength < 300 && level !== "low") {
    level = "medium";
    reasons.push("Extracted text is limited; some details may be missing.");
  }

  if (ocrEngine && level !== "low") {
    level = "medium";
    reasons.push("OCR-based extraction may miss handwritten/low-quality text.");
  }

  if (!reasons.length) {
    reasons.push("Extraction quality appears sufficient for summarization.");
  }

  return { level, reasons };
};

export const detectUrgentRisk = (prompt = "", reply = "") => {
  const corpus = `${prompt}\n${reply}`.toLowerCase();
  const markers = [
    "chest pain",
    "severe breathing",
    "stroke",
    "unconscious",
    "seizure",
    "severe bleeding",
    "suicidal",
    "anaphylaxis",
    "allergic reaction",
    "sudden confusion",
  ];
  return markers.some((marker) => corpus.includes(marker));
};

export const buildSafetyPayload = ({
  prompt,
  reply,
  extractionConfidence,
  missingData = [],
} = {}) => {
  const warnings = [];
  const urgent = detectUrgentRisk(prompt, reply);

  if (urgent) {
    warnings.push(
      "Potential urgent warning signs detected. Seek immediate in-person medical care."
    );
  }

  if (Array.isArray(missingData) && missingData.length > 0) {
    warnings.push(...missingData);
  }

  if (extractionConfidence?.level === "low") {
    warnings.push("Extraction confidence is low; verify values from the original document.");
  }

  return {
    urgent,
    warnings,
    extractionConfidence: extractionConfidence || null,
  };
};
