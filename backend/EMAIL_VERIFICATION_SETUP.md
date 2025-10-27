# Email Verification Setup Guide

## Quick Start

### 1. Get Resend API Key

1. Sign up at [resend.com](https://resend.com)
2. Create an API key in the dashboard
3. Add your domain for sending (or use their sandbox)

### 2. Configure Environment

Update `db.env` with your Resend API key:

```env
RESEND_API_KEY=re_your_actual_api_key_here
MAIL_FROM=AI Ally <no-reply@aiallyn.co>
APP_BASE_URL=https://backend-medicalvault.onrender.com
APP_DEEP_LINK=aially
```

### 3. Test the Implementation

#### Test Signup
```bash
curl -X POST http://localhost:5000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test User",
    "email": "test@example.com",
    "password": "test123",
    "mobile": "+1234567890"
  }'
```

Expected response:
- User created with `emailVerified: false`
- Email sent to test@example.com
- Deep link and 6-digit code in email

#### Test Verification
Use the 6-digit code from email:
```bash
curl -X POST http://localhost:5000/api/auth/verify-code \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "code": "123456"
  }'
```

#### Test Resend
```bash
curl -X POST http://localhost:5000/api/auth/resend-verification \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com"
  }'
```

### 4. Verify Email Template

Check your email for:
- ✅ Deep link button
- ✅ HTTPS fallback URL
- ✅ 6-digit verification code in highlighted box
- ✅ Mobile-friendly design

## Files Created

1. `models/EmailVerify.js` - Database model for verification tokens
2. `middleware/requireVerified.js` - Middleware to check email verification
3. `utils/emailService.js` - Email sending service using Resend

## Files Modified

1. `models/User.js` - Added `emailVerified` field
2. `middleware/auth.js` - Added `req.userId` for requireVerified
3. `routes/authRoutes.js` - Added verification endpoints and updated signup/password reset
4. `routes/document.js` - Added requireVerified to upload/delete routes
5. `db.env` - Added email verification environment variables

## Important Notes

- **Google OAuth unaffected**: Google sign-in works exactly as before
- **No React pages needed**: Verification handled via API + deep links
- **Mobile support**: Deep link opens app, HTTPS fallback for web
- **Rate limiting**: 60 seconds between resend requests
- **Token expiry**: 30 minutes
- **Security**: All tokens/codes bcrypt hashed

## Common Issues

### Email not sending
- Check RESEND_API_KEY in db.env
- Verify Resend account is active
- Check domain is verified in Resend dashboard

### Verification fails
- Token expired (30 minutes)
- Token already used (one-time)
- Check server logs for error details

### Rate limit hit
- Wait 60 seconds between resend requests
- Or use existing verification token/code

## Next Steps

1. ✅ Install Resend package (already done)
2. ✅ Add RESEND_API_KEY to production environment
3. ✅ Test signup flow with real email
4. ✅ Test verification with code
5. ✅ Test protected routes (upload, delete)
6. ✅ Verify Google OAuth still works

