import express from "express";
import axios from "axios";
import { auth } from "../middleware/auth.js";
import { User } from "../models/User.js";
import { DoctorUser } from "../models/DoctorUser.js";
import { Document } from "../models/File.js";
import { Appointment } from "../models/Appointment.js";
import { AIChat } from "../models/AIChat.js";
import DocumentReader from "../services/documentReader.js";

const router = express.Router();
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

// Helper function to generate system prompt with user context
const generateSystemPrompt = (user, documents, isDocumentQuery = false, language = 'english', documentContent = null, wantsStructured = false, userRole = 'doctor', patientId = null, conversationContext = null) => {
  const userName = user.name || "User";
  const userRoleContext = userRole === 'doctor' ? 'medical professional' : 'patient';
  
  const basePrompt = `You are an advanced, trustworthy, and context-aware Medical AI Assistant integrated inside a secure Medical Vault platform.

Your behavior must feel like a human expert assistant:
- You answer ONLY what the user asks
- You scan and use ONLY relevant data
- You never hallucinate or assume missing data
- You adapt depth automatically based on question complexity

-----------------------------------
CORE IDENTITY
-----------------------------------
You are NOT a generic chatbot.
You are a medical-grade AI assistant designed for:
- Doctors (clinical, operational, analytical)
- Patients (supportive, explanatory, reassuring)

You always behave responsibly and accurately.

-----------------------------------
PRIMARY RULES (MOST IMPORTANT)
-----------------------------------

1. Question-Driven Answering
- Answer exactly what is asked.
- Do NOT over-explain if not required.
- If the user asks for a list → return a list.
- If the user asks for analysis → analyze.
- If the user asks for summary → summarize.

2. Context Scanning Rule
Before answering, ALWAYS internally check:
- User role (doctor or patient)
- Related documents
- Related patient records
- Related appointments or schedules
- Conversation context

Use ONLY the data that matches the question.

3. No Data = No Guessing
If required data is missing:
- Clearly say what is missing
- Suggest the next best action
Example:
"I cannot find a blood report for this patient. Please upload it or specify the document."

-----------------------------------
ROLE-BASED INTELLIGENCE
-----------------------------------

${userRole === 'doctor' ? `
CURRENT USER: DOCTOR (${userName})

IF userRole == DOCTOR:
- Use professional, clinical language
- Be precise and actionable
- You MAY:
  - Analyze medical reports
  - Summarize patient history
  - Compare lab values
  - Highlight abnormalities
  - Assist in treatment planning (non-decisive)
- Never claim to replace medical judgment
` : `
CURRENT USER: PATIENT (${userName})

IF userRole == PATIENT:
- Use simple, calm, human language
- Avoid medical jargon unless explained
- You MAY:
  - Explain reports in simple terms
  - Answer health-related questions
  - Summarize doctor notes
- NEVER give diagnosis or prescriptions
- Always recommend consulting a doctor when needed
`}

-----------------------------------
DOCUMENT & DATA AWARENESS
-----------------------------------

When a question relates to documents:
- Identify relevant document(s)
- Extract only relevant sections
- Ignore unrelated files
- If multiple documents exist, ask for clarification ONLY if required

Examples:
- "Analyze my blood report" → scan lab reports only
- "Show my prescriptions" → list prescription documents
- "Compare last 2 reports" → fetch latest two matching docs

-----------------------------------
INTENT-BASED RESPONSE DEPTH
-----------------------------------

AUTO-ADJUST RESPONSE SIZE:

- YES / NO question → Short answer
- List request → Bulleted list
- Comparison request → Table format
- Trend / stats request → Structured data (table or chart)
- Medical explanation → Step-by-step, simple

-----------------------------------
FORMATTING RULES (STRICT)
-----------------------------------

- Plain text only
- No markdown
- No headings with symbols
- No asterisks, hash symbols, or backticks
- Use hyphen for bullets
- Tables only if explicitly or logically required
- Clean spacing and readability

-----------------------------------
LANGUAGE HANDLING
-----------------------------------

- Auto-detected language: ${language}
- Respond in the SAME language as user
- If Hinglish → keep it natural and friendly

-----------------------------------
SAFETY & MEDICAL RESPONSIBILITY
-----------------------------------

- Never give final diagnosis
- Never prescribe medicines
- Never override doctor authority
- For critical symptoms, always advise:
  "Please consult your doctor immediately."

-----------------------------------
CURRENT SESSION CONTEXT
-----------------------------------

User Information:
- Name: ${userName}
- Role: ${userRoleContext}
- User ID: ${user._id}
${patientId ? `- Current Patient ID: ${patientId}` : ''}
- Response Language: ${language}

${conversationContext ? `
Conversation History:
- Session started: ${conversationContext.sessionStart ? new Date(conversationContext.sessionStart).toLocaleString() : 'Unknown'}
- Previous topics: ${conversationContext.topics ? conversationContext.topics.join(', ') : 'None'}
- Last interaction: ${conversationContext.lastInteraction ? new Date(conversationContext.lastInteraction).toLocaleString() : 'Now'}
- User preferences: ${conversationContext.preferences ? JSON.stringify(conversationContext.preferences) : 'None'}
` : ''}

-----------------------------------
EXAMPLES OF IDEAL BEHAVIOR
-----------------------------------

${userRole === 'doctor' ? `
Doctor asks: "Summarize this patient's last visit"
→ Fetch last appointment + notes
→ Return concise clinical summary

Doctor asks: "Show today's appointments"
→ Return today's schedule only
→ Sorted by time
` : `
Patient asks: "Is my blood sugar normal?"
→ Check lab values
→ Explain simply
→ Suggest doctor consultation if borderline
`}

-----------------------------------
FINAL BEHAVIOR GOAL
-----------------------------------

You should feel like:
- A senior medical assistant
- Calm, intelligent, and reliable
- Focused on accuracy over verbosity
- Aware of system data, not imagination

Always prioritize:
Accuracy > Relevance > Clarity > Safety`;

  if (isDocumentQuery && documents && documents.length > 0) {
    if (documentContent) {
      // Document analysis prompt
      return `${basePrompt}

-----------------------------------
CURRENT TASK: DOCUMENT ANALYSIS
-----------------------------------

DOCUMENT CONTENT PROVIDED:
${documentContent}

CRITICAL INSTRUCTIONS:
1. Answer ONLY what the user asked about this document
2. Extract ONLY relevant information from the document content above
3. Identify the document type (medical report, prescription, bill, insurance, etc.)
4. If user asked for analysis → provide thorough analysis
5. If user asked for summary → provide concise summary
6. If user asked for specific values → extract and present those values
7. If user asked for comparison → you need multiple documents (check if available)

${wantsStructured ? '8. If user requested structured data (table/chart), provide it in JSON format' : ''}

RESPONSE REQUIREMENTS:
- Respond in ${language}
- Use ONLY information present in the document
- If information is missing, clearly state what is missing
- Do NOT invent or assume any values
- Format: Plain text with hyphen bullets (no markdown)

Remember: You are analyzing a real medical document. Accuracy is critical.`;
    } else {
      // Document listing prompt
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
          documentList += `- ${doc.title || doc.originalName} (${doc.date || doc.uploadedAt})\n`;
        });
      });
      
      return `${basePrompt}

-----------------------------------
CURRENT TASK: DOCUMENT LISTING
-----------------------------------

DOCUMENTS AVAILABLE:${documentList}

RESPONSE REQUIREMENTS:
- List documents clearly and concisely
- Use plain text with hyphen bullets (no markdown)
- Mention document count per category
- If user asked for specific type → filter and show only that type
- If user asked for date range → show only documents in that range
- Keep response focused and scannable

Do NOT analyze document content - just list what's available as requested.`;
    }
  }
  
  return `${basePrompt}

-----------------------------------
CURRENT TASK: GENERAL ASSISTANCE
-----------------------------------

You can help with:
- Medical document queries
- Health information and explanations
- General medical guidance (non-diagnostic)
- Document analysis and insights
- Appointment and schedule information
- Patient record summaries

RESPONSE GUIDELINES:
- Answer exactly what is asked
- Use available context (documents, appointments, records)
- If data is missing, clearly state what is needed
- Adapt response depth to question complexity
- Keep responses concise and relevant
- Respond in ${language}

Remember: You are a medical assistant, not a replacement for professional medical judgment.`;
};

// POST /api/ai/ask - Main AI Assistant endpoint
router.post("/ask", auth, async (req, res) => {
  try {
    const { prompt, documentId, userRole = 'doctor', patientId, conversationContext, conversationId } = req.body;
    
    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid prompt"
      });
    }

    // Resolve authenticated principal and role
    const role = req.auth?.role;
    let currentUser = null; // entity used for prompt context (doctor or patient)
    if (role === 'doctor') {
      const doctor = await DoctorUser.findById(req.auth.id).select("-password");
      if (!doctor) {
        return res.status(404).json({ success: false, message: "Doctor not found" });
      }
      // Normalize to a minimal shape expected by prompt generator
      currentUser = { _id: doctor._id, name: doctor.name };
    } else {
      const patient = await User.findById(req.user?._id).select("-password");
      if (!patient) {
        return res.status(404).json({ success: false, message: "User not found" });
      }
      currentUser = patient;
    }

    // Detect language and other parameters
    const language = detectLanguage(prompt);
    const wantsStructured = wantsStructuredData(prompt);
    const isDocumentRequest = isDocumentQuery(prompt);
    const isScheduleRequest = isScheduleQuery(prompt);
    const isUrgent = isUrgentQuery(prompt);
    const isPatientsList = isPatientsQuery(prompt);
    
    let documents = [];
    let documentData = [];
    let documentContent = null;
    let documentMetadata = null;
    // Determine which userId to fetch documents for
    const targetUserId = (req.auth?.role === 'doctor')
      ? (patientId || null)
      : (currentUser?._id?.toString() || null);

    // If specific document ID is provided, analyze that document
    // Try to infer document by explicit id or fuzzy title
    let requestedDocumentId = documentId || extractDocumentIdFromPrompt(prompt);
    let requestedTitle = !requestedDocumentId ? extractDocumentTitleFromPrompt(prompt) : null;

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

        // Access control: patients can access their own docs; doctors need patientId and must match
        if (req.auth?.role === 'doctor') {
          if (!patientId) {
            return res.status(403).json({ success: false, message: "Patient ID required for document analysis" });
          }
          if (document.userId !== String(patientId)) {
            console.log(`❌ Access denied for doctor ${req.auth.id} to document ${requestedDocumentId} for patient ${patientId}`);
            return res.status(403).json({ success: false, message: "Access denied to this document" });
          }
        } else {
          if (document.userId !== currentUser._id.toString()) {
            console.log(`❌ Access denied for user: ${currentUser._id} to document: ${requestedDocumentId}`);
            return res.status(403).json({ success: false, message: "Access denied to this document" });
          }
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
          documentMetadata = {
            ...extractionResult.metadata,
            fileName: document.title || document.originalName,
            documentType: document.type,
            uploadedAt: document.uploadedAt
          };
          
          // Add to documents array for context
          documents = [document];
          documentData = generatePreviewUrls(formatDocumentsForAI([document], document.type));
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
      const targetUserIdForTitle = (req.auth?.role === 'doctor') ? patientId : currentUser._id.toString();
      if (!targetUserIdForTitle) {
        console.log('No target user for title-based document search');
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
              documentMetadata = { ...extractionResult.metadata, fileName: doc.title || doc.originalName, documentType: doc.type, uploadedAt: doc.uploadedAt };
              documents = [doc];
              documentData = generatePreviewUrls(formatDocumentsForAI([doc], doc.type));
            } else {
              return res.status(500).json({ success: false, message: `Failed to extract text from document: ${extractionResult.error}` });
            }
          } catch (e) {
            return res.status(500).json({ success: false, message: `Failed to analyze document: ${e.message}` });
          }
        } else {
          console.log('No fuzzy match found for title:', requestedTitle);
        }
      }
    } else if (isDocumentRequest) {
      // Fetch relevant documents based on query
      const lowerPrompt = prompt.toLowerCase();
      const dateRange = parseDateRangeFromPrompt(lowerPrompt);
      // If doctor without patient context, skip fetching documents (no target)
      if (!targetUserId) {
        console.log("ℹ️ Document query received but no target patientId for doctor. Skipping document fetch.");
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
    if (isScheduleRequest && req.auth?.role === 'doctor') {
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
    if (isPatientsList && req.auth?.role === 'doctor') {
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
      : (isScheduleRequest && req.auth?.role === 'doctor' ? '\n\nToday: No appointments found.' : '');

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
      userRole,
      patientId,
      conversationContext
    ) + appointmentContext + patientsContext;

    // Prepare messages for OpenAI API
    const messages = [
      {
        role: "system",
        content: systemPrompt
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

    // Sanitize reply to plain text bullets
    const rawReply = openaiResponse.data.choices[0].message.content || '';
    let aiReply = rawReply
      .replace(/[\*#`]+/g, '')            // remove markdown symbols
      .replace(/^[\s\-\d\.]+\s*/gm, (m) => m.startsWith('-') ? m : `- `) // normalize leading markers to hyphen
      .replace(/[\u2022\u25CF\u25A0]/g, '-') // convert bullet chars to hyphen
      .replace(/[\t]+/g, ' ')             // tabs to spaces
      .trim();

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

    // Persist chat with 24h TTL
    let savedConversationId = conversationId;
    try {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const chatFilter = {
        userId: req.auth.role === 'doctor' ? req.auth.id : currentUser._id.toString(),
        userRole: req.auth.role === 'doctor' ? 'doctor' : 'patient',
        ...(patientId ? { patientId: String(patientId) } : { patientId: null })
      };
      let chatDoc = null;
      if (conversationId) {
        chatDoc = await AIChat.findById(conversationId);
      }
      if (!chatDoc) {
        chatDoc = await AIChat.findOne(chatFilter).sort({ updatedAt: -1 });
      }
      if (!chatDoc) {
        chatDoc = new AIChat({ ...chatFilter, messages: [], expiresAt });
      }
      chatDoc.messages.push(
        { role: 'user', content: prompt, timestamp: new Date() },
        { role: 'assistant', content: aiReply, timestamp: new Date(), metadata: { language, responseType } }
      );
      chatDoc.lastActivityAt = new Date();
      chatDoc.expiresAt = expiresAt;
      await chatDoc.save();
      savedConversationId = chatDoc._id.toString();
    } catch (persistErr) {
      console.warn('⚠️ Failed to persist AI chat:', persistErr.message);
    }

    // Prepare response with enhanced context
    const response = {
      success: true,
      user: currentUser.name,
      assistant: "AI Ally Assistant",
      reply: aiReply,
      language,
      responseType,
      structuredData,
      documentMetadata,
      data: documentData.length > 0 ? documentData : (appointmentData.length > 0 ? appointmentData : (patientsData.length > 0 ? patientsData : null)),
      model: (openaiResponse?.data?.model || 'gpt-4o-mini'),
      context: {
        userRole,
        patientId,
        sessionId: Date.now(),
        timestamp: new Date().toISOString(),
        conversationId: savedConversationId
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
    const filter = {
      userId: req.auth.role === 'doctor' ? req.auth.id : (req.user?._id?.toString() || ''),
      userRole: req.auth.role === 'doctor' ? 'doctor' : 'patient',
      ...(req.query.patientId ? { patientId: String(req.query.patientId) } : { patientId: null })
    };
    const chat = await AIChat.findOne(filter).sort({ updatedAt: -1 }).lean();
    if (!chat) return res.json({ success: true, messages: [], conversationId: null });
    res.json({ success: true, messages: chat.messages || [], conversationId: chat._id });
  } catch (error) {
    console.error('Chat load error:', error);
    res.status(500).json({ success: false, message: 'Failed to load chat' });
  }
});

// Clear chat for current principal
router.delete("/chat", auth, async (req, res) => {
  try {
    const filter = {
      userId: req.auth.role === 'doctor' ? req.auth.id : (req.user?._id?.toString() || ''),
      userRole: req.auth.role === 'doctor' ? 'doctor' : 'patient',
      ...(req.query.patientId ? { patientId: String(req.query.patientId) } : { patientId: null })
    };
    await AIChat.deleteMany(filter);
    res.json({ success: true, message: 'Chat cleared' });
  } catch (error) {
    console.error('Chat clear error:', error);
    res.status(500).json({ success: false, message: 'Failed to clear chat' });
  }
});

export default router;

// Additional endpoint: analyze patient's documents and return extracted summaries
// GET /api/ai/patient/:patientId/analyze
router.get('/patient/:patientId/analyze', auth, async (req, res) => {
  try {
    const { patientId } = req.params;
    // Doctor must specify a patient they have context for
    if (req.auth?.role === 'doctor' && !patientId) {
      return res.status(400).json({ success: false, message: 'patientId is required' });
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
