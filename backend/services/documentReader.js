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
    try {
      // Download file from S3 to temporary location
      const tempFilePath = await this.downloadFromS3(s3Key, bucketName);
      
      // Get file extension
      const fileExtension = path.extname(s3Key).toLowerCase().substring(1);
      
      // Extract text based on file type
      let extractedText = '';
      let metadata = {
        fileType: this.getFileType(fileExtension),
        fileExtension,
        s3Key,
        extractedAt: new Date().toISOString()
      };

      if (this.supportedTypes.pdf.includes(fileExtension)) {
        const result = await this.extractFromPDF(tempFilePath);
        extractedText = result.text;
        metadata = { ...metadata, ...result.metadata };
      } else if (this.supportedTypes.image.includes(fileExtension)) {
        const result = await this.extractFromImage(tempFilePath);
        extractedText = result.text;
        metadata = { ...metadata, ...result.metadata };
      } else if (this.supportedTypes.text.includes(fileExtension)) {
        const result = await this.extractFromText(tempFilePath);
        extractedText = result.text;
        metadata = { ...metadata, ...result.metadata };
      } else {
        throw new Error(`Unsupported file type: ${fileExtension}`);
      }

      // Clean up temporary file
      await this.cleanupTempFile(tempFilePath);

      return {
        success: true,
        text: extractedText,
        metadata,
        wordCount: extractedText.split(/\s+/).length,
        characterCount: extractedText.length
      };

    } catch (error) {
      console.error('Document extraction error:', error);
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
    
    // Ensure temp directory exists
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempFilePath = path.join(tempDir, `temp_${Date.now()}_${path.basename(s3Key)}`);
    
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: s3Key
    });

    const response = await s3Client.send(command);
    const writeStream = createWriteStream(tempFilePath);
    
    await pipelineAsync(response.Body, writeStream);
    
    return tempFilePath;
  }

  /**
   * Extract text from PDF file
   */
  async extractFromPDF(filePath) {
    try {
      // Dynamic import to handle ES module compatibility
      const pdfParse = await import('pdf-parse');
      const dataBuffer = fs.readFileSync(filePath);
      const data = await pdfParse.default(dataBuffer);
      
      return {
        text: data.text,
        metadata: {
          pages: data.numpages,
          info: data.info,
          version: data.version
        }
      };
    } catch (error) {
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
