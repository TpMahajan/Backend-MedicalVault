import express from "express";
import axios from "axios";
import { auth } from "../middleware/auth.js";
import { User } from "../models/User.js";
import { DoctorUser } from "../models/DoctorUser.js";
import { Document } from "../models/File.js";
import { Appointment } from "../models/Appointment.js";
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

// Helper: detect schedule/appointment related queries
const isScheduleQuery = (prompt) => {
  const keywords = [
    'schedule', 'appointment', 'appointments', 'today', 'urgent', 'emergency',
    'cases', 'my patients today', 'what do i have', 'agenda'
  ];
  const lower = (prompt || '').toLowerCase();
  return keywords.some(k => lower.includes(k));
};

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
  
  const basePrompt = `You are an intelligent multilingual AI Assistant integrated into a medical vault mobile app. 
You can understand and respond fluently in English, Hindi, Marathi, and Hinglish.
You can read, analyze, and summarize documents (PDFs, images, text files).
When asked for data insights, you can output structured data as JSON for tables or datasets for charts.
Your responses must be accurate, concise, and contextually relevant.
Do not hallucinate — only answer from provided document content.

User Context:
- Name: ${userName}
- Role: ${userRoleContext}
- User ID: ${user._id}
- Response Language: ${language}
${patientId ? `- Current Patient ID: ${patientId}` : ''}

Role-Specific Capabilities:
${userRole === 'doctor' ? `
As a Doctor's AI Assistant, you can:
- Analyze patient medical records and reports
- Provide clinical insights and recommendations
- Help with diagnosis support and treatment planning
- Generate patient summaries and health reports
- Assist with appointment management and patient care
- Provide medical terminology explanations
- Help with documentation and record keeping
` : `
As a Patient's AI Assistant, you can:
- Explain medical reports in simple terms
- Provide health information and education
- Help understand medications and treatments
- Assist with appointment scheduling and reminders
- Provide general health tips and wellness advice
- Help organize personal health records
- Answer questions about medical procedures
`}

Remember: Always maintain medical accuracy and suggest consulting healthcare professionals for serious medical decisions.

${conversationContext ? `
Conversation Context:
- Session started: ${conversationContext.sessionStart ? new Date(conversationContext.sessionStart).toLocaleString() : 'Unknown'}
- Previous topics: ${conversationContext.topics ? conversationContext.topics.join(', ') : 'None'}
- Last interaction: ${conversationContext.lastInteraction ? new Date(conversationContext.lastInteraction).toLocaleString() : 'Now'}
- User preferences: ${conversationContext.preferences ? JSON.stringify(conversationContext.preferences) : 'None'}
` : ''}`;

  if (isDocumentQuery && documents && documents.length > 0) {
    if (documentContent) {
      // Document analysis prompt
      return `${basePrompt}

TASK: Analyze the provided document content and respond to the user's query.

DOCUMENT CONTENT:
${documentContent}

INSTRUCTIONS:
- Analyze the document thoroughly
- Identify the document type (medical report, prescription, bill, etc.)
- Extract key information and insights
- Provide a clear summary
${wantsStructured ? '- If requested, provide structured data in JSON format for tables/charts' : ''}
- Respond in ${language}
- Be accurate and helpful

Do NOT make up information not present in the document.`;
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
          documentList += `• ${doc.title || doc.originalName} (${doc.date || doc.uploadedAt})\n`;
        });
      });
      
      return `${basePrompt}

TASK: List user's medical documents clearly and concisely.

DOCUMENTS AVAILABLE:${documentList}

RESPONSE FORMAT:
- Start with "Hello ${userName}!" in ${language}
- List documents by category with clear numbering
- Mention document count per category
- Keep response under 200 words
- Be friendly and helpful

Do NOT analyze document content - just list what's available.`;
    }
  }
  
  return `${basePrompt}

Provide brief, helpful responses about:
- Medical document queries
- Health information
- General medical guidance
- Document analysis and insights

Keep responses concise (under 150 words). Be friendly and professional.`;
};

// POST /api/ai/ask - Main AI Assistant endpoint
router.post("/ask", auth, async (req, res) => {
  try {
    const { prompt, documentId, userRole = 'doctor', patientId, conversationContext } = req.body;
    
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
    if (documentId) {
      try {
        console.log(`📄 Analyzing document ID: ${documentId}`);
        
        const document = await Document.findById(documentId);
        if (!document) {
          console.log(`❌ Document not found: ${documentId}`);
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
            console.log(`❌ Access denied for doctor ${req.auth.id} to document ${documentId} for patient ${patientId}`);
            return res.status(403).json({ success: false, message: "Access denied to this document" });
          }
        } else {
          if (document.userId !== currentUser._id.toString()) {
            console.log(`❌ Access denied for user: ${currentUser._id} to document: ${documentId}`);
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
    } else if (isDocumentRequest) {
      // Fetch relevant documents based on query
      const lowerPrompt = prompt.toLowerCase();
      // If doctor without patient context, skip fetching documents (no target)
      if (!targetUserId) {
        console.log("ℹ️ Document query received but no target patientId for doctor. Skipping document fetch.");
      } else {
      
      if (lowerPrompt.includes("report") || lowerPrompt.includes("this month") || lowerPrompt.includes("recent")) {
        const { startOfMonth, endOfMonth } = getCurrentMonthRange();
        
        if (lowerPrompt.includes("this month")) {
          // Current month reports
          documents = await Document.find({
            userId: targetUserId,
            type: "Report",
            uploadedAt: { $gte: startOfMonth, $lte: endOfMonth }
          }).sort({ uploadedAt: -1 });
        } else {
          // All reports
          documents = await Document.find({
            userId: targetUserId,
            type: "Report"
          }).sort({ uploadedAt: -1 });
        }
      } else if (lowerPrompt.includes("prescription")) {
        documents = await Document.find({
          userId: targetUserId,
          type: "Prescription"
        }).sort({ uploadedAt: -1 });
      } else if (lowerPrompt.includes("bill")) {
        documents = await Document.find({
          userId: targetUserId,
          type: "Bill"
        }).sort({ uploadedAt: -1 });
      } else if (lowerPrompt.includes("insurance")) {
        documents = await Document.find({
          userId: targetUserId,
          type: "Insurance"
        }).sort({ uploadedAt: -1 });
      } else {
        // General document query - get all documents
        documents = await Document.find({
          userId: targetUserId
        }).sort({ uploadedAt: -1 });
      }
      }
      // Format documents for response with preview URLs
      documentData = generatePreviewUrls(formatDocumentsForAI(documents, "general"));
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

    const aiReply = openaiResponse.data.choices[0].message.content;

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
        timestamp: new Date().toISOString()
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

export default router;
