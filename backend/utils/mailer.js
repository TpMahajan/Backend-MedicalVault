import nodemailer from 'nodemailer';

// Cache for the transporter instance
let transporter = null;
let lastError = null;

/**
 * Creates a robust Nodemailer transporter with port fallbacks
 * Tries ports in order: 465 (secure) → 587 (STARTTLS) → 2525 (fallback)
 */
const createTransporter = async () => {
  if (transporter) {
    return transporter;
  }

  const smtpConfig = {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@medicalvault.app'
  };

  // Configuration options to try in order
  const configs = [
    // Option A: Port 465 with implicit TLS (secure: true)
    {
      host: smtpConfig.host,
      port: 465,
      secure: true,
      auth: smtpConfig.user && smtpConfig.pass ? {
        user: smtpConfig.user,
        pass: smtpConfig.pass
      } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      pool: true,
      family: 4, // Force IPv4
      tls: {
        servername: smtpConfig.host
      }
    },
    // Option B: Port 587 with STARTTLS (secure: false, requireTLS: true)
    {
      host: smtpConfig.host,
      port: 587,
      secure: false,
      requireTLS: true,
      auth: smtpConfig.user && smtpConfig.pass ? {
        user: smtpConfig.user,
        pass: smtpConfig.pass
      } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      pool: true,
      family: 4, // Force IPv4
      tls: {
        servername: smtpConfig.host
      }
    },
    // Option C: Port 2525 fallback (Mailgun/Flywheel style)
    {
      host: smtpConfig.host,
      port: 2525,
      secure: false,
      auth: smtpConfig.user && smtpConfig.pass ? {
        user: smtpConfig.user,
        pass: smtpConfig.pass
      } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      pool: true,
      family: 4, // Force IPv4
      tls: {
        servername: smtpConfig.host
      }
    }
  ];

  // Allow environment variables to override defaults
  if (process.env.SMTP_PORT) {
    const customPort = parseInt(process.env.SMTP_PORT);
    const customSecure = process.env.SMTP_SECURE === 'true';
    
    // Use custom configuration as first option
    configs.unshift({
      host: smtpConfig.host,
      port: customPort,
      secure: customSecure,
      requireTLS: !customSecure,
      auth: smtpConfig.user && smtpConfig.pass ? {
        user: smtpConfig.user,
        pass: smtpConfig.pass
      } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      pool: true,
      family: 4,
      tls: {
        servername: smtpConfig.host
      }
    });
  }

  const errors = [];

  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    
    try {
      if (process.env.NODE_ENV !== 'production') {
        console.log(`🔧 Trying SMTP config ${i + 1}/${configs.length}:`, {
          host: config.host,
          port: config.port,
          secure: config.secure,
          requireTLS: config.requireTLS,
          hasAuth: !!config.auth
        });
      }

      const testTransporter = nodemailer.createTransporter(config);
      
      // Test the connection
      await testTransporter.verify();
      
      if (process.env.NODE_ENV !== 'production') {
        console.log(`✅ SMTP connection successful with config ${i + 1}:`, {
          host: config.host,
          port: config.port,
          secure: config.secure
        });
      }
      
      transporter = testTransporter;
      return transporter;
      
    } catch (error) {
      const errorInfo = {
        config: i + 1,
        host: config.host,
        port: config.port,
        secure: config.secure,
        error: error.message,
        code: error.code
      };
      
      errors.push(errorInfo);
      
      if (process.env.NODE_ENV !== 'production') {
        console.log(`❌ SMTP config ${i + 1} failed:`, errorInfo);
      }
      
      // If this is an ETIMEDOUT on port 25, provide helpful hint
      if (error.code === 'ETIMEDOUT' && config.port === 25) {
        console.warn('💡 ETIMEDOUT on port 25 - try switching to port 465 or 587');
      }
    }
  }

  // All configurations failed
  const errorMessage = `All SMTP configurations failed. Last error: ${errors[errors.length - 1]?.error}`;
  lastError = new Error(errorMessage);
  
  console.error('❌ All SMTP configurations failed:', {
    host: smtpConfig.host,
    attempts: errors.length,
    errors: errors.map(e => ({
      port: e.port,
      secure: e.secure,
      error: e.error,
      code: e.code
    }))
  });
  
  throw lastError;
};

/**
 * Sends an email using the cached transporter
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML content
 * @param {string} options.text - Plain text content
 * @returns {Promise<Object>} - Nodemailer result
 */
export const sendMail = async ({ to, subject, html, text }) => {
  try {
    // Lazy initialization of transporter
    if (!transporter) {
      await createTransporter();
    }

    if (!transporter) {
      throw new Error('Failed to create SMTP transporter');
    }

    const mailOptions = {
      from: process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@medicalvault.app',
      to,
      subject,
      html,
      text
    };

    if (process.env.NODE_ENV !== 'production') {
      console.log('📧 Sending email:', {
        to,
        subject,
        from: mailOptions.from,
        hasHtml: !!html,
        hasText: !!text
      });
    }

    const result = await transporter.sendMail(mailOptions);
    
    if (process.env.NODE_ENV !== 'production') {
      console.log('✅ Email sent successfully:', {
        messageId: result.messageId,
        to,
        subject
      });
    }

    return result;
    
  } catch (error) {
    // Reset transporter on error to force reconnection
    transporter = null;
    
    const errorInfo = {
      error: error.message,
      code: error.code,
      to,
      subject,
      lastAttempt: lastError?.message
    };
    
    console.error('❌ Email send failed:', errorInfo);
    
    // Provide helpful error message
    let helpfulMessage = error.message;
    if (error.code === 'ETIMEDOUT') {
      helpfulMessage += ' - Try switching to port 465 or 587';
    }
    
    throw new Error(`Email send failed: ${helpfulMessage}`);
  }
};

/**
 * Test email functionality
 * @param {string} to - Test email recipient
 * @returns {Promise<Object>} - Test result
 */
export const testEmail = async (to) => {
  try {
    const result = await sendMail({
      to,
      subject: 'SMTP OK from MedicalVault',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #4A90E2;">✅ SMTP Test Successful</h2>
          <p>This is a test email from MedicalVault to verify SMTP configuration.</p>
          <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
          <p><strong>Environment:</strong> ${process.env.NODE_ENV || 'development'}</p>
          <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;">
          <p style="color: #666; font-size: 12px;">
            If you received this email, your SMTP configuration is working correctly.
          </p>
        </div>
      `,
      text: `SMTP Test Successful\n\nThis is a test email from MedicalVault to verify SMTP configuration.\nTimestamp: ${new Date().toISOString()}\nEnvironment: ${process.env.NODE_ENV || 'development'}`
    });
    
    return {
      success: true,
      messageId: result.messageId,
      to,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message,
      to,
      timestamp: new Date().toISOString()
    };
  }
};

export default { sendMail, testEmail, createTransporter };
