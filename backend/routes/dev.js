import express from 'express';
import { testEmail } from '../utils/mailer.js';

const router = express.Router();

/**
 * POST /api/dev/test-email
 * Test email endpoint - guarded by ALLOW_TEST_EMAIL environment variable
 * Only available when ALLOW_TEST_EMAIL === 'true'
 */
router.post('/test-email', async (req, res) => {
  try {
    // Check if test email is allowed
    if (process.env.ALLOW_TEST_EMAIL !== 'true') {
      return res.status(403).json({
        success: false,
        message: 'Test email endpoint is disabled. Set ALLOW_TEST_EMAIL=true to enable.',
        hint: 'This endpoint is only available in development/staging environments'
      });
    }

    const { to } = req.body;
    
    if (!to) {
      return res.status(400).json({
        success: false,
        message: 'Email address is required',
        example: { to: 'test@example.com' }
      });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(to)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email format',
        provided: to
      });
    }

    console.log(`🧪 Test email requested for: ${to}`);

    // Send test email
    const result = await testEmail(to);

    if (result.success) {
      console.log(`✅ Test email sent successfully:`, {
        to,
        messageId: result.messageId,
        timestamp: result.timestamp
      });

      return res.json({
        success: true,
        message: 'Test email sent successfully',
        data: {
          to,
          messageId: result.messageId,
          timestamp: result.timestamp
        }
      });
    } else {
      console.error(`❌ Test email failed:`, {
        to,
        error: result.error,
        timestamp: result.timestamp
      });

      return res.status(500).json({
        success: false,
        message: 'Failed to send test email',
        error: result.error,
        data: {
          to,
          timestamp: result.timestamp
        }
      });
    }

  } catch (error) {
    console.error('❌ Test email endpoint error:', error);
    
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
      hint: 'Check SMTP configuration and environment variables'
    });
  }
});

/**
 * GET /api/dev/test-email/status
 * Check if test email endpoint is enabled
 */
router.get('/test-email/status', (req, res) => {
  const isEnabled = process.env.ALLOW_TEST_EMAIL === 'true';
  
  res.json({
    success: true,
    enabled: isEnabled,
    message: isEnabled 
      ? 'Test email endpoint is enabled' 
      : 'Test email endpoint is disabled',
    hint: isEnabled 
      ? 'Use POST /api/dev/test-email with { "to": "test@example.com" }'
      : 'Set ALLOW_TEST_EMAIL=true to enable test email functionality'
  });
});

export default router;
