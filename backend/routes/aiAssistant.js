import express from "express";
import axios from "axios";
import { auth } from "../middleware/auth.js";
import { User } from "../models/User.js";
import { Document } from "../models/File.js";
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

// Helper function to generate system prompt with user context
const generateSystemPrompt = (user, documents, isDocumentQuery = false, language = 'english', documentContent = null, wantsStructured = false) => {
  const userName = user.name || "User";
  
  const basePrompt = `You are an intelligent multilingual AI Assistant integrated into a medical vault mobile app. 
You can understand and respond fluently in English, Hindi, Marathi, and Hinglish.
You can read, analyze, and summarize documents (PDFs, images, text files).
When asked for data insights, you can output structured data as JSON for tables or datasets for charts.
Your responses must be accurate, concise, and contextually relevant.
Do not hallucinate — only answer from provided document content.

User: ${userName}
Response Language: ${language}`;

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
    const { prompt, documentId } = req.body;
    
    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid prompt"
      });
    }

    // Get user details from JWT token
    const user = await User.findById(req.user._id).select("-password");
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Detect language and other parameters
    const language = detectLanguage(prompt);
    const wantsStructured = wantsStructuredData(prompt);
    const isDocumentRequest = isDocumentQuery(prompt);
    
    let documents = [];
    let documentData = [];
    let documentContent = null;
    let documentMetadata = null;

    // If specific document ID is provided, analyze that document
    if (documentId) {
      try {
        const document = await Document.findById(documentId);
        if (!document || document.userId !== user._id.toString()) {
          return res.status(404).json({
            success: false,
            message: "Document not found or access denied"
          });
        }

        // Extract text from the document
        const extractionResult = await documentReader.extractTextFromS3(
          document.s3Key, 
          document.s3Bucket || process.env.AWS_S3_BUCKET_NAME
        );

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
          return res.status(500).json({
            success: false,
            message: `Failed to extract text from document: ${extractionResult.error}`
          });
        }
      } catch (error) {
        console.error("Document analysis error:", error);
        return res.status(500).json({
          success: false,
          message: "Failed to analyze document"
        });
      }
    } else if (isDocumentRequest) {
      // Fetch relevant documents based on query
      const lowerPrompt = prompt.toLowerCase();
      
      if (lowerPrompt.includes("report") || lowerPrompt.includes("this month") || lowerPrompt.includes("recent")) {
        const { startOfMonth, endOfMonth } = getCurrentMonthRange();
        
        if (lowerPrompt.includes("this month")) {
          // Current month reports
          documents = await Document.find({
            userId: user._id.toString(),
            type: "Report",
            uploadedAt: { $gte: startOfMonth, $lte: endOfMonth }
          }).sort({ uploadedAt: -1 });
        } else {
          // All reports
          documents = await Document.find({
            userId: user._id.toString(),
            type: "Report"
          }).sort({ uploadedAt: -1 });
        }
      } else if (lowerPrompt.includes("prescription")) {
        documents = await Document.find({
          userId: user._id.toString(),
          type: "Prescription"
        }).sort({ uploadedAt: -1 });
      } else if (lowerPrompt.includes("bill")) {
        documents = await Document.find({
          userId: user._id.toString(),
          type: "Bill"
        }).sort({ uploadedAt: -1 });
      } else if (lowerPrompt.includes("insurance")) {
        documents = await Document.find({
          userId: user._id.toString(),
          type: "Insurance"
        }).sort({ uploadedAt: -1 });
      } else {
        // General document query - get all documents
        documents = await Document.find({
          userId: user._id.toString()
        }).sort({ uploadedAt: -1 });
      }

      // Format documents for response with preview URLs
      documentData = generatePreviewUrls(formatDocumentsForAI(documents, "general"));
    }

    // Generate system prompt with user context and documents
    const systemPrompt = generateSystemPrompt(
      user, 
      documents, 
      isDocumentRequest, 
      language, 
      documentContent, 
      wantsStructured
    );

    // Prepare messages for Together AI API
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

    // Call Together AI API with optimized settings for speed
    const togetherResponse = await axios.post(
      "https://api.together.xyz/v1/chat/completions",
      {
        model: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
        messages: messages,
        max_tokens: documentContent ? 800 : (isDocumentRequest ? 300 : 500),
        temperature: 0.3,
        top_p: 0.8,
        stream: false
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.TOGETHER_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 30000 // Increased timeout for document analysis
      }
    );

    const aiReply = togetherResponse.data.choices[0].message.content;

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

    // Prepare response
    const response = {
      success: true,
      user: user.name,
      assistant: "AI Ally Assistant",
      reply: aiReply,
      language,
      responseType,
      structuredData,
      documentMetadata,
      data: documentData.length > 0 ? documentData : null
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
        message: "AI service authentication failed. Please check API key."
      });
    }
    
    if (error.code === "ECONNABORTED") {
      return res.status(500).json({
        success: false,
        message: "AI service timeout. Please try again."
      });
    }
    
    if (error.response?.data?.error) {
      return res.status(500).json({
        success: false,
        message: `AI service error: ${error.response.data.error.message}`
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

// GET /api/ai/status - Check AI service status
router.get("/status", auth, async (req, res) => {
  try {
    // Simple health check
    res.json({
      success: true,
      message: "AI Assistant is available",
      model: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
      user: req.user.name
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
