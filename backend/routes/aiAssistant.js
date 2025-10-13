import express from "express";
import axios from "axios";
import { auth } from "../middleware/auth.js";
import { User } from "../models/User.js";
import { Document } from "../models/File.js";

const router = express.Router();

// Helper function to detect document-related queries
const isDocumentQuery = (prompt) => {
  const documentKeywords = ["report", "reports", "prescription", "prescriptions", "bill", "bills", "insurance", "document", "documents", "upload", "uploaded"];
  const lowerPrompt = prompt.toLowerCase();
  return documentKeywords.some(keyword => lowerPrompt.includes(keyword));
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
const generateSystemPrompt = (user, documents, isDocumentQuery = false) => {
  const userName = user.name || "User";
  
  if (isDocumentQuery && documents && documents.length > 0) {
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
    
    return `You are AI Ally Assistant. User: ${userName}.

TASK: List user's medical documents clearly and concisely.

DOCUMENTS AVAILABLE:${documentList}

RESPONSE FORMAT:
- Start with "Hello ${userName}!"
- List documents by category with clear numbering
- Mention document count per category
- Keep response under 200 words
- Be friendly and helpful

Do NOT analyze document content - just list what's available.`;
  }
  
  return `You are AI Ally Assistant. User: ${userName}.

Provide brief, helpful responses about:
- Medical document queries
- Health information
- General medical guidance

Keep responses concise (under 150 words). Be friendly and professional.`;
};

// POST /api/ai/ask - Main AI Assistant endpoint
router.post("/ask", auth, async (req, res) => {
  try {
    const { prompt } = req.body;
    
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

    // Check if this is a document-related query
    const isDocumentRequest = isDocumentQuery(prompt);
    let documents = [];
    let documentData = [];

    if (isDocumentRequest) {
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
    const systemPrompt = generateSystemPrompt(user, documents, isDocumentRequest);

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
        max_tokens: isDocumentRequest ? 300 : 500, // Shorter responses for document queries
        temperature: 0.3, // Lower temperature for more focused responses
        top_p: 0.8,
        stream: false // Ensure no streaming for faster response
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.TOGETHER_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 15000 // Reduced timeout to 15 seconds for faster failure handling
      }
    );

    const aiReply = togetherResponse.data.choices[0].message.content;

    // Prepare response
    const response = {
      success: true,
      user: user.name,
      assistant: "AI Ally Assistant",
      reply: aiReply,
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
