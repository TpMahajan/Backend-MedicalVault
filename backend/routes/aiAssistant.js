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
    status: doc.status
  }));
};

// Helper function to generate system prompt with user context
const generateSystemPrompt = (user, documents) => {
  const userName = user.name || "User";
  const userAge = user.age ? ` (Age: ${user.age})` : "";
  const userGender = user.gender ? `, Gender: ${user.gender}` : "";
  const bloodType = user.bloodType ? `, Blood Type: ${user.bloodType}` : "";
  
  let documentContext = "";
  if (documents && documents.length > 0) {
    const groupedDocs = documents.reduce((acc, doc) => {
      const type = doc.type || doc.category;
      if (!acc[type]) acc[type] = [];
      acc[type].push(doc);
      return acc;
    }, {});
    
    documentContext = "\n\nAvailable Documents:\n";
    Object.entries(groupedDocs).forEach(([type, docs]) => {
      documentContext += `${type}s: ${docs.length} documents\n`;
      docs.slice(0, 3).forEach(doc => {
        documentContext += `- ${doc.title || doc.originalName} (${doc.date || doc.uploadedAt})\n`;
      });
      if (docs.length > 3) {
        documentContext += `... and ${docs.length - 3} more\n`;
      }
    });
  }
  
  return `You are AI Ally Assistant, a helpful medical AI assistant. You are talking to ${userName}${userAge}${userGender}${bloodType}.

Your role is to help with:
1. Medical document queries (reports, prescriptions, bills, insurance)
2. Health information analysis
3. General health advice and guidance
4. Document organization and summaries

Always respond in a friendly, professional manner. When discussing medical documents, be clear and informative.

${documentContext}

Respond concisely but helpfully. If the user asks about specific documents, provide relevant information from the available data.`;
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

      // Format documents for response
      documentData = formatDocumentsForAI(documents, "general");
    }

    // Generate system prompt with user context and documents
    const systemPrompt = generateSystemPrompt(user, documents);

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

    // Call Together AI API
    const togetherResponse = await axios.post(
      "https://api.together.xyz/v1/chat/completions",
      {
        model: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
        messages: messages,
        max_tokens: 1000,
        temperature: 0.7,
        top_p: 0.9
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.TOGETHER_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 30000 // 30 second timeout
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

    // If it's a document query, add structured response
    if (isDocumentRequest && documentData.length > 0) {
      const category = documents[0]?.type || "documents";
      response.type = category.toLowerCase();
      response.title = `${category}s found`;
      response.items = documentData.map(doc => ({
        name: doc.name,
        date: doc.date,
        previewUrl: null // Could be enhanced with actual preview URLs
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
