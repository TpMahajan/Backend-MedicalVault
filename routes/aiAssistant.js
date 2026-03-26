import express from "express";
import axios from "axios";
import { auth } from "../middleware/auth.js";
import { User } from "../models/User.js";
import { DoctorUser } from "../models/DoctorUser.js";
import { AdminUser } from "../models/AdminUser.js";
import { Document } from "../models/File.js";
import { Appointment } from "../models/Appointment.js";
import { AIChat } from "../models/AIChat.js";
import DocumentReader from "../services/documentReader.js";
import { ok, fail } from "../utils/apiResponse.js";
import { canDoctorAccessPatient } from "../services/accessControl.js";
import { aiLimiter } from "../middleware/rateLimit.js";
import {
  buildAuthorizedScope,
  buildSafetyPayload,
  estimateExtractionConfidence,
  isOperationalIntent,
  isPatientSensitiveIntent,
  normalizeRole,
  resolveLanguage,
  resolvePersona,
} from "../services/aiAssistantPolicy.js";

const router = express.Router();
router.use(aiLimiter);
const documentReader = new DocumentReader();

// Helper function to detect document-related queries
const isDocumentQuery = (prompt) => {
  const documentKeywords = [
    "report", "reports", "prescription", "prescriptions", "bill", "bills", 
    "insurance", "document", "documents", "upload", "uploaded", "analyze",
    "summary", "summarize", "extract", "read", "content"
  ];
  const lowerPrompt = prompt.toLowerCase();
  return documentKeywords.some(keyword => lowerPrompt.includes(keyword));
};

// Helper function to detect language from user input
const detectLanguage = (text) => {
  const hindiPattern = /[\u0900-\u097F]/g;
  const marathiPattern = /[\u0900-\u097F]/g;
  const englishPattern = /[a-zA-Z]/g;

  const hindiMatches = (text.match(hindiPattern) || []).length;
  const marathiMatches = (text.match(marathiPattern) || []).length;
  const englishMatches = (text.match(englishPattern) || []).length;

  if (hindiMatches > englishMatches && hindiMatches > 0) {
    return 'hindi';
  } else if (marathiMatches > englishMatches && marathiMatches > 0) {
    return 'marathi';
  } else if (englishMatches > hindiMatches) {
    return 'english';
  } else {
    return 'hinglish';
  }
};

// Helper function to check if user wants structured data (table/chart)
const wantsStructuredData = (prompt) => {
  const structuredKeywords = [
    "table", "chart", "graph", "visualize", "data", "statistics", 
    "compare", "trend", "summary", "list", "format", "structure"
  ];
  const lowerPrompt = prompt.toLowerCase();
  return structuredKeywords.some(keyword => lowerPrompt.includes(keyword));
};

// Helper function to get date range for current month
const getCurrentMonthRange = () => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  return { startOfMonth, endOfMonth };
};

// Helper function to format document data for AI context
const formatDocumentsForAI = (documents, category) => {
  return documents.map(doc => ({
    name: doc.title || doc.originalName,
    date: doc.date || doc.uploadedAt,
    type: doc.type || doc.category,
    description: doc.description,
    size: doc.size || doc.fileSize,
    status: doc.status,
    id: doc._id,
    s3Key: doc.s3Key
  }));
};

// Helper function to generate preview URLs
const generatePreviewUrls = (documents) => {
  return documents.map(doc => ({
    ...doc,
    previewUrl: `${process.env.BASE_URL || 'http://localhost:5000'}/api/files/${doc.id}/preview`
  }));
};

// Helper: parse natural-language date ranges like "past week", "last 7 days", "yesterday", or explicit ranges
const parseDateRangeFromPrompt = (prompt) => {
  const lower = (prompt || '').toLowerCase();
  const now = new Date();

  // Today
  if (/(today|todays|for today)/i.test(lower)) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return { start, end, label: 'today' };
  }

  // Yesterday
  if (/(yesterday)/i.test(lower)) {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    const start = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 0, 0, 0);
    const end = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 23, 59, 59, 999);
    return { start, end, label: 'yesterday' };
  }

  // Past/Last N days
  const lastNDaysMatch = lower.match(/(past|last)\s+(\d{1,3})\s*(day|days)/i);
  if (lastNDaysMatch) {
    const n = Math.min(parseInt(lastNDaysMatch[2], 10) || 0, 365);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const start = new Date(end);
    start.setDate(start.getDate() - n + 1);
    return { start, end, label: `last_${n}_days` };
  }

  // Past week / last week / past 7 days
  if (/(past\s+week|last\s+week|past\s*7\s*days)/i.test(lower)) {
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    return { start, end, label: 'last_7_days' };
  }

  // Past month / last 30 days
  if (/(past\s+month|last\s+month|past\s*30\s*days)/i.test(lower)) {
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const start = new Date(end);
    start.setDate(start.getDate() - 29);
    return { start, end, label: 'last_30_days' };
  }

  // This month
  if (/(this\s+month)/i.test(lower)) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    return { start, end, label: 'this_month' };
  }

  // Explicit range: from/to or between X and Y (accepts yyyy-mm-dd or dd/mm/yyyy)
  const dateTokenToDate = (s) => {
    if (!s) return null;
    // Normalize separators
    const t = s.trim().replace(/\./g, '-').replace(/\//g, '-');
    // yyyy-mm-dd
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(t)) {
      const [Y, M, D] = t.split('-').map(Number);
      return new Date(Y, M - 1, D);
    }
    // dd-mm-yyyy
    if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(t)) {
      const [D, M, Y] = t.split('-').map(Number);
      return new Date(Y, M - 1, D);
    }
    const d = new Date(t);
    return isNaN(d.getTime()) ? null : d;
  };

  const betweenMatch = lower.match(/\b(between|from)\s+([\d.\/-]+)\s+(and|to)\s+([\d.\/-]+)/i);
  if (betweenMatch) {
    const d1 = dateTokenToDate(betweenMatch[2]);
    const d2 = dateTokenToDate(betweenMatch[4]);
    if (d1 && d2) {
      const start = new Date(d1.getFullYear(), d1.getMonth(), d1.getDate(), 0, 0, 0, 0);
      const end = new Date(d2.getFullYear(), d2.getMonth(), d2.getDate(), 23, 59, 59, 999);
      return { start, end, label: 'custom_range' };
    }
  }

  return null; // no explicit range
};

// Helper: build simple aggregations for charts/tables from documents
const buildDocumentAggregations = (docs) => {
  const byType = {};
  const byDay = {};
  for (const d of docs) {
    const type = (d.type || d.category || 'Unknown');
    byType[type] = (byType[type] || 0) + 1;
    const dt = new Date(d.uploadedAt || d.date || Date.now());
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    byDay[key] = (byDay[key] || 0) + 1;
  }
  const typeLabels = Object.keys(byType);
  const typeValues = typeLabels.map(k => byType[k]);
  const dayLabels = Object.keys(byDay).sort();
  const dayValues = dayLabels.map(k => byDay[k]);
  return {
    countsByType: { labels: typeLabels, values: typeValues },
    countsByDay: { labels: dayLabels, values: dayValues }
  };
};

// Helper: detect schedule/appointment related queries
const isScheduleQuery = (prompt) => {
  const keywords = [
    'schedule', 'appointment', 'appointments', 'today', 'urgent', 'emergency',
    'cases', 'my patients today', 'what do i have', 'agenda'
  ];
  const lower = (prompt || '').toLowerCase();
  return keywords.some(k => lower.includes(k));
};

// Helper: extract a documentId mentioned in the prompt like "document <id>"
const extractDocumentIdFromPrompt = (prompt) => {
  const m = (prompt || '').match(/document\s+([a-f\d]{24})/i);
  return m ? m[1] : null;
};

// Helper: extract a probable document title after keywords like "analyze"
const extractDocumentTitleFromPrompt = (prompt) => {
  const lower = (prompt || '').toLowerCase();
  // try phrases like: analyze <title>, analyze the <title>
  const m = lower.match(/analy[sz]e\s+(the\s+)?(.+)/i);
  if (m && m[2]) {
    // strip trailing filler words
    return m[2]
      .replace(/[\.!?].*$/, '')
      .replace(/\b(report|document|file)\b/g, '')
      .trim();
  }
  return null;
};

// Helper: simple Levenshtein distance for fuzzy matching
const levenshtein = (a = '', b = '') => {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + cost);
    }
  }
  return m[a.length][b.length];
};

const normalizeTitle = (s = '') => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Helper: detect urgent filter intent
const isUrgentQuery = (prompt) => {
  const lower = (prompt || '').toLowerCase();
  return lower.includes('urgent') || lower.includes('emergency') || lower.includes('critical');
};

// Helper: detect patient list queries
const isPatientsQuery = (prompt) => {
  const keywords = ['my patients', 'patients', 'active patients', 'list patients'];
  const lower = (prompt || '').toLowerCase();
  return keywords.some(k => lower.includes(k));
};

// Helper: get start/end of today in local time
const getTodayRange = () => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  return { start, end };
};

// Helper: format appointments for AI context and frontend data
const formatAppointmentsForAI = (appointments) => {
  return appointments.map(a => ({
    id: a._id,
    name: a.patientName,
    date: new Date(`${a.appointmentDate.toISOString().split('T')[0]}T${a.appointmentTime}`),
    type: a.appointmentType,
    status: a.status,
    reason: a.reason
  }));
};

const asLowerText = (value) => String(value || "").trim().toLowerCase();

const asBoolean = (value, fallback = false) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
};

const normalizeSectionKey = (title = "") =>
  String(title || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const parsePipeTable = (rawText = "") => {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const candidateLines = lines.filter((line) => line.includes("|"));
  if (candidateLines.length < 2) return null;

  const parseRow = (line) =>
    line
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);

  let headerIndex = -1;
  for (let i = 0; i < candidateLines.length - 1; i += 1) {
    const current = candidateLines[i];
    const next = candidateLines[i + 1];
    if (
      current.includes("|") &&
      (/^-{2,}\s*\|/.test(next) || /\|\s*-{2,}/.test(next))
    ) {
      headerIndex = i;
      break;
    }
  }

  const tableLines =
    headerIndex >= 0 ? candidateLines.slice(headerIndex) : candidateLines;
  if (tableLines.length < 2) return null;

  const headerCells = parseRow(tableLines[0]);
  if (headerCells.length < 2) return null;

  const bodyStart =
    tableLines.length > 1 &&
    (/^-{2,}\s*\|/.test(tableLines[1]) || /\|\s*-{2,}/.test(tableLines[1]))
      ? 2
      : 1;

  const rows = tableLines
    .slice(bodyStart)
    .map(parseRow)
    .filter((row) => row.length > 0)
    .map((row) => {
      const normalized = row.slice(0, headerCells.length);
      while (normalized.length < headerCells.length) normalized.push("—");
      return normalized;
    });

  if (rows.length === 0) return null;

  return {
    columns: headerCells,
    rows,
  };
};

const parseSectionsFromReply = (reply, persona = "patient") => {
  const rawLines = String(reply || "").split(/\r?\n/);
  const knownHeadings = new Set([
    "summary",
    "clinical summary",
    "key points",
    "key findings",
    "important details",
    "structured data",
    "table",
    "what this means",
    "clinical relevance",
    "what to do next",
    "next steps",
    "follow-up considerations",
    "pertinent history",
    "missing / unclear information",
    "missing or unclear information",
    "missing information",
    "urgent warning signs",
    "get urgent help now if",
    "safety",
    "plain language summary",
    "document type",
    "source details",
    "extracted data",
    "important / abnormal flags",
    "important flags",
    "extraction confidence",
  ]);

  const isHeadingLine = (line) => {
    const trimmed = String(line || "").trim();
    if (!trimmed) return false;

    const noHashes = trimmed.replace(/^#{1,3}\s*/, "");
    const withColon = noHashes.replace(/[:\-]\s*$/, "").trim();
    const lowered = withColon.toLowerCase();
    if (knownHeadings.has(lowered)) return true;

    // Generic heading fallback (short standalone title line).
    if (
      /^[A-Za-z][A-Za-z0-9\s/&()_-]{2,50}$/.test(withColon) &&
      trimmed.length <= 60 &&
      !trimmed.startsWith("- ") &&
      !/^\d+\./.test(trimmed)
    ) {
      return true;
    }
    return false;
  };

  const toTitle = (line) => {
    const trimmed = String(line || "").trim().replace(/^#{1,3}\s*/, "");
    return trimmed.replace(/[:\-]\s*$/, "").trim();
  };

  const fallbackTitle = persona === "doctor" ? "Clinical Summary" : "Summary";
  const blocks = [];
  let current = { title: fallbackTitle, lines: [] };

  for (const rawLine of rawLines) {
    const line = rawLine ?? "";
    if (isHeadingLine(line)) {
      if (current.lines.length > 0 || current.title !== fallbackTitle) {
        blocks.push(current);
      }
      current = { title: toTitle(line), lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  if (current.lines.length > 0 || blocks.length === 0) {
    blocks.push(current);
  }

  const normalizedSections = [];
  for (const block of blocks) {
    const content = block.lines.join("\n").trim();
    if (!content) continue;

    const tableData = parsePipeTable(content);
    if (tableData) {
      normalizedSections.push({
        key: normalizeSectionKey(block.title) || "table",
        title: block.title || "Table",
        type: "table",
        data: tableData,
      });
      continue;
    }

    const bullets = block.lines
      .map((line) => String(line || "").trim())
      .filter((line) => /^[-*•]\s+/.test(line) || /^\d+\.\s+/.test(line))
      .map((line) => line.replace(/^[-*•]\s+/, "").replace(/^\d+\.\s+/, "").trim())
      .filter(Boolean);

    if (bullets.length >= 2) {
      normalizedSections.push({
        key: normalizeSectionKey(block.title) || "key_points",
        title: block.title || "Key Points",
        type: "bullets",
        items: bullets,
      });
      continue;
    }

    normalizedSections.push({
      key: normalizeSectionKey(block.title) || "summary",
      title: block.title || fallbackTitle,
      content,
    });
  }

  return normalizedSections;
};

const buildResponseSections = ({
  persona,
  reply,
  parsedSections,
  structuredData,
  responseType,
  documentMetadata,
  safety,
}) => {
  const sections = Array.isArray(parsedSections) && parsedSections.length > 0
    ? [...parsedSections]
    : [
        {
          key: persona === "doctor" ? "clinical_summary" : "summary",
          title: persona === "doctor" ? "Clinical Summary" : "Summary",
          content: reply,
        },
      ];

  if (structuredData) {
    const hasStructuredSection = sections.some(
      (section) =>
        String(section?.type || "").toLowerCase() === "table" ||
        String(section?.type || "").toLowerCase() === "chart" ||
        section?.key === "structured_data"
    );
    if (!hasStructuredSection) {
      sections.push({
        key: "structured_data",
        title: "Structured Data",
        type: responseType || "table",
        data: structuredData,
      });
    }
  }

  if (documentMetadata) {
    sections.push({
      key: "document_details",
      title: "Document Details",
      data: documentMetadata,
    });
  }

  if (safety?.warnings?.length) {
    const hasSafetySection = sections.some(
      (section) => section?.key === "safety"
    );
    if (!hasSafetySection) {
      sections.push({
        key: "safety",
        title: "Safety",
        warnings: safety.warnings,
      });
    }
  }

  return sections;
};

// Helper function to generate system prompt with user context
const generateSystemPrompt = (user, documents, isDocumentQuery = false, language = 'english', documentContent = null, wantsStructured = false, userRole = 'doctor', patientId = null, conversationContext = null) => {
  const userName = user.name || "User";
  const role = asLowerText(userRole);
  const userRoleContext =
    role === "doctor"
      ? "medical professional"
      : role === "patient"
        ? "patient"
        : "operations user";

  const platform =
    role === "doctor"
      ? "Web Dashboard"
      : role === "patient"
        ? "Mobile App"
        : "Admin Console";

  const roleInstructions =
    role === "doctor"
      ? `
IF userRole == DOCTOR:
- Clinical, concise language
- Highlight trends and abnormalities
- Use medical terminology appropriately
- Never override medical judgment
- Focus on actionable insights
- Provide comparison tables for lab values
- Identify patterns and trends across reports
`
      : role === "patient"
        ? `
IF userRole == PATIENT:
- Simple, reassuring language
- Explain terms in plain words
- Never diagnose or prescribe
- Use encouraging tone when values improve
- Always recommend doctor consultation when needed
- Make complex medical data understandable
`
        : `
IF userRole == ADMIN or SUPERADMIN:
- Provide operational and compliance-aware assistance
- Avoid patient-sensitive details unless explicit patient context is present
- Keep language concise, structured, and policy-safe
- Distinguish facts from recommendations
`;
  
  const basePrompt = `You are a Medical Data Analysis and Explanation AI embedded inside a secure Medical Vault platform.

You behave like a highly experienced medical assistant who can read, compare, and explain medical reports with extreme accuracy and clarity.

You are NOT a chatbot.
You are a medical-grade analytical assistant.

--------------------------------------------------
GLOBAL OPERATING PRINCIPLES
--------------------------------------------------

- You answer ONLY what is asked.
- You NEVER guess or hallucinate values.
- You ONLY use data present in uploaded files.
- You adapt language, depth, and tone automatically.
- You remember context across this conversation until the user clears the chat.

--------------------------------------------------
ROLE AND PLATFORM AWARENESS
--------------------------------------------------

CURRENT USER ROLE: ${userRole}
CURRENT USER NAME: ${userName}
PLATFORM: ${platform}
${patientId ? `CURRENT PATIENT ID: ${patientId}` : ''}

${roleInstructions}

--------------------------------------------------
LANGUAGE HANDLING
--------------------------------------------------

- Detected language: ${language}
- Respond in the SAME language as user input
- If Hinglish detected, respond in natural Hinglish
- Never switch language mid-response
- Maintain language consistency throughout conversation

--------------------------------------------------
INTENT DETECTION (CRITICAL)
--------------------------------------------------

Before responding, classify user intent:

- View files → List documents with dates and types
- Analyze reports → Extract and explain key findings
- Compare reports → Create comparison table with trends
- Trend over time → Show chronological progression
- Summary explanation → Provide concise overview
- Specific value lookup → Find and display exact values

Example Intent Analysis:
User: "Show and analyze my past 6 months diabetic reports"
→ INTENT CLASSIFICATION:
  - Date range: Past 6 months
  - Condition: Diabetes
  - Action: Compare + Analyze
  - Expected output: Comparison table + trend analysis

--------------------------------------------------
DOCUMENT SELECTION LOGIC
--------------------------------------------------

When a medical analysis is requested:

1. Identify condition or test type (e.g., Diabetes, Blood Pressure, Cholesterol)
2. Identify date range (e.g., past 6 months, last year, specific dates)
3. Select ONLY relevant reports:
   - Match test names and conditions
   - Filter by date range
   - Ignore completely unrelated documents

4. If NO relevant files exist:
   "I could not find any [condition/requested type] reports in the specified time period.
    Please upload the reports or adjust the date range."

5. If multiple relevant files exist:
   - Sort chronologically (oldest to newest)
   - Include all matching reports in comparison
   - Do not ask for clarification unless absolutely necessary

--------------------------------------------------
DATA EXTRACTION RULES
--------------------------------------------------

From each report, extract ONLY verified values:
- Test name (exact as written)
- Result value (numeric or text)
- Unit of measurement
- Reference range (if present in document)
- Report date
- File name or document identifier

CRITICAL RULES:
- NEVER infer missing tests
- NEVER normalize units unless clearly specified
- NEVER assume values not explicitly stated
- If value is unclear, mark as "Not available" or "—"
- Preserve original units and formatting

--------------------------------------------------
PRIMARY OUTPUT: COMPARISON TABLE
--------------------------------------------------

WHEN USER ASKS FOR ANALYSIS OR COMPARISON:

ALWAYS FIRST SHOW A COMPARISON TABLE.

Table Structure Rules:
- One row per test parameter
- One column per report date
- Sorted chronologically (oldest → newest)
- Missing values shown as "—" or "Not available"
- Include normal/reference ranges when available
- Clear column headers with dates

EXAMPLE TABLE FORMAT (PATIENT VIEW):

Diabetes Report Comparison (Last 6 Months)

Test Name     | 2025-08-12 | 2025-10-03 | 2026-01-05 | Normal Range
--------------|------------|------------|------------|-------------
Fasting Sugar | 142 mg/dL  | 136 mg/dL  | 128 mg/dL  | 70–100
PP Sugar      | 210 mg/dL  | 198 mg/dL  | 182 mg/dL  | <140
HbA1c         | 8.2 %      | 7.8 %      | 7.1 %      | <5.7

DOCTOR VIEW:
- Same table structure
- More concise explanatory text
- Focus on clinical significance

--------------------------------------------------
SECONDARY OUTPUT: FILE TRACEABILITY
--------------------------------------------------

After the comparison table, ALWAYS list files used:

Files Analyzed:
- Blood_Report_Aug_2025.pdf (12 Aug 2025)
- Diabetic_Panel_Oct_2025.pdf (03 Oct 2025)
- Lab_Report_Jan_2026.pdf (05 Jan 2026)

This ensures transparency and allows users to verify sources.

--------------------------------------------------
TERTIARY OUTPUT: ANALYSIS AND EXPLANATION
--------------------------------------------------

${userRole === 'doctor' ? `
DOCTOR MODE ANALYSIS:
- Bullet-point format
- Highlight improvement or deterioration trends
- Identify abnormal values
- Note clinical significance
- No emotional tone
- Focus on actionable insights

Example:
- HbA1c shows downward trend (8.2% → 7.1%), indicating improved glycemic control
- Fasting glucose remains elevated but trending downward
- Recommend continued monitoring and medication adherence review
` : `
PATIENT MODE ANALYSIS:
- Simple, reassuring explanation
- Trend-based insights
- Encouraging tone when values improve
- Clear, non-technical language
- Always include doctor consultation recommendation

Example:
"Your blood sugar levels have been steadily improving over the last 6 months.
The HbA1c value has reduced from 8.2% to 7.1%, which means your long-term sugar control is getting better.
However, the values are still above the normal range, so regular follow-ups with your doctor are important."
`}

--------------------------------------------------
DECORATIVE PRESENTATION RULES
--------------------------------------------------

- Clean spacing between sections
- Clear section separation using horizontal lines
- Short, focused paragraphs
- No visual clutter
- Tables always first, explanation after
- File list after table
- Analysis/explanation last

Structure Order:
1. Comparison Table
2. Files Analyzed
3. Analysis/Explanation

--------------------------------------------------
FORMATTING RULES (STRICT)
--------------------------------------------------

- Plain text only
- No markdown syntax
- No emojis or symbols
- No asterisks, hash symbols, or backticks
- Use hyphen (-) for bullets
- Tables only where appropriate (comparisons, trends)
- Clean spacing and readability
- Consistent alignment in tables

--------------------------------------------------
CHART COMPATIBILITY (IMPORTANT)
--------------------------------------------------

When trends are requested, structure data so frontend can convert it into charts.

Provide data in this format (INTERNAL STRUCTURE for parsing):
Date: 2025-08-12 | Test: HbA1c | Value: 8.2
Date: 2025-10-03 | Test: HbA1c | Value: 7.8
Date: 2026-01-05 | Test: HbA1c | Value: 7.1

DO NOT explain charts unless explicitly asked.
Focus on the data and trends in text format.

--------------------------------------------------
SAFETY AND MEDICAL BOUNDARIES
--------------------------------------------------

- Never provide final diagnosis
- Never prescribe medicines
- Never say "you have [condition]" definitively
- Use phrases like:
  - "These values suggest"
  - "This may indicate"
  - "The results show"
  - "Please consult your doctor"
  - "This requires medical attention"

For critical values:
- Immediately highlight the concern
- Strongly recommend urgent medical consultation
- Do not minimize serious abnormalities

--------------------------------------------------
SESSION MEMORY RULE
--------------------------------------------------

- Remember selected condition, date range, and reports used
- Reuse context for follow-up questions
- Maintain conversation continuity
- Clear memory only when user explicitly says:
  - "Clear chat"
  - "Reset conversation"
  - "Start over"

Example:
User: "Analyze my diabetic reports from last 6 months"
AI: [Provides analysis]
User: "What about my cholesterol?"
AI: [Uses same date range context, switches to cholesterol reports]

--------------------------------------------------
CURRENT SESSION CONTEXT
--------------------------------------------------

User Information:
- Name: ${userName}
- Role: ${userRoleContext}
- User ID: ${user._id}
${patientId ? `- Current Patient ID: ${patientId}` : ''}
- Response Language: ${language}
- Platform: ${platform}

${conversationContext ? `
Conversation History:
- Session started: ${conversationContext.sessionStart ? new Date(conversationContext.sessionStart).toLocaleString() : 'Unknown'}
- Previous topics: ${conversationContext.topics ? conversationContext.topics.join(', ') : 'None'}
- Last interaction: ${conversationContext.lastInteraction ? new Date(conversationContext.lastInteraction).toLocaleString() : 'Now'}
- User preferences: ${conversationContext.preferences ? JSON.stringify(conversationContext.preferences) : 'None'}
` : ''}

--------------------------------------------------
FINAL GOAL
--------------------------------------------------

Deliver hospital-grade report analysis that is:
- Accurate (only verified data)
- Readable (clear structure and language)
- Safe (appropriate medical boundaries)
- Trusted (by both patients and doctors)

Always prioritize:
Accuracy > Relevance > Clarity > Safety`;

  if (isDocumentQuery && documents && documents.length > 0) {
    if (documentContent) {
      // Document analysis prompt - Enhanced for medical data analysis
      return `${basePrompt}

--------------------------------------------------
CURRENT TASK: MEDICAL REPORT ANALYSIS
--------------------------------------------------

DOCUMENT CONTENT PROVIDED:
${documentContent}

CRITICAL ANALYSIS INSTRUCTIONS:

1. INTENT CLASSIFICATION:
   - Determine what the user wants: analysis, comparison, specific values, or summary
   - Identify condition or test type mentioned (if any)
   - Note date range requested (if specified)

2. DATA EXTRACTION:
   - Extract ALL test parameters with exact values
   - Capture units of measurement
   - Note reference/normal ranges
   - Identify report date
   - Preserve original formatting

3. RESPONSE STRUCTURE:
   ${userRole === 'doctor' ? `
   FOR DOCTOR:
   - If comparison requested: Create comparison table first
   - List file analyzed
   - Provide clinical analysis with trends
   - Highlight abnormalities
   - Keep language professional and concise
   ` : `
   FOR PATIENT:
   - If comparison requested: Create comparison table first
   - List file analyzed
   - Provide simple explanation
   - Explain what values mean in plain language
   - Use reassuring tone
   - Always recommend doctor consultation
   `}

4. TABLE GENERATION (if applicable):
   - Create comparison table if multiple values or dates
   - Sort chronologically (oldest to newest)
   - Include normal ranges
   - Mark missing values as "—"

5. ACCURACY REQUIREMENTS:
   - Use ONLY information present in the document
   - NEVER guess or infer missing values
   - If value is unclear, mark as "Not available"
   - If information is missing, clearly state what is missing

${wantsStructured ? `
6. STRUCTURED DATA:
   - If user requested structured data (table/chart), provide it in JSON format
   - Format: { "labels": [...], "values": [...], "dates": [...] }
   - Ensure data is parseable by frontend
` : ''}

RESPONSE FORMAT:
- Respond in ${language}
- Follow the structure: Table → Files → Analysis
- Use plain text with hyphen bullets (no markdown)
- Maintain medical accuracy above all

Remember: This is a real medical document. Hospital-grade accuracy is required.`;
    } else {
      // Document listing prompt - Enhanced for medical context
      const groupedDocs = documents.reduce((acc, doc) => {
        const type = doc.type || doc.category;
        if (!acc[type]) acc[type] = [];
        acc[type].push(doc);
        return acc;
      }, {});
      
      let documentList = "";
      Object.entries(groupedDocs).forEach(([type, docs]) => {
        documentList += `\n${type}s (${docs.length}):\n`;
        docs.forEach(doc => {
          const docDate = doc.date || doc.uploadedAt;
          documentList += `- ${doc.title || doc.originalName} (${docDate})\n`;
        });
      });
      
      return `${basePrompt}

--------------------------------------------------
CURRENT TASK: MEDICAL DOCUMENT LISTING
--------------------------------------------------

DOCUMENTS AVAILABLE:${documentList}

RESPONSE REQUIREMENTS:

1. LIST STRUCTURE:
   - Group by document type (Reports, Prescriptions, Bills, etc.)
   - Show document count per category
   - List documents with dates in chronological order

2. FILTERING LOGIC:
   - If user asked for specific type (e.g., "diabetic reports") → filter and show only matching documents
   - If user asked for date range → show only documents within that range
   - If user asked for condition-specific → identify and list relevant reports

3. RESPONSE FORMAT:
   - Use plain text with hyphen bullets (no markdown)
   - Keep response focused and scannable
   - Include dates for each document
   - Mention total count

4. NEXT STEPS SUGGESTION:
   - If documents are listed, suggest: "You can ask me to analyze any of these reports"
   - If no matching documents: "I could not find [requested type] reports. Please upload them or adjust your search criteria."

Do NOT analyze document content - just list what's available as requested.
If user wants analysis, they will ask for it after seeing the list.`;
    }
  }
  
  return `${basePrompt}

--------------------------------------------------
CURRENT TASK: GENERAL MEDICAL ASSISTANCE
--------------------------------------------------

You can help with:
- Medical document queries and analysis
- Report comparisons and trend analysis
- Health information and explanations
- General medical guidance (non-diagnostic)
- Appointment and schedule information
- Patient record summaries

RESPONSE GUIDELINES:
- Answer exactly what is asked
- Use available context (documents, appointments, records)
- If data is missing, clearly state what is needed
- Adapt response depth to question complexity
- Keep responses concise and relevant
- Respond in ${language}
- Follow the medical data analysis principles above
- Keep output presentation-ready for mobile screens:
  - Start with a short summary
  - Then add short section headings
  - Use hyphen bullets for key points
  - Use plain-text pipe tables only when structured values exist
  - Keep each bullet short and scannable
  - End with practical next steps

Remember: You are a medical-grade analytical assistant, not a replacement for professional medical judgment.
Always prioritize accuracy, safety, and appropriate medical boundaries.`;
};

// POST /api/ai/ask - Main AI Assistant endpoint
router.post("/ask", auth, async (req, res) => {
  try {
    const { prompt, documentId, patientId, conversationContext, conversationId } =
      req.body || {};
    const requestContext =
      req.body && typeof req.body.context === "object" && req.body.context
        ? req.body.context
        : {};
    const incomingConversationId =
      conversationId || requestContext.conversationId || null;
    
    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid prompt",
      });
    }

    // Resolve authenticated principal and persona from auth only.
    const role = normalizeRole(req.auth?.role);
    const persona = resolvePersona(role);
    const requesterId = String(req.auth?.id || "");

    let currentUser = null;
    if (role === "doctor") {
      const doctor = await DoctorUser.findById(req.auth.id).select("-password");
      if (!doctor) {
        return res.status(404).json({ success: false, message: "Doctor not found" });
      }
      currentUser = doctor;
    } else if (role === "patient") {
      const patient = await User.findById(req.user?._id || req.auth?.id).select("-password");
      if (!patient) {
        return res.status(404).json({ success: false, message: "User not found" });
      }
      currentUser = patient;
    } else if (role === "admin") {
      const admin = await AdminUser.findById(req.auth.id).select("-password");
      if (!admin) {
        return res.status(404).json({ success: false, message: "Admin not found" });
      }
      currentUser = admin;
    } else if (role === "superadmin") {
      currentUser = {
        _id: req.auth?.id || req.superAdmin?.email || "superadmin",
        name: req.superAdmin?.email || req.auth?.email || "Super Admin",
        preferences: {},
      };
    } else {
      return res.status(403).json({ success: false, message: "Unsupported role" });
    }

    // Resolve language with preference-first behavior + per-message override.
    const languageResolution = resolveLanguage({
      prompt,
      context: {
        preferredLanguage:
          requestContext.preferredLanguage ||
          requestContext.language ||
          requestContext.locale ||
          null,
        userInputLanguage: requestContext.userInputLanguage || null,
      },
      principal: currentUser,
    });
    const language = languageResolution.resolvedLanguage;
    const wantsStructured = wantsStructuredData(prompt);
    const isDocumentRequest = isDocumentQuery(prompt);
    const isScheduleRequest = isScheduleQuery(prompt);
    const isUrgent = isUrgentQuery(prompt);
    const isPatientsList = isPatientsQuery(prompt);

    const selectedPatientProfile = String(
      requestContext.selectedPatientProfile || patientId || ""
    ).trim();
    const activeProfile = String(requestContext.activeProfile || "").trim();

    let targetPatientId = null;
    if (role === "patient") {
      targetPatientId = String(currentUser?._id || req.auth?.id || "");
    } else if (["doctor", "admin", "superadmin"].includes(role)) {
      targetPatientId = selectedPatientProfile || null;
    }

    const targetUserId =
      role === "patient" ? String(currentUser?._id || "") : targetPatientId;

    // Try to infer document by explicit id or fuzzy title
    let requestedDocumentId = documentId || extractDocumentIdFromPrompt(prompt);
    let requestedTitle = !requestedDocumentId ? extractDocumentTitleFromPrompt(prompt) : null;

    const patientSensitiveIntent = isPatientSensitiveIntent(prompt, {
      isDocumentRequest,
      requestedDocumentId,
      requestedTitle,
      isScheduleRequest,
      isPatientsList,
    });

    if (role === "doctor") {
      if (targetPatientId) {
        const allowed = await canDoctorAccessPatient(requesterId, String(targetPatientId));
        if (!allowed) {
          return res.status(403).json({
            success: false,
            code: "NO_ACTIVE_SESSION",
            message: "No active doctor-patient relationship",
          });
        }
      } else if (patientSensitiveIntent) {
        return res.status(400).json({
          success: false,
          code: "PATIENT_CONTEXT_REQUIRED",
          message: "Please select a patient profile to continue with patient-specific assistance.",
          context: {
            resolvedPersona: persona,
            resolvedLanguage: language,
          },
        });
      }
    }

    if (role === "admin" || role === "superadmin") {
      if (!targetPatientId && patientSensitiveIntent) {
        return res.status(403).json({
          success: false,
          code: "PATIENT_CONTEXT_REQUIRED",
          message:
            "Patient-sensitive analysis requires an explicit patient context in this admin workflow.",
        });
      }
      if (!targetPatientId && !isOperationalIntent(prompt)) {
        return res.status(403).json({
          success: false,
          code: "ADMIN_OPERATIONAL_ONLY",
          message:
            "Admin assistant is limited to operational/compliance guidance unless a patient context is explicitly selected.",
        });
      }
      if (targetPatientId) {
        const patientExists = await User.findById(targetPatientId).select("_id").lean();
        if (!patientExists) {
          return res.status(404).json({
            success: false,
            message: "Selected patient profile was not found",
          });
        }
      }
    }

    const authorizedScope = buildAuthorizedScope({
      role,
      requesterId,
      patientId: targetPatientId,
      sessionScope: requestContext.authorizedSessionScope || null,
    });

    let documents = [];
    let documentData = [];
    let documentContent = null;
    let documentMetadata = null;
    const missingDataWarnings = [];

    if (requestedDocumentId) {
      try {
        console.log(`📄 Analyzing document ID: ${requestedDocumentId}`);
        
        const document = await Document.findById(requestedDocumentId);
        if (!document) {
          console.log(`❌ Document not found: ${requestedDocumentId}`);
          return res.status(404).json({
            success: false,
            message: "Document not found"
          });
        }

        const documentOwnerId = String(document.userId || "");
        const selfUserId = String(currentUser?._id || "");
        let hasDocumentAccess = false;
        if (role === "patient") {
          hasDocumentAccess = documentOwnerId === selfUserId;
        } else if (role === "doctor") {
          hasDocumentAccess = !!targetPatientId && documentOwnerId === String(targetPatientId);
        } else if (role === "admin" || role === "superadmin") {
          hasDocumentAccess = !!targetPatientId && documentOwnerId === String(targetPatientId);
        }
        if (!hasDocumentAccess) {
          return res.status(403).json({ success: false, message: "Access denied to this document" });
        }

        console.log(`📋 Document details:`, {
          id: document._id,
          title: document.title,
          type: document.type,
          s3Key: document.s3Key,
          s3Bucket: document.s3Bucket
        });

        // Check if document has S3 information
        if (!document.s3Key) {
          console.log(`❌ Document missing S3 key: ${documentId}`);
          return res.status(400).json({
            success: false,
            message: "Document file not found in storage"
          });
        }

        const bucketName = document.s3Bucket || process.env.AWS_S3_BUCKET_NAME;
        console.log(`🪣 Using bucket: ${bucketName}`);

        // Extract text from the document
        console.log(`🔍 Starting text extraction for: ${document.s3Key}`);
        let extractionResult;
        try {
          extractionResult = await documentReader.extractTextFromS3(
            document.s3Key, 
            bucketName
          );
          console.log(`✅ Text extraction completed:`, {
            success: extractionResult.success,
            textLength: extractionResult.text?.length || 0,
            error: extractionResult.error
          });
        } catch (extractionError) {
          console.error(`❌ Text extraction failed:`, extractionError);
          throw new Error(`Document extraction failed: ${extractionError.message}`);
        }

        console.log(`📝 Extraction result:`, {
          success: extractionResult.success,
          textLength: extractionResult.text?.length || 0,
          error: extractionResult.error
        });

        if (extractionResult.success) {
          documentContent = extractionResult.text;
          const extractionConfidence = estimateExtractionConfidence({
            metadata: extractionResult.metadata,
            text: extractionResult.text,
          });
          documentMetadata = {
            ...extractionResult.metadata,
            fileName: document.title || document.originalName,
            documentType: document.type,
            uploadedAt: document.uploadedAt,
            extractionConfidence,
          };
          
          // Add to documents array for context
          documents = [document];
          documentData = generatePreviewUrls(formatDocumentsForAI([document], document.type));
          if (extractionConfidence.level !== "high") {
            missingDataWarnings.push(...extractionConfidence.reasons);
          }
        } else {
          console.error(`❌ Text extraction failed: ${extractionResult.error}`);
          return res.status(500).json({
            success: false,
            message: `Failed to extract text from document: ${extractionResult.error}`
          });
        }
      } catch (error) {
        console.error("❌ Document analysis error:", error);
        console.error("Error stack:", error.stack);
        return res.status(500).json({
          success: false,
          message: `Failed to analyze document: ${error.message}`
        });
      }
    } else if (requestedTitle) {
      // Fuzzy title match within patient's docs
      const targetUserIdForTitle = targetUserId;
      if (!targetUserIdForTitle) {
        return res.status(400).json({
          success: false,
          message: "Patient context is required for title-based document analysis",
        });
      } else {
        const candidates = await Document.find({ userId: targetUserIdForTitle }).sort({ uploadedAt: -1 }).limit(50);
        const target = normalizeTitle(requestedTitle);
        let best = null;
        let bestScore = Number.MAX_SAFE_INTEGER;
        for (const c of candidates) {
          const titleNorm = normalizeTitle(c.title || c.originalName || '');
          if (!titleNorm) continue;
          const d = levenshtein(titleNorm, target);
          if (d < bestScore) { bestScore = d; best = c; }
          // Exact-ish containment wins immediately
          if (titleNorm.includes(target) || target.includes(titleNorm)) { best = c; break; }
        }
        const doc = best;
        if (doc) {
          // Analyze the matched document
          try {
            const bucketName = doc.s3Bucket || process.env.AWS_S3_BUCKET_NAME;
            const extractionResult = await documentReader.extractTextFromS3(doc.s3Key, bucketName);
            if (extractionResult.success) {
              documentContent = extractionResult.text;
              const extractionConfidence = estimateExtractionConfidence({
                metadata: extractionResult.metadata,
                text: extractionResult.text,
              });
              documentMetadata = {
                ...extractionResult.metadata,
                fileName: doc.title || doc.originalName,
                documentType: doc.type,
                uploadedAt: doc.uploadedAt,
                extractionConfidence,
              };
              documents = [doc];
              documentData = generatePreviewUrls(formatDocumentsForAI([doc], doc.type));
              if (extractionConfidence.level !== "high") {
                missingDataWarnings.push(...extractionConfidence.reasons);
              }
            } else {
              return res.status(500).json({ success: false, message: `Failed to extract text from document: ${extractionResult.error}` });
            }
          } catch (e) {
            return res.status(500).json({ success: false, message: `Failed to analyze document: ${e.message}` });
          }
        } else {
          console.log('No fuzzy match found for title:', requestedTitle);
          missingDataWarnings.push(`Could not find a matching document for "${requestedTitle}".`);
        }
      }
    } else if (isDocumentRequest) {
      // Fetch relevant documents based on query
      const lowerPrompt = prompt.toLowerCase();
      const dateRange = parseDateRangeFromPrompt(lowerPrompt);
      // If doctor without patient context, skip fetching documents (no target)
      if (!targetUserId) {
        return res.status(400).json({
          success: false,
          code: "PATIENT_CONTEXT_REQUIRED",
          message: "Please select a patient profile for document-specific queries.",
        });
      } else {
      
      const baseFilter = { userId: targetUserId };
      if (dateRange) {
        baseFilter.uploadedAt = { $gte: dateRange.start, $lte: dateRange.end };
      }

      if (lowerPrompt.includes("report") || lowerPrompt.includes("this month") || lowerPrompt.includes("recent")) {
        const { startOfMonth, endOfMonth } = getCurrentMonthRange();
        const filter = { ...baseFilter, type: "Report" };
        if (!dateRange && lowerPrompt.includes("this month")) {
          filter.uploadedAt = { $gte: startOfMonth, $lte: endOfMonth };
        }
        documents = await Document.find(filter).sort({ uploadedAt: -1 });
      } else if (lowerPrompt.includes("prescription")) {
        const filter = { ...baseFilter, type: "Prescription" };
        documents = await Document.find(filter).sort({ uploadedAt: -1 });
      } else if (lowerPrompt.includes("bill")) {
        const filter = { ...baseFilter, type: "Bill" };
        documents = await Document.find(filter).sort({ uploadedAt: -1 });
      } else if (lowerPrompt.includes("insurance")) {
        const filter = { ...baseFilter, type: "Insurance" };
        documents = await Document.find(filter).sort({ uploadedAt: -1 });
      } else {
        // General document query - get all documents (respect dateRange if any)
        documents = await Document.find(baseFilter).sort({ uploadedAt: -1 });
      }
      }
      // Format documents for response with preview URLs
      documentData = generatePreviewUrls(formatDocumentsForAI(documents, "general"));
      if (!documents || documents.length === 0) {
        missingDataWarnings.push("No matching documents were found in the current authorized scope.");
      }
      // If user asked for structured outputs, prepare simple aggregations for charts/tables
      if (documents && documents.length > 0) {
        const aggs = buildDocumentAggregations(documents);
        // Attach aggregations so frontend can render charts even if LLM didn't return JSON
        // We'll include these in the response later if needed
        req._docAggregations = aggs;
      }
    }

    // Optionally fetch today's appointments for doctor schedule queries
    let appointmentData = [];
    if (isScheduleRequest && role === 'doctor') {
      const { start, end } = getTodayRange();
      const todays = await Appointment.find({
        doctorId: req.auth.id,
        appointmentDate: { $gte: start, $lte: end }
      }).sort({ appointmentTime: 1 }).limit(20);
      let formatted = formatAppointmentsForAI(todays);
      if (isUrgent) {
        formatted = formatted.filter(a => (a.type === 'emergency') || /urgent|critical|emergency/i.test(a.reason || ''));
      }
      appointmentData = formatted;
    }

    // Optionally fetch recent patients list for doctor
    let patientsData = [];
    if (isPatientsList && role === 'doctor') {
      const since = new Date();
      since.setDate(since.getDate() - 30);
      const recent = await Appointment.find({
        doctorId: req.auth.id,
        appointmentDate: { $gte: since }
      }).sort({ appointmentDate: -1 });
      const seen = new Set();
      for (const a of recent) {
        if (!seen.has(a.patientId)) {
          seen.add(a.patientId);
          patientsData.push({ id: a.patientId, name: a.patientName, lastAppointmentDate: a.appointmentDate });
        }
        if (patientsData.length >= 20) break;
      }
    }

    // Generate system prompt with user context and documents; append appointment summary if relevant
    const appointmentContext = appointmentData.length > 0
      ? `\n\nToday's Appointments (${appointmentData.length}):\n` + appointmentData.map((a, i) => {
          const time = a.date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
          return `${i + 1}. ${time} - ${a.name} (${a.type}, ${a.status}) - ${a.reason}`;
        }).join('\n')
      : (isScheduleRequest && role === 'doctor' ? '\n\nToday: No appointments found.' : '');

    const patientsContext = patientsData.length > 0
      ? `\n\nActive Patients (last 30 days):\n` + patientsData.map((p, i) => `${i + 1}. ${p.name} - Last appointment: ${new Date(p.lastAppointmentDate).toLocaleDateString()}`).join('\n')
      : '';

    const systemPrompt = generateSystemPrompt(
      currentUser,
      documents,
      isDocumentRequest,
      language,
      documentContent,
      wantsStructured,
      persona,
      targetPatientId,
      conversationContext
    ) + appointmentContext + patientsContext;

    let effectiveSystemPrompt = systemPrompt;
    if (role === "admin" || role === "superadmin") {
      if (targetPatientId) {
        effectiveSystemPrompt +=
          "\n\nADMIN CONTEXT:\n- Explicit patient context was selected.\n- Use only authorized patient data.\n- Keep response compliance-aware and concise.";
      } else {
        effectiveSystemPrompt +=
          "\n\nADMIN CONTEXT:\n- Operational mode only.\n- Do not disclose patient-sensitive details.\n- Focus on compliance, workflows, and high-level operational guidance.";
      }
    }

    // Prepare messages for OpenAI API
    const messages = [
      {
        role: "system",
        content: effectiveSystemPrompt
      },
      {
        role: "user",
        content: prompt
      }
    ];

    // Call OpenAI API with optimized settings for speed
    console.log(`🤖 Calling OpenAI API...`);
    let openaiResponse;
    try {
      openaiResponse = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          messages: messages,
          max_tokens: documentContent ? 800 : (isDocumentRequest ? 300 : 500),
          temperature: 0.3,
          top_p: 0.8,
          stream: false
        },
        {
          headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          },
          timeout: 30000 // Increased timeout for document analysis
        }
      );
      console.log(`✅ OpenAI API call successful`);
    } catch (openaiError) {
      console.error(`❌ OpenAI API call failed:`, {
        status: openaiError.response?.status,
        statusText: openaiError.response?.statusText,
        data: openaiError.response?.data,
        message: openaiError.message
      });
      throw openaiError;
    }

    // Keep formatting stable for frontend section/table rendering.
    const rawReply = openaiResponse.data.choices[0].message.content || "";
    let aiReply = String(rawReply || "")
      .replace(/\r\n/g, "\n")
      .replace(/\u00A0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const parsedSections = parseSectionsFromReply(aiReply, persona);

    // Parse response for structured data
    let responseType = "text";
    let structuredData = null;
    
    if (wantsStructured) {
      try {
        // Try to parse JSON from the response
        const jsonMatch = aiReply.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          responseType = "table"; // Default to table for now
          structuredData = parsed;
        }
      } catch (e) {
        // If JSON parsing fails, keep as text
        console.log("Could not parse structured data from AI response");
      }
    }

    // If the model responded with a text table, convert first table for UI rendering.
    if (!structuredData) {
      const tableSection = parsedSections.find(
        (section) =>
          String(section?.type || "").toLowerCase() === "table" &&
          section?.data &&
          Array.isArray(section.data.columns) &&
          Array.isArray(section.data.rows)
      );
      if (tableSection) {
        responseType = "table";
        structuredData = tableSection.data;
      }
    }

    // Fallback: if user seems to want structured data or asked about documents and we computed aggregations
    if (!structuredData && (wantsStructured || isDocumentRequest) && req._docAggregations) {
      // Prefer a chart showing counts by type, and a table of daily counts
      responseType = wantsStructured ? 'chart' : 'table';
      structuredData = wantsStructured
        ? { title: 'Documents by Type', ...req._docAggregations.countsByType }
        : { title: 'Documents per Day', rows: req._docAggregations.countsByDay.values.map((v, i) => [req._docAggregations.countsByDay.labels[i], v]), columns: ['Date', 'Count'] };
    }

    // Provide structured lists for schedule/patients when available
    if (!structuredData && isScheduleRequest && appointmentData.length > 0) {
      responseType = 'list';
      structuredData = {
        title: isUrgent ? "Today's Urgent Cases" : "Today's Appointments",
        items: appointmentData.map(a => ({
          time: a.date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
          name: a.name,
          type: a.type,
          status: a.status,
          reason: a.reason
        }))
      };
    } else if (!structuredData && isPatientsList && patientsData.length > 0) {
      responseType = 'list';
      structuredData = {
        title: 'Active Patients (last 30 days)',
        items: patientsData.map(p => ({
          name: p.name,
          lastAppointment: new Date(p.lastAppointmentDate).toLocaleDateString()
        }))
      };
    }

    const extractionConfidence = documentMetadata?.extractionConfidence || null;
    const safety = buildSafetyPayload({
      prompt,
      reply: aiReply,
      extractionConfidence,
      missingData: missingDataWarnings,
    });
    const sections = buildResponseSections({
      persona,
      reply: aiReply,
      parsedSections,
      structuredData,
      responseType,
      documentMetadata,
      safety,
    });

    // Persist chat with 24h TTL
    let savedConversationId = incomingConversationId;
    try {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const chatFilter = {
        userId: String(req.auth?.id || currentUser?._id || ""),
        userRole: persona,
        ...(targetPatientId ? { patientId: String(targetPatientId) } : { patientId: null })
      };
      let chatDoc = null;
      if (incomingConversationId) {
        const candidate = await AIChat.findById(incomingConversationId);
        if (
          candidate &&
          candidate.userId === chatFilter.userId &&
          candidate.userRole === chatFilter.userRole &&
          String(candidate.patientId || "") === String(chatFilter.patientId || "")
        ) {
          chatDoc = candidate;
        }
      }
      if (!chatDoc) {
        chatDoc = await AIChat.findOne(chatFilter).sort({ updatedAt: -1 });
      }
      if (!chatDoc) {
        chatDoc = new AIChat({ ...chatFilter, messages: [], expiresAt });
      }
      chatDoc.messages.push(
        { role: 'user', content: prompt, timestamp: new Date() },
        { role: 'assistant', content: aiReply, timestamp: new Date(), metadata: { language, responseType, safety } }
      );
      chatDoc.lastActivityAt = new Date();
      chatDoc.expiresAt = expiresAt;
      chatDoc.context = {
        resolvedPersona: persona,
        resolvedLanguage: language,
        preferredLanguage: languageResolution.preferredLanguage,
        userInputLanguage: languageResolution.userInputLanguage,
        detectedLanguage: languageResolution.detectedLanguage,
        authorizedScope,
        voiceMode: asBoolean(requestContext.voiceMode, false),
        activeProfile: activeProfile || null,
        selectedPatientProfile: selectedPatientProfile || null,
      };
      await chatDoc.save();
      savedConversationId = chatDoc._id.toString();
    } catch (persistErr) {
      console.warn('⚠️ Failed to persist AI chat:', persistErr.message);
    }

    // Prepare response with enhanced context
    const response = {
      success: true,
      user: currentUser.name || "User",
      assistant: "AI Ally Assistant",
      reply: aiReply,
      language,
      responseType,
      structuredData,
      sections,
      safety,
      documentMetadata,
      data: documentData.length > 0 ? documentData : (appointmentData.length > 0 ? appointmentData : (patientsData.length > 0 ? patientsData : null)),
      model: (openaiResponse?.data?.model || 'gpt-4o-mini'),
      context: {
        userRole: persona, // backward-compat field name
        resolvedPersona: persona,
        resolvedLanguage: language,
        authorizedScope,
        patientId: targetPatientId,
        sessionId: Date.now(),
        timestamp: new Date().toISOString(),
        conversationId: savedConversationId,
        voiceMode: asBoolean(requestContext.voiceMode, false),
        preferredLanguage: languageResolution.preferredLanguage,
        userInputLanguage: languageResolution.userInputLanguage,
      }
    };

    // If it's a document query, add structured response with preview URLs
    if (isDocumentRequest && documentData.length > 0) {
      const category = documents[0]?.type || "documents";
      response.type = category.toLowerCase();
      response.title = `${category}s found`;
      response.items = documentData.map(doc => ({
        id: doc.id,
        name: doc.name,
        date: doc.date,
        type: doc.type,
        previewUrl: doc.previewUrl,
        description: doc.description
      }));
    }

    res.json(response);

  } catch (error) {
    console.error("AI Assistant error:", error);
    
    if (error.response?.status === 401) {
      return res.status(500).json({
        success: false,
        message: "OpenAI API authentication failed. Please check API key."
      });
    }
    
    if (error.code === "ECONNABORTED") {
      return res.status(500).json({
        success: false,
        message: "OpenAI API timeout. Please try again."
      });
    }
    
    if (error.response?.data?.error) {
      return res.status(500).json({
        success: false,
        message: `OpenAI API error: ${error.response.data.error.message}`
      });
    }

    res.status(500).json({
      success: false,
      message: "AI Assistant is temporarily unavailable. Please try again later."
    });
  }
});

// GET /api/ai/documents - Get user documents for AI assistant
router.get("/documents", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("-password");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Get all user documents
    const documents = await Document.find({
      userId: user._id.toString()
    }).sort({ uploadedAt: -1 }).limit(50); // Limit to recent 50 documents

    // Format documents with preview URLs
    const documentData = generatePreviewUrls(formatDocumentsForAI(documents, "all"));

    res.json({
      success: true,
      documents: documentData,
      count: documentData.length
    });

  } catch (error) {
    console.error("Get documents error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch documents"
    });
  }
});

// GET /api/ai/test-document/:documentId - Test document processing
router.get("/test-document/:documentId", auth, async (req, res) => {
  try {
    const { documentId } = req.params;
    const user = await User.findById(req.user._id).select("-password");
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    console.log(`🧪 Testing document processing for ID: ${documentId}`);
    
    const document = await Document.findById(documentId);
    if (!document) {
      return res.status(404).json({
        success: false,
        message: "Document not found"
      });
    }

    if (document.userId !== user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "Access denied"
      });
    }

    console.log(`📋 Document details:`, {
      id: document._id,
      title: document.title,
      type: document.type,
      s3Key: document.s3Key,
      s3Bucket: document.s3Bucket
    });

    // Test document extraction
    const extractionResult = await documentReader.extractTextFromS3(
      document.s3Key, 
      document.s3Bucket || process.env.AWS_S3_BUCKET_NAME
    );

    res.json({
      success: true,
      document: {
        id: document._id,
        title: document.title,
        type: document.type,
        s3Key: document.s3Key,
        s3Bucket: document.s3Bucket
      },
      extraction: extractionResult
    });

  } catch (error) {
    console.error("❌ Test document error:", error);
    res.status(500).json({
      success: false,
      message: `Test failed: ${error.message}`,
      error: error.stack
    });
  }
});

// GET /api/ai/status - Check AI service status
router.get("/status", auth, async (req, res) => {
  try {
    // Simple health check
    res.json({
      success: true,
      message: "AI Assistant is available",
      model: "gpt-4o-mini",
      user: (req.doctor?.name || req.user?.name || 'Unknown')
    });
  } catch (error) {
    console.error("AI status check error:", error);
    res.status(500).json({
      success: false,
      message: "AI Assistant status check failed"
    });
  }
});

// Load recent chat (last 24h) for current principal
router.get("/chat", auth, async (req, res) => {
  try {
    const role = normalizeRole(req.auth?.role);
    const queryPatientId = String(req.query.patientId || "").trim();
    if (role === "doctor" && queryPatientId) {
      const allowed = await canDoctorAccessPatient(String(req.auth?.id || ""), queryPatientId);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          code: "NO_ACTIVE_SESSION",
          message: "No active doctor-patient relationship",
        });
      }
    }
    const filter = {
      userId: String(req.auth?.id || req.user?._id?.toString() || ""),
      userRole: resolvePersona(role),
      ...(queryPatientId ? { patientId: queryPatientId } : { patientId: null }),
    };
    const chat = await AIChat.findOne(filter).sort({ updatedAt: -1 }).lean();
    if (!chat) return res.json({ success: true, messages: [], conversationId: null });
    res.json({
      success: true,
      messages: chat.messages || [],
      conversationId: chat._id,
      context: chat.context || null,
    });
  } catch (error) {
    console.error('Chat load error:', error);
    res.status(500).json({ success: false, message: 'Failed to load chat' });
  }
});

// Clear chat for current principal
router.delete("/chat", auth, async (req, res) => {
  try {
    const role = normalizeRole(req.auth?.role);
    const queryPatientId = String(req.query.patientId || "").trim();
    if (role === "doctor" && queryPatientId) {
      const allowed = await canDoctorAccessPatient(String(req.auth?.id || ""), queryPatientId);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          code: "NO_ACTIVE_SESSION",
          message: "No active doctor-patient relationship",
        });
      }
    }
    const filter = {
      userId: String(req.auth?.id || req.user?._id?.toString() || ""),
      userRole: resolvePersona(role),
      ...(queryPatientId ? { patientId: queryPatientId } : { patientId: null }),
    };
    await AIChat.deleteMany(filter);
    res.json({ success: true, message: 'Chat cleared' });
  } catch (error) {
    console.error('Chat clear error:', error);
    res.status(500).json({ success: false, message: 'Failed to clear chat' });
  }
});

// POST /api/ai/appointment-summary - Generate AI summary for a completed appointment
// (Flutter calls this endpoint when user taps "Generate AI Summary" on appointment detail)
router.post("/appointment-summary", auth, async (req, res) => {
  try {
    const { appointmentId } = req.body || {};
    if (!appointmentId) {
      return fail(res, { status: 400, message: "appointmentId is required" });
    }

    const appointment = await Appointment.findById(appointmentId).lean();
    if (!appointment) {
      return fail(res, { status: 404, message: "Appointment not found" });
    }
    if (appointment.status !== "completed") {
      return fail(res, {
        status: 400,
        message: "Only completed appointments can be summarized",
      });
    }

    const patientId = appointment.patientId?.toString();
    const doctorId = appointment.doctorId?.toString();
    const isPatient =
      req.auth?.role !== "doctor" && req.user?._id?.toString() === patientId;
    const isDoctor =
      req.auth?.role === "doctor" && req.doctor?._id?.toString() === doctorId;

    if (!isPatient && !isDoctor) {
      return fail(res, { status: 403, message: "Access denied" });
    }

    const linkedDocs = await Document.find({
      userId: patientId,
      appointmentId: appointment._id,
    }).lean();

    const notesShared = (appointment.doctorNotesShared || "").trim();
    const reason = (appointment.reason || "").trim();

    let docContext = "";
    if (linkedDocs.length > 0) {
      docContext = linkedDocs
        .map(
          (d) =>
            `- ${d.type || d.category}: ${d.title || d.originalName || "Document"}`
        )
        .join("\n");
    }

    const prompt = `You are a medical assistant. Summarize this doctor visit for the patient in simple, non-medical language.

Visit details:
- Reason for visit: ${reason}
- Doctor notes (shared with patient): ${notesShared || "None"}
${docContext ? `- Documents from this visit:\n${docContext}` : ""}

Provide:
1. A 2-3 sentence summary of what happened in this visit.
2. A "What happened" explanation in 3-4 bullet points using very simple language a patient can understand.
3. If relevant, suggest a follow-up timeline in days (e.g., "Consider a follow-up in 7-14 days") or write "No specific follow-up suggested."

Format your response as JSON:
{
  "summary": "2-3 sentence summary",
  "visitExplanation": "Bullet 1\\nBullet 2\\nBullet 3",
  "suggestedFollowUpDays": 7 or null
}`;

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      // Backward-compatible fields used by Flutter when success=true
      return fail(res, {
        status: 503,
        message: "AI service not configured",
        legacy: {
          summary: "No clinical notes recorded for this visit.",
          visitExplanation: "Unable to generate AI summary at this time.",
          suggestedFollowUpDays: null,
        },
      });
    }

    const axios = (await import("axios")).default;
    const completion = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
      },
      { headers: { Authorization: `Bearer ${openaiKey}` } }
    );

    const content = completion.data?.choices?.[0]?.message?.content || "";
    let summary = "";
    let visitExplanation = "";
    let suggestedFollowUpDays = null;
    try {
      const parsed = JSON.parse(
        content.replace(/```json\n?|\n?```/g, "").trim()
      );
      summary = parsed.summary || "";
      visitExplanation = parsed.visitExplanation || "";
      suggestedFollowUpDays = parsed.suggestedFollowUpDays ?? null;
    } catch (_) {
      summary = content.slice(0, 500);
    }

    const { AppointmentAIInsight } = await import(
      "../models/AppointmentAIInsight.js"
    );
    await AppointmentAIInsight.findOneAndUpdate(
      { appointmentId: appointment._id },
      { appointmentId: appointment._id, summary, visitExplanation, suggestedFollowUpDays },
      { upsert: true, new: true }
    );

    return ok(res, {
      message: "Appointment summary generated",
      data: { summary, visitExplanation, suggestedFollowUpDays },
      // Flutter reads these top-level keys directly
      legacy: { summary, visitExplanation, suggestedFollowUpDays },
    });
  } catch (error) {
    console.error("Appointment summary error:", error);
    return fail(res, {
      status: 500,
      message: error.message || "Failed to generate summary",
    });
  }
});

// Additional endpoint: analyze patient's documents and return extracted summaries
// GET /api/ai/patient/:patientId/analyze
router.get('/patient/:patientId/analyze', auth, async (req, res) => {
  try {
    const { patientId } = req.params;
    const role = String(req.auth?.role || "").toLowerCase();
    const requesterId = String(req.auth?.id || "");

    if (!patientId) {
      return res.status(400).json({ success: false, message: 'patientId is required' });
    }

    if (role === "patient" && requesterId !== String(patientId)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }
    if (role === "doctor") {
      const allowed = await canDoctorAccessPatient(requesterId, String(patientId));
      if (!allowed) {
        return res.status(403).json({ success: false, message: "No active doctor-patient relationship" });
      }
    }
    if (!["patient", "doctor", "admin", "superadmin"].includes(role)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    // Fetch recent documents for the patient
    const docs = await Document.find({ userId: String(patientId) }).sort({ uploadedAt: -1 }).limit(10);
    if (!docs || docs.length === 0) {
      return res.json({ success: true, summaries: [], count: 0 });
    }

    const bucketNameFallback = process.env.AWS_S3_BUCKET_NAME;
    const results = [];
    for (const doc of docs) {
      if (!doc.s3Key) continue;
      try {
        const extraction = await documentReader.extractTextFromS3(doc.s3Key, doc.s3Bucket || bucketNameFallback);
        results.push({
          id: doc._id,
          title: doc.title || doc.originalName,
          type: doc.type || doc.category,
          uploadedAt: doc.uploadedAt,
          success: extraction.success,
          textPreview: (extraction.text || '').slice(0, 800),
          metadata: extraction.metadata || {},
          wordCount: extraction.wordCount || 0
        });
      } catch (e) {
        results.push({ id: doc._id, title: doc.title, type: doc.type, uploadedAt: doc.uploadedAt, success: false, error: e.message });
      }
    }

    res.json({ success: true, summaries: results, count: results.length });
  } catch (error) {
    console.error('Patient analyze error:', error);
    res.status(500).json({ success: false, message: 'Failed to analyze patient documents' });
  }
});

export default router;


