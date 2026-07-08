const asText = (value) => (value == null ? "" : String(value).trim());

export const KHOJ_ASSISTANT_SCOPE = "khoj";

export const KHOJ_SYSTEM_PROMPT = `You are KHOJ AI, a lost/found person assistance module inside Medical Vault. You can only use lost person reports, found person reports, match suggestions, and related report audit data provided by the server. You must not access or refer to medical vault files, prescriptions, bills, insurance documents, patient reports, or unrelated user data. Your role is to help summarize reports, compare lost and found records, identify possible matches, explain match reasons, and recommend verification steps. Never claim a person is definitely found unless an authorized human has confirmed the match. Use cautious language. Protect reporter/finder privacy. If data is incomplete, state what is missing.`;

const KHOJ_FORBIDDEN_KEYWORDS = [
  "prescription",
  "bill",
  "insurance",
  "medical file",
  "medical files",
  "medical report",
  "medical reports",
  "patient report",
  "blood report",
  "lab report",
  "vault document",
  "uploaded document",
  "file scanning",
  "file-scanning",
  "file assistant",
  "assistant data",
];

export const isForbiddenKhojPrompt = (prompt = "") => {
  const lower = String(prompt || "").toLowerCase();
  return KHOJ_FORBIDDEN_KEYWORDS.some((keyword) => lower.includes(keyword));
};

export const isPrivilegedKhojUser = (req) => {
  const role = String(req.auth?.role || "").toLowerCase();
  if (role === "superadmin") return true;
  if (role !== "admin") return false;
  const adminRole = String(req.admin?.role || "").toUpperCase();
  if (adminRole === "SUPER_ADMIN") return true;
  const permissions = new Set(
    (Array.isArray(req.admin?.permissions) ? req.admin.permissions : [])
      .map((entry) => String(entry || "").trim().toUpperCase()),
  );
  return permissions.has("VIEW_SOS") || permissions.has("HANDLE_SOS");
};

export const currentPrincipalId = (req) =>
  String(req.auth?.id || req.user?._id || req.admin?._id || req.superAdmin?.email || "");

export const canViewPrivateContact = (req, report = {}) => {
  if (isPrivilegedKhojUser(req)) return true;
  const principalId = currentPrincipalId(req);
  if (!principalId) return false;
  const ownerIds = [
    report.reportedByUserId,
    report.foundByUserId,
    report.createdBy,
  ].map((value) => String(value?._id || value || ""));
  return ownerIds.includes(principalId);
};

export const buildLostReportFilter = (req) => {
  if (isPrivilegedKhojUser(req)) return {};
  const principalId = currentPrincipalId(req);
  return {
    $or: [
      { reportedByUserId: principalId },
      { status: { $in: ["open", "active", "under_review", "matched", "found"] } },
    ],
  };
};

export const buildFoundReportFilter = (req) => {
  if (isPrivilegedKhojUser(req)) return {};
  const principalId = currentPrincipalId(req);
  return {
    $or: [
      { reportedByUserId: principalId },
      { foundByUserId: principalId },
      { status: { $in: ["unmatched", "under_evaluation", "matched", "active"] } },
    ],
  };
};

const maskPhone = (value) => {
  const digits = asText(value).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length <= 4) return "*".repeat(digits.length);
  return `${"*".repeat(Math.max(2, digits.length - 4))}${digits.slice(-4)}`;
};

const locationFromPoint = (point, fallbackAddress = "") => {
  const coordinates = point?.coordinates;
  const hasCoordinates = Array.isArray(coordinates) && coordinates.length === 2;
  return {
    address: asText(fallbackAddress),
    ...(hasCoordinates
      ? {
          lat: Number(coordinates[1]),
          lng: Number(coordinates[0]),
        }
      : {}),
  };
};

const primaryPhotoUrls = (report) => {
  const urls = [];
  if (Array.isArray(report.photoUrls)) urls.push(...report.photoUrls);
  if (report.photoUrl) urls.push(report.photoUrl);
  return [...new Set(urls.map(asText).filter(Boolean))];
};

export const serializeLostReport = (report = {}, { includePrivate = false } = {}) => {
  const obj = typeof report.toObject === "function" ? report.toObject() : report;
  const phone = obj.reportedByPhone || obj.reporterPhone || obj.emergencyContactPhone;
  return {
    reportId: String(obj.reportId || obj._id || ""),
    id: String(obj._id || obj.reportId || ""),
    personName: obj.personName || "",
    age: obj.approxAge ?? obj.estimatedAge ?? null,
    estimatedAge: obj.estimatedAge ?? obj.approxAge ?? null,
    gender: obj.gender || "Unknown",
    photoUrls: primaryPhotoUrls(obj),
    lastSeenLocation: locationFromPoint(
      obj.lastSeenLocation,
      obj.lastSeenLocationText || [obj.area, obj.city, obj.state].filter(Boolean).join(", "),
    ),
    lastSeenDateTime: obj.lastSeenDateTime || obj.lastSeenTime || null,
    description: obj.description || "",
    clothesDescription: obj.clothesDescription || obj.clothingDescription || "",
    identifyingMarks: obj.identifyingMarks || obj.identificationDetails || "",
    medicalCondition: obj.medicalCondition || obj.medicalNotes || "",
    languageSpoken: obj.languageSpoken || "",
    guardian: obj.guardian || obj.contactPerson || "",
    policeComplaintNumber: obj.policeComplaintNumber || "",
    status: obj.status || "open",
    reportedBy: {
      userId: String(obj.reportedByUserId?._id || obj.reportedByUserId || ""),
      name: obj.reportedByName || obj.reporterName || "",
      phone: includePrivate ? phone || "" : "",
      maskedPhone: maskPhone(phone),
    },
    reportedAt: obj.reportedAt || obj.createdAt || null,
    updatedAt: obj.updatedAt || null,
  };
};

export const serializeFoundReport = (report = {}, { includePrivate = false } = {}) => {
  const obj = typeof report.toObject === "function" ? report.toObject() : report;
  const phone = obj.foundByPhone || "";
  return {
    reportId: String(obj.reportId || obj._id || ""),
    id: String(obj._id || obj.reportId || ""),
    foundPersonName: obj.foundPersonName || obj.personName || "",
    estimatedAge: obj.estimatedAge ?? obj.approxAge ?? null,
    gender: obj.gender || "Unknown",
    photoUrls: primaryPhotoUrls(obj),
    foundLocation: locationFromPoint(obj.currentLocation, obj.currentSafeLocation || obj.currentHospitalId || ""),
    foundDateTime: obj.foundDateTime || obj.foundTime || null,
    description: obj.description || "",
    clothesDescription: obj.clothesDescription || obj.clothingDescription || "",
    identifyingMarks: obj.identifyingMarks || "",
    currentSafeLocation: obj.currentSafeLocation || obj.currentHospitalId || "",
    status: obj.status || "unmatched",
    linkedLostReportId: String(obj.linkedLostReportId || obj.matchedLostReportId || ""),
    foundBy: {
      userId: String(obj.foundByUserId?._id || obj.foundByUserId || obj.reportedByUserId || ""),
      name: obj.foundByName || "",
      phone: includePrivate ? phone : "",
      maskedPhone: maskPhone(phone),
    },
    reportedAt: obj.reportedAt || obj.createdAt || null,
    updatedAt: obj.updatedAt || null,
  };
};

const normalizeGender = (value) => {
  const raw = asText(value).toLowerCase();
  if (raw === "male") return "male";
  if (raw === "female") return "female";
  if (raw === "other") return "other";
  return "unknown";
};

const safeDate = (value) => {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const pointCoordinates = (record, fieldName) => {
  const coordinates = record?.[fieldName]?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length !== 2) return null;
  const lng = Number(coordinates[0]);
  const lat = Number(coordinates[1]);
  return Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : null;
};

const distanceMeters = (left, right) => {
  if (!left || !right) return null;
  const [lng1, lat1] = left;
  const [lng2, lat2] = right;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const earthRadius = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const tokenize = (text) =>
  asText(text)
    .toLowerCase()
    .split(/\W+/)
    .filter((token) => token.length > 3);

const textCorpus = (record) =>
  [
    record.description,
    record.clothesDescription,
    record.clothingDescription,
    record.identifyingMarks,
    record.identificationDetails,
    record.medicalCondition,
    record.medicalNotes,
    record.condition,
  ]
    .map(asText)
    .filter(Boolean)
    .join(" ");

const levenshtein = (left = "", right = "") => {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (!a || !b) return Math.max(a.length, b.length);
  const matrix = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
};

export const scoreKhojMatch = (lost = {}, found = {}) => {
  let score = 0;
  const reasons = [];
  const comparedFields = [];

  const lostAge = Number(lost.approxAge ?? lost.estimatedAge);
  const foundAge = Number(found.approxAge ?? found.estimatedAge);
  if (Number.isFinite(lostAge) && Number.isFinite(foundAge)) {
    comparedFields.push("age");
    const diff = Math.abs(lostAge - foundAge);
    if (diff <= 3) {
      score += 22;
      reasons.push(`Age is close (${diff} year difference).`);
    } else if (diff <= 6) {
      score += 12;
      reasons.push(`Age is somewhat close (${diff} year difference).`);
    }
  }

  const lostGender = normalizeGender(lost.gender);
  const foundGender = normalizeGender(found.gender);
  if (lostGender !== "unknown" && foundGender !== "unknown") {
    comparedFields.push("gender");
    if (lostGender === foundGender) {
      score += 16;
      reasons.push("Gender matches.");
    }
  }

  const lostTime = safeDate(lost.lastSeenDateTime || lost.lastSeenTime);
  const foundTime = safeDate(found.foundDateTime || found.foundTime);
  if (lostTime && foundTime) {
    comparedFields.push("timeline");
    const diffHours = Math.abs(foundTime.getTime() - lostTime.getTime()) / 36e5;
    if (diffHours <= 12) {
      score += 16;
      reasons.push("Timeline is very close.");
    } else if (diffHours <= 48) {
      score += 10;
      reasons.push("Timeline is plausible.");
    } else if (diffHours <= 168) {
      score += 5;
      reasons.push("Timeline is possible but less close.");
    }
  }

  const lostPoint = pointCoordinates(lost, "lastSeenLocation");
  const foundPoint = pointCoordinates(found, "currentLocation");
  const meters = distanceMeters(lostPoint, foundPoint);
  if (meters != null) {
    comparedFields.push("location");
    if (meters <= 1000) {
      score += 18;
      reasons.push("Locations are within about 1 km.");
    } else if (meters <= 10000) {
      score += 10;
      reasons.push("Locations are within a plausible search radius.");
    } else if (meters <= 50000) {
      score += 4;
      reasons.push("Locations are distant but still regionally possible.");
    }
  }

  const lostName = asText(lost.personName);
  const foundName = asText(found.foundPersonName || found.personName);
  if (lostName && foundName) {
    comparedFields.push("name");
    const maxLen = Math.max(lostName.length, foundName.length, 1);
    const similarity = 1 - levenshtein(lostName, foundName) / maxLen;
    if (similarity >= 0.8) {
      score += 14;
      reasons.push("Name is very similar.");
    } else if (similarity >= 0.55) {
      score += 7;
      reasons.push("Name is partially similar.");
    }
  }

  const lostTokens = new Set(tokenize(textCorpus(lost)));
  const foundTokens = tokenize(textCorpus(found));
  if (lostTokens.size && foundTokens.length) {
    comparedFields.push("description/clothing/marks");
    const overlap = foundTokens.filter((token) => lostTokens.has(token)).length;
    if (overlap >= 5) {
      score += 14;
      reasons.push("Descriptions, clothing, or identifying marks have strong overlap.");
    } else if (overlap >= 2) {
      score += 8;
      reasons.push("Some description, clothing, or identifying mark terms overlap.");
    }
  }

  if ((lost.photoUrl || lost.photoUrls?.length) && (found.photoUrl || found.photoUrls?.length)) {
    comparedFields.push("photo metadata");
    score += 4;
    reasons.push("Both reports include photos, but no face recognition was performed.");
  }

  return {
    score: Math.min(100, Math.round(score)),
    reasons,
    comparedFields,
    aiSummary: buildMatchSummary(score, reasons),
  };
};

export const buildMatchSummary = (score, reasons = []) => {
  const rounded = Math.min(100, Math.round(score));
  if (rounded >= 75) {
    return `Possible strong match (${rounded}/100). Needs human verification. ${reasons.slice(0, 3).join(" ")}`;
  }
  if (rounded >= 50) {
    return `Possible match (${rounded}/100). Review details and verify with reporter/finder. ${reasons.slice(0, 3).join(" ")}`;
  }
  return `Low-confidence possible match (${rounded}/100). More information is needed before escalation. ${reasons.slice(0, 3).join(" ")}`;
};

const missingFieldsForLost = (report = {}) => {
  const missing = [];
  if (!asText(report.personName)) missing.push("person name");
  if (!(report.approxAge || report.estimatedAge)) missing.push("age or estimated age");
  if (normalizeGender(report.gender) === "unknown") missing.push("gender");
  if (!asText(report.description)) missing.push("description");
  if (!asText(report.clothingDescription || report.clothesDescription)) missing.push("clothing description");
  if (!asText(report.identificationDetails || report.identifyingMarks)) missing.push("identifying marks");
  if (!safeDate(report.lastSeenDateTime || report.lastSeenTime)) missing.push("last seen date/time");
  if (!pointCoordinates(report, "lastSeenLocation") && !asText(report.lastSeenLocationText)) missing.push("last seen location");
  return missing;
};

export const buildKhojAssistantReply = ({
  prompt,
  lostReports = [],
  foundReports = [],
  matches = [],
} = {}) => {
  if (isForbiddenKhojPrompt(prompt)) {
    return {
      reply:
        "I can only help with KHOJ lost/found person reports and match suggestions. I cannot access or discuss Medical Vault files, prescriptions, bills, insurance documents, or patient vault documents.",
      intent: "scope_refusal",
    };
  }

  const lower = String(prompt || "").toLowerCase();
  if (lower.includes("missing")) {
    const target = lostReports[0] || {};
    const missing = missingFieldsForLost(target);
    return {
      reply: missing.length
        ? `Missing or weak information: ${missing.join(", ")}. Ask the reporter/finder to provide these details before confirming any possible match.`
        : "The selected report has the core KHOJ fields needed for review. Verification should still be done by an authorized human.",
      intent: "missing_fields",
    };
  }

  if (lower.includes("verification question") || lower.includes("draft")) {
    return {
      reply:
        "Suggested verification questions: What was the exact last-seen/found time? What clothing was the person wearing? Are there unique marks, scars, accessories, or language cues? Can the reporter/finder share a clearer recent photo? Has a police complaint number or station contact been recorded?",
      intent: "verification_questions",
    };
  }

  if (matches.length) {
    const lines = matches.slice(0, 5).map((match, index) => {
      const reasons = Array.isArray(match.reasons) ? match.reasons.slice(0, 3).join(" ") : "";
      return `${index + 1}. Possible match score ${match.score}/100. ${reasons || "Needs field-by-field verification."}`;
    });
    return {
      reply: `I found ${matches.length} possible match suggestion${matches.length === 1 ? "" : "s"}. These are not definitive identifications:\n${lines.join("\n")}`,
      intent: "match_summary",
    };
  }

  if (lostReports.length || foundReports.length) {
    return {
      reply:
        `KHOJ AI can review ${lostReports.length} lost report${lostReports.length === 1 ? "" : "s"} and ${foundReports.length} found report${foundReports.length === 1 ? "" : "s"} in this scope. Use cautious language: possible match, likely match, or needs verification.`,
      intent: "summary",
    };
  }

  return {
    reply:
      "I do not have enough KHOJ report data in scope yet. Please select a lost/found report or ask to find possible matches.",
    intent: "insufficient_data",
  };
};
