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
  }

  /**
   * Extract text from a document stored in S3
   * @param {string} s3Key - The S3 key of the document
   * @param {string} bucketName - The S3 bucket name
   * @returns {Promise<Object>} - Extracted text and metadata
   */
  async extractTextFromS3(s3Key, bucketName) {
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
          const result = await this.extractFromPDF(tempFilePath);
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
        const result = await this.extractFromImage(tempFilePath);
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
  async extractFromPDF(filePath) {
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
      const pdfParse = await import('pdf-parse');
      
      console.log(`📄 Reading PDF file...`);
      const dataBuffer = fs.readFileSync(filePath);
      
      console.log(`🔍 Parsing PDF content...`);
      const data = await pdfParse.default(dataBuffer);
      
      console.log(`✅ PDF parsing completed:`, {
        pages: data.numpages,
        textLength: data.text?.length || 0,
        hasInfo: !!data.info
      });
      
      return {
        text: data.text || '',
        metadata: {
          pages: data.numpages,
          info: data.info,
          version: data.version
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
  async extractFromImage(filePath) {
    try {
      const worker = await createWorker('eng+hin'); // English and Hindi support
      const { data: { text } } = await worker.recognize(filePath);
      await worker.terminate();

      return {
        text: text.trim(),
        metadata: {
          ocrEngine: 'Tesseract.js',
          languages: ['eng', 'hin']
        }
      };
    } catch (error) {
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
}

export default DocumentReader;
