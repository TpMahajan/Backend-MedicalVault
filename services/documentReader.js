import fs from 'fs';
import path from 'path';
import { createWorker } from 'tesseract.js';
import axios from 'axios';
import s3Client from '../config/s3.js';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream';
import { promisify } from 'util';

const pipelineAsync = promisify(pipeline);

class DocumentReader {
  constructor() {
    this.supportedTypes = {
      pdf: ['pdf'],
      image: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tiff'],
      text: ['txt', 'md'],
      docx: ['docx', 'doc']
    };
    this.ocrWorkerPromises = new Map();
    this.ocrQueues = new Map();
  }

  /**
   * Extract text from a document stored in S3
   * @param {string} s3Key - The S3 key of the document
   * @param {string} bucketName - The S3 bucket name
   * @returns {Promise<Object>} - Extracted text and metadata
   */
  async extractTextFromS3(s3Key, bucketName, options = {}) {
    let tempFilePath = null;
    
    try {
      console.log(`📥 Downloading file from S3: ${s3Key} from bucket: ${bucketName}`);
      
      // Download file from S3 to temporary location
      tempFilePath = await this.downloadFromS3(s3Key, bucketName);
      console.log(`✅ File downloaded to: ${tempFilePath}`);
      
      // Get file extension
      const fileExtension = path.extname(s3Key).toLowerCase().substring(1);
      console.log(`📄 File extension: ${fileExtension}`);
      
      // Extract text based on file type
      let extractedText = '';
      let metadata = {
        fileType: this.getFileType(fileExtension),
        fileExtension,
        s3Key,
        extractedAt: new Date().toISOString()
      };

      if (this.supportedTypes.pdf.includes(fileExtension)) {
        console.log(`📖 Extracting text from PDF...`);
        try {
          const result = await this.extractFromPDF(tempFilePath, {
            parseParams: options.pdfParseParams,
          });
          extractedText = result.text;
          metadata = { ...metadata, ...result.metadata };
          console.log(`✅ PDF extraction completed. Text length: ${extractedText.length}`);
        } catch (pdfError) {
          console.warn(`⚠️ PDF extraction failed, trying fallback: ${pdfError.message}`);
          // Fallback: return basic metadata without text extraction
          extractedText = `[PDF Document - Text extraction failed: ${pdfError.message}]`;
          metadata = { 
            ...metadata, 
            extractionError: pdfError.message,
            fallbackUsed: true
          };
          console.log(`🔄 Using fallback for PDF extraction`);
        }
      } else if (this.supportedTypes.image.includes(fileExtension)) {
        console.log(`🖼️ Extracting text from image using OCR...`);
        const result = await this.extractFromImage(
          tempFilePath,
          options.imageOcrOptions
        );
        extractedText = result.text;
        metadata = { ...metadata, ...result.metadata };
        console.log(`✅ Image OCR completed. Text length: ${extractedText.length}`);
      } else if (this.supportedTypes.text.includes(fileExtension)) {
        console.log(`📝 Extracting text from text file...`);
        const result = await this.extractFromText(tempFilePath);
        extractedText = result.text;
        metadata = { ...metadata, ...result.metadata };
        console.log(`✅ Text extraction completed. Text length: ${extractedText.length}`);
      } else {
        throw new Error(`Unsupported file type: ${fileExtension}. Supported types: ${Object.values(this.supportedTypes).flat().join(', ')}`);
      }

      // Clean up temporary file
      await this.cleanupTempFile(tempFilePath);
      tempFilePath = null;

      return {
        success: true,
        text: extractedText,
        metadata,
        wordCount: extractedText.split(/\s+/).length,
        characterCount: extractedText.length
      };

    } catch (error) {
      console.error('❌ Document extraction error:', error);
      console.error('Error details:', {
        s3Key,
        bucketName,
        tempFilePath,
        errorMessage: error.message,
        errorStack: error.stack
      });
      
      // Clean up temporary file if it exists
      if (tempFilePath) {
        await this.cleanupTempFile(tempFilePath);
      }
      
      return {
        success: false,
        error: error.message,
        text: '',
        metadata: {}
      };
    }
  }

  /**
   * Download file from S3 to temporary location
   */
  async downloadFromS3(s3Key, bucketName) {
    const tempDir = path.join(process.cwd(), 'temp');
    
    try {
      console.log(`📁 Creating temp directory: ${tempDir}`);
      
      // Ensure temp directory exists
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
        console.log(`✅ Temp directory created: ${tempDir}`);
      }

      const tempFilePath = path.join(tempDir, `temp_${Date.now()}_${path.basename(s3Key)}`);
      console.log(`📄 Temp file path: ${tempFilePath}`);
      
      const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: s3Key
      });

      console.log(`🔍 Sending S3 GetObject command for: ${s3Key}`);
      const response = await s3Client.send(command);
      
      if (!response.Body) {
        throw new Error('S3 response body is null');
      }

      console.log(`📥 Starting file download...`);
      const writeStream = createWriteStream(tempFilePath);
      
      await pipelineAsync(response.Body, writeStream);
      console.log(`✅ File download completed: ${tempFilePath}`);
      
      // Verify file was created and has content
      const stats = fs.statSync(tempFilePath);
      console.log(`📊 File stats: size=${stats.size} bytes`);
      
      if (stats.size === 0) {
        throw new Error('Downloaded file is empty');
      }
      
      return tempFilePath;
    } catch (error) {
      console.error(`❌ S3 download error:`, error);
      console.error(`S3 download details:`, {
        s3Key,
        bucketName,
        tempDir,
        errorMessage: error.message,
        errorCode: error.$metadata?.httpStatusCode,
        errorName: error.name
      });
      throw error;
    }
  }

  /**
   * Extract text from PDF file
   */
  async extractFromPDF(filePath, options = {}) {
    try {
      console.log(`📖 Starting PDF extraction for: ${filePath}`);
      
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        throw new Error(`PDF file not found: ${filePath}`);
      }
      
      // Check file size
      const stats = fs.statSync(filePath);
      console.log(`📊 PDF file size: ${stats.size} bytes`);
      
      if (stats.size === 0) {
        throw new Error('PDF file is empty');
      }
      
      // Dynamic import to handle ES module compatibility
      console.log(`📦 Importing pdf-parse module...`);
      const pdfParseModule = await import('pdf-parse');
      console.log(`📦 PDF parse module loaded. Available exports:`, Object.keys(pdfParseModule));
      
      console.log(`📄 Reading PDF file...`);
      const dataBuffer = fs.readFileSync(filePath);
      console.log(`📄 PDF buffer size: ${dataBuffer.length} bytes`);
      
      console.log(`🔍 Parsing PDF content...`);
      // Handle different export formats - pdf-parse exports PDFParse as a class
      const PDFParse = pdfParseModule.default || pdfParseModule.PDFParse || pdfParseModule;
      console.log(`🔍 PDFParse type: ${typeof PDFParse}`);
      
      if (typeof PDFParse !== 'function') {
        console.error('PDF parse module structure:', Object.keys(pdfParseModule));
        throw new Error(`PDF parse constructor not found in module. Available exports: ${Object.keys(pdfParseModule).join(', ')}`);
      }
      
      console.log(`🔍 Creating PDFParse instance and parsing...`);
      // PDFParse is a class, so we need to instantiate it with data
      const pdfParser = new PDFParse({ data: dataBuffer });
      
      // Extract text from the document
      const parseParams =
        options.parseParams && typeof options.parseParams === 'object'
          ? options.parseParams
          : {};
      const result = await pdfParser.getText(parseParams);
      
      // Clean up the parser
      await pdfParser.destroy();
      
      console.log(`🔍 PDF parsing completed successfully`);
      
      // Format the text for better readability
      const formattedText = this.formatPDFText(result);
      
      console.log(`✅ PDF parsing completed:`, {
        pages: result.pages?.length || 0,
        textLength: formattedText.length,
        hasInfo: !!result.info
      });
      
      return {
        text: formattedText,
        metadata: {
          pages: result.pages?.length || 0,
          info: result.info,
          version: result.version,
          originalText: result.text || '',
          parseParams
        }
      };
    } catch (error) {
      console.error(`❌ PDF extraction error:`, error);
      console.error(`PDF extraction details:`, {
        filePath,
        errorMessage: error.message,
        errorStack: error.stack
      });
      throw new Error(`PDF extraction failed: ${error.message}`);
    }
  }

  /**
   * Extract text from image file using OCR
   */
  async _getOcrWorker(languages) {
    const normalizedLanguages = String(languages || 'eng+hin').trim() || 'eng+hin';
    if (!this.ocrWorkerPromises.has(normalizedLanguages)) {
      this.ocrWorkerPromises.set(
        normalizedLanguages,
        createWorker(normalizedLanguages)
      );
    }
    return this.ocrWorkerPromises.get(normalizedLanguages);
  }

  async _resetOcrWorker(languages) {
    const normalizedLanguages = String(languages || 'eng+hin').trim() || 'eng+hin';
    const workerPromise = this.ocrWorkerPromises.get(normalizedLanguages);
    this.ocrWorkerPromises.delete(normalizedLanguages);
    if (!workerPromise) return;

    try {
      const worker = await workerPromise;
      await worker.terminate();
    } catch (error) {
      console.warn('Failed to reset OCR worker:', error.message);
    }
  }

  async _withOcrWorker(languages, task) {
    const normalizedLanguages = String(languages || 'eng+hin').trim() || 'eng+hin';
    const previous = this.ocrQueues.get(normalizedLanguages) || Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(async () => task(await this._getOcrWorker(normalizedLanguages)));

    this.ocrQueues.set(normalizedLanguages, run.catch(() => {}));
    return run;
  }

  async extractFromImage(filePath, options = {}) {
    const languages = String(options?.languages || 'eng+hin').trim() || 'eng+hin';
    try {
      const { data: { text } } = await this._withOcrWorker(
        languages,
        (worker) => worker.recognize(filePath, options?.recognizeOptions || {})
      );

      return {
        text: text.trim(),
        metadata: {
          ocrEngine: 'Tesseract.js',
          languages: languages.split('+').map((language) => language.trim()),
          reusedWorker: true
        }
      };
    } catch (error) {
      await this._resetOcrWorker(languages);
      throw new Error(`Image OCR failed: ${error.message}`);
    }
  }

  /**
   * Extract text from text file
   */
  async extractFromText(filePath) {
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      
      return {
        text,
        metadata: {
          encoding: 'utf8'
        }
      };
    } catch (error) {
      throw new Error(`Text extraction failed: ${error.message}`);
    }
  }

  /**
   * Get file type category
   */
  getFileType(extension) {
    for (const [type, extensions] of Object.entries(this.supportedTypes)) {
      if (extensions.includes(extension)) {
        return type;
      }
    }
    return 'unknown';
  }

  /**
   * Clean up temporary file
   */
  async cleanupTempFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.warn('Failed to cleanup temp file:', error.message);
    }
  }

  /**
   * Detect language of extracted text
   */
  detectLanguage(text) {
    // Simple language detection based on character patterns
    const hindiPattern = /[\u0900-\u097F]/g;
    const marathiPattern = /[\u0900-\u097F]/g; // Marathi uses Devanagari script
    const englishPattern = /[a-zA-Z]/g;

    const hindiMatches = (text.match(hindiPattern) || []).length;
    const englishMatches = (text.match(englishPattern) || []).length;

    if (hindiMatches > englishMatches * 2) {
      return 'hindi';
    } else if (englishMatches > hindiMatches) {
      return 'english';
    } else {
      return 'hinglish'; // Mixed language
    }
  }

  /**
   * Validate if file type is supported
   */
  isSupported(fileExtension) {
    const extension = fileExtension.toLowerCase();
    return Object.values(this.supportedTypes).flat().includes(extension);
  }

  /**
   * Format PDF text for better readability
   */
  formatPDFText(result) {
    if (!result || !result.pages || result.pages.length === 0) {
      return result?.text || 'No text content found in PDF.';
    }

    let formattedText = '';
    
    // Process each page
    result.pages.forEach((page, index) => {
      if (page.text && page.text.trim()) {
        // Add page header
        formattedText += `\n📄 **Page ${page.num || (index + 1)}**\n`;
        formattedText += '─'.repeat(30) + '\n\n';
        
        // Format the page content
        const pageContent = this.formatPageContent(page.text);
        formattedText += pageContent;
        
        // Add spacing between pages
        if (index < result.pages.length - 1) {
          formattedText += '\n\n';
        }
      }
    });

    // If no pages were processed, fall back to original text
    if (!formattedText.trim()) {
      formattedText = result.text || 'No readable content found in PDF.';
    }

    return formattedText.trim();
  }

  /**
   * Format individual page content with bullet points and structure
   */
  formatPageContent(text) {
    if (!text || !text.trim()) {
      return '';
    }

    let formatted = text.trim();
    
    // Split into lines and process each line
    let lines = formatted.split('\n').map(line => line.trim()).filter(line => line);
    
    // Process each line for better formatting
    lines = lines.map(line => {
      // Skip page separators and headers
      if (line.match(/^[-─=]+$/) || line.match(/^-- \d+ of \d+ --$/)) {
        return '';
      }
      
      // Format numbered lists
      if (line.match(/^\d+\.\s+/)) {
        return line.replace(/^(\d+\.)\s+/, '• ');
      }
      
      // Format bullet points
      if (line.match(/^[-*•]\s+/)) {
        return line.replace(/^[-*•]\s+/, '• ');
      }
      
      // Format section headers (lines ending with colon or in caps)
      if (line.match(/[A-Z\s]{5,}$/) || line.match(/:$/)) {
        return `\n**${line}**\n`;
      }
      
      // Format URLs
      line = line.replace(/(https?:\/\/[^\s]+)/g, '[Link]($1)');
      
      // Format email addresses
      line = line.replace(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, '[$1](mailto:$1)');
      
      return line;
    });
    
    // Join lines and clean up
    formatted = lines.filter(line => line.trim()).join('\n');
    
    // Clean up extra whitespace
    formatted = formatted
      .replace(/\n\s*\n\s*\n/g, '\n\n') // Remove multiple empty lines
      .replace(/^\s+|\s+$/gm, '') // Trim each line
      .split('\n')
      .filter(line => line.trim()) // Remove empty lines
      .join('\n');

    return formatted;
  }

  /**
   * Add document structure based on content patterns
   */
  addDocumentStructure(text) {
    let structured = text;

    // Add medical section headers at the beginning of relevant sections
    const sectionMappings = [
      { 
        keywords: ['patient information', 'patient info', 'patient name', 'name:', 'age:', 'gender:'],
        header: '👤 **Patient Information:**\n'
      },
      { 
        keywords: ['symptoms:', 'complaint:', 'chief complaint'],
        header: '🤒 **Symptoms:**\n'
      },
      { 
        keywords: ['diagnosis:', 'dx:', 'condition:', 'disease:'],
        header: '🏥 **Diagnosis:**\n'
      },
      { 
        keywords: ['medications:', 'prescription:', 'drug:', 'medicine:', 'tablet:', 'capsule:'],
        header: '💊 **Medications:**\n'
      },
      { 
        keywords: ['test results:', 'lab results:', 'blood test:', 'urine test:', 'x-ray:', 'scan:'],
        header: '🧪 **Test Results:**\n'
      },
      { 
        keywords: ['treatment:', 'therapy:', 'procedure:', 'surgery:', 'operation:'],
        header: '⚕️ **Treatment:**\n'
      },
      { 
        keywords: ['follow-up:', 'follow up:', 'next visit:', 'appointment:', 'review:'],
        header: '📅 **Follow-up:**\n'
      }
    ];

    // Apply section headers
    sectionMappings.forEach(section => {
      section.keywords.forEach(keyword => {
        if (structured.toLowerCase().includes(keyword.toLowerCase())) {
          // Replace the keyword with the formatted header
          const regex = new RegExp(`(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
          if (!structured.includes(section.header)) {
            structured = structured.replace(regex, section.header + '$1');
          }
        }
      });
    });

    return structured;
  }
}

export default DocumentReader;
