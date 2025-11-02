import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

// Use a Resend-verified sender for Resend API. Do NOT default to MAIL_FROM (SMTP) here.
const MAIL_FROM_RESEND = process.env.MAIL_FROM_RESEND || "onboarding@resend.dev";
// SMTP or generic mail-from (used by nodemailer paths elsewhere)
const MAIL_FROM = process.env.MAIL_FROM || process.env.SMTP_USER || "no-reply@medicalvault.app";
const APP_BASE_URL = process.env.APP_BASE_URL || "https://backend-medicalvault.onrender.com";
const APP_WEB_URL = process.env.FRONTEND_URL || process.env.APP_WEB_URL || "https://health-vault-web.vercel.app";
const APP_DEEP_LINK = process.env.APP_DEEP_LINK || "aially";

/**
 * Send email verification email with deep link and code
 * @param {string} to - Email address
 * @param {string} name - User's name
 * @param {string} tokenId - Public token ID
 * @param {string} token - Secret token
 * @param {string} code - 6-digit verification code
 */
export const sendVerificationEmail = async (to, name, tokenId, token, code) => {
  if (!resend) {
    console.error("❌ Resend API key not configured");
    throw new Error("Email service not configured");
  }

  const deepLink = `${APP_DEEP_LINK}://verify?token=${tokenId}.${token}`;
  const fallbackUrl = `${APP_WEB_URL}/verify-email?token=${tokenId}.${token}`;

  const emailHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Verify Your Email - AI Ally</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
      <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
        <!-- Header -->
        <div style="background-color: #4A90E2; padding: 30px; text-align: center;">
          <h1 style="color: #ffffff; margin: 0; font-size: 24px;">AI Ally</h1>
        </div>

        <!-- Content -->
        <div style="padding: 40px 30px;">
          <h2 style="color: #333333; margin-top: 0;">Verify Your Email Address</h2>
          
          <p style="color: #666666; line-height: 1.6;">
            Hello ${name},
          </p>
          
          <p style="color: #666666; line-height: 1.6;">
            Thank you for signing up for AI Ally! Please verify your email address to complete your registration.
          </p>

          <!-- Deep Link Button -->
          <div style="text-align: center; margin: 30px 0;">
            <a href="${deepLink}" 
               style="background-color: #4A90E2; color: white; padding: 14px 35px; 
                      text-decoration: none; border-radius: 6px; display: inline-block; 
                      font-weight: bold; font-size: 16px;">
              Verify Email
            </a>
          </div>

          <!-- HTTPS Fallback -->
          <p style="color: #666666; line-height: 1.6; font-size: 14px;">
            Or copy and paste this link into your browser:<br>
            <a href="${fallbackUrl}" style="color: #4A90E2; word-break: break-all;">
              ${fallbackUrl}
            </a>
          </p>

          <!-- Verification Code -->
          <div style="background-color: #f9f9f9; padding: 20px; border-radius: 6px; margin: 30px 0;">
            <p style="color: #666666; margin: 0 0 10px 0; font-weight: bold;">Your verification code is:</p>
            <p style="color: #4A90E2; font-size: 32px; font-weight: bold; margin: 0; 
                      letter-spacing: 4px; font-family: 'Courier New', monospace;">
              ${code}
            </p>
          </div>

          <p style="color: #999999; font-size: 12px; margin-top: 30px;">
            This link and code will expire in 30 minutes.<br>
            If you didn't create an account, you can safely ignore this email.
          </p>
        </div>

        <!-- Footer -->
        <div style="background-color: #f4f4f4; padding: 20px; text-align: center;">
          <p style="color: #999999; font-size: 12px; margin: 0;">
            &copy; ${new Date().getFullYear()} AI Ally. All rights reserved.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  const emailText = `AI Ally - Verify Your Email\n\nHello ${name},\n\nThank you for signing up for AI Ally!\n\nVerify via app link (if installed):\n${deepLink}\n\nOr open this fallback URL in your browser:\n${fallbackUrl}\n\nYour verification code (valid 30 minutes): ${code}\n\nIf you didn't create an account, you can ignore this message.`;

  const { data, error } = await resend.emails.send({
    from: MAIL_FROM_RESEND,
    to: to,
    subject: "Verify Your AI Ally Email",
    html: emailHtml,
    text: emailText,
  });

  if (error) {
    console.error("❌ Failed to send verification email via Resend:", error);
    throw error;
  }

  console.log("✅ Verification email sent successfully:", { to, name, id: data?.id, from: MAIL_FROM_RESEND });
  return data;
};

/**
 * Send password reset email via Resend
 */
export const sendPasswordResetEmail = async (to, name, resetLink, expiresInMinutes) => {
  if (!resend) {
    throw new Error("Email service not configured");
  }

  const html = `
    <!DOCTYPE html>
    <html>
    <body style="font-family: Arial, sans-serif; background:#f6f6f6; padding:20px;">
      <div style="max-width:600px;margin:0 auto;background:#ffffff;padding:24px;border-radius:8px;">
        <h2 style="color:#4A90E2;">Reset Your Password</h2>
        <p>Hello ${name || "there"},</p>
        <p>Click the button below to set a new password (valid for ${expiresInMinutes} minutes):</p>
        <p style="text-align:center; margin:28px 0;">
          <a href="${resetLink}" style="background:#4A90E2;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">Reset Password</a>
        </p>
        <p>If the button doesn't work, copy this link into your browser:<br>
          <a href="${resetLink}">${resetLink}</a>
        </p>
      </div>
    </body>
    </html>
  `;

  const text = `Hello ${name || "there"},\n\nReset your password using this link (valid for ${expiresInMinutes} minutes):\n${resetLink}`;

  const { data, error } = await resend.emails.send({
    from: MAIL_FROM_RESEND,
    to,
    subject: "Reset Your HealthVault Password",
    html: html,
    text: text,
  });

  if (error) {
    console.error("❌ Failed to send password reset email via Resend:", error);
    throw error;
  }

  console.log("✅ Password reset email sent:", { to, id: data?.id, from: MAIL_FROM_RESEND });
  return data;
};

/**
 * Initialize email service and check configuration
 */
export const checkEmailConfig = () => {
  if (!process.env.RESEND_API_KEY) {
    console.error("❌ RESEND_API_KEY not found in environment variables");
    console.error("Email verification will not work. Please add RESEND_API_KEY to db.env");
    return false;
  }

  if (!process.env.MAIL_FROM) {
    console.warn("⚠️  MAIL_FROM not found in environment variables");
    console.warn("Using default:", MAIL_FROM);
  }

  if (!process.env.APP_BASE_URL) {
    console.warn("⚠️  APP_BASE_URL not found in environment variables");
    console.warn("Using default:", APP_BASE_URL);
  }

  if (!process.env.APP_DEEP_LINK) {
    console.warn("⚠️  APP_DEEP_LINK not found in environment variables");
    console.warn("Using default:", APP_DEEP_LINK);
  }

  console.log("✅ Email service configured:", {
    hasApiKey: !!process.env.RESEND_API_KEY,
    mailFromResend: MAIL_FROM_RESEND,
    mailFromSmtp: MAIL_FROM,
    appBaseUrl: APP_BASE_URL,
    appWebUrl: APP_WEB_URL,
    appDeepLink: APP_DEEP_LINK,
  });

  return true;
};

