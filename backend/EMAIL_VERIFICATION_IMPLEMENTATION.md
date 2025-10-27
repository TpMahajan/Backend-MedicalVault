# Email Verification Implementation

## Overview
Added email verification for email/password signup users. Google OAuth users remain unchanged and are automatically considered verified.

## Changes Made

### 1. Database Models

#### User Model (`models/User.js`)
- Added `emailVerified` field (boolean, default: false)
- Google OAuth users are set to `emailVerified: true` upon signup/login

#### EmailVerify Model (`models/EmailVerify.js`)
- New model for storing email verification tokens and codes
- Fields:
  - `userId`: Reference to User
  - `tokenId`: Public token ID (for deep links)
  - `tokenHash`: Hashed verification token
  - `codeHash`: Hashed 6-digit code
  - `expiresAt`: Token expiry (30 minutes)
  - `lastSentAt`: Timestamp for rate limiting
- Indexes: userId, tokenId, expiresAt (TTL)

### 2. Middleware

#### requireVerified Middleware (`middleware/requireVerified.js`)
- Ensures email is verified before accessing sensitive routes
- Google users are automatically allowed
- Returns 403 if email not verified
- Used on document upload/delete routes

#### auth Middleware Updates (`middleware/auth.js`)
- Added `req.userId` for requireVerified middleware compatibility

### 3. Email Service

#### Email Service (`utils/emailService.js`)
- Uses Resend API for sending emails
- Sends verification email with:
  - Deep link: `aially://verify?token=tokenId.token`
  - HTTPS fallback URL
  - 6-digit verification code
- Beautiful HTML email template
- Configuration check function

### 4. API Endpoints

#### POST `/api/auth/signup`
**Updated:**
- Creates user with `emailVerified: false`
- Generates verification token and 6-digit code
- Stores hashed values in EmailVerify collection
- Sends verification email with deep link and code
- Returns JWT token (user can use app but must verify for sensitive operations)

#### POST `/api/auth/verify`
**New endpoint:**
- Verifies email using token
- Accepts token via query or body (format: `tokenId.token`)
- Updates user to `emailVerified: true`
- Deletes EmailVerify records after successful verification

#### POST `/api/auth/verify-code`
**New endpoint:**
- Verifies email using 6-digit code
- Body: `{ email, code }`
- Updates user to `emailVerified: true`
- Deletes EmailVerify records after successful verification

#### POST `/api/auth/resend-verification`
**New endpoint:**
- Resends verification email
- Rate limiting: 60 seconds cooldown
- Invalidates previous tokens
- Generates new token and code
- Sends new verification email

#### POST `/api/auth/forgot-password`
**Updated:**
- Now checks `emailVerified` status
- Blocks password reset if email not verified (403)
- Google users always allowed
- Unverified email users see: "Please verify your email first before resetting your password."

#### POST `/api/auth/google`
**Updated:**
- Sets `emailVerified: true` for new Google users
- Ensures existing Google users have `emailVerified: true`
- No changes to login flow

#### POST `/api/auth/login`
**Updated:**
- Returns `emailVerified` in user object

### 5. Protected Routes

#### Document Upload (`/api/files/upload`)
- Added `requireVerified` middleware
- Unverified users cannot upload documents
- Google users can upload immediately

#### Document Delete (`/api/files/:id`)
- Added `requireVerified` middleware
- Unverified users cannot delete documents
- Google users can delete immediately

### 6. Environment Variables

Updated `db.env`:
```env
# Email Verification (Resend)
RESEND_API_KEY=your-resend-api-key-here
MAIL_FROM=AI Ally <no-reply@aiallyn.co>
APP_DEEP_LINK=aially
```

## Security Features

1. **Token Hashing**: Tokens and codes are bcrypt hashed
2. **Token Expiry**: 30 minutes expiration
3. **Rate Limiting**: 60 seconds cooldown between resend requests
4. **Constant-Time Comparison**: bcrypt.compare prevents timing attacks
5. **Account Enumeration Prevention**: Generic responses where appropriate
6. **One-Time Use**: Verification records deleted after success
7. **TTL Index**: Expired verification records auto-deleted by MongoDB

## User Flow

### Email/Password Signup
1. User signs up with email/password
2. Account created with `emailVerified: false`
3. Verification email sent with deep link and 6-digit code
4. User can login but cannot:
   - Upload documents
   - Delete documents
   - Reset password
5. User verifies email via:
   - Deep link in email: `aially://verify?token=xxx`
   - HTTPS fallback URL
   - 6-digit code
6. `emailVerified` set to `true`
7. User can now perform all operations

### Google OAuth
1. User signs in with Google
2. Account created/updated with `emailVerified: true`
3. No verification email sent
4. User can perform all operations immediately

## Testing

### Test Cases

1. **Normal Signup**
   - POST `/api/auth/signup` → Creates user with `emailVerified: false`
   - Email sent with verification link and code
   - Response includes `emailVerified: false`

2. **Verify with Token**
   - POST `/api/auth/verify?token=tokenId.token`
   - User updated to `emailVerified: true`

3. **Verify with Code**
   - POST `/api/auth/verify-code` with `{ email, code }`
   - User updated to `emailVerified: true`

4. **Resend Verification**
   - POST `/api/auth/resend-verification` with `{ email }`
   - First call succeeds
   - Second call within 60s returns 429

5. **Forgot Password**
   - Unverified user → 403 "Please verify your email first"
   - Verified user → Reset email sent

6. **Google OAuth**
   - No changes to behavior
   - User immediately verified

7. **Protected Routes**
   - Unverified user → 403
   - Verified user → Allowed
   - Google user → Allowed

## Migration Notes

- Existing users will have `emailVerified: false` by default
- Google OAuth users will be set to `emailVerified: true` on next login
- Email/password users must verify their email before password reset
- No data migration needed

## Dependencies Added

- `resend`: ^latest (installed)

## Configuration

The following environment variables are required:

```env
RESEND_API_KEY=your-resend-api-key
MAIL_FROM=AI Ally <no-reply@aiallyn.co>
APP_BASE_URL=https://backend-medicalvault.onrender.com
APP_DEEP_LINK=aially
JWT_SECRET=your-existing-secret
```

## Error Handling

- Missing env vars: Clear error logs on startup
- Email send failure: Logged but doesn't break signup
- Invalid tokens: Returns 400 with clear message
- Expired tokens: Returns 400 with expired message
- Rate limiting: Returns 429 with remaining seconds

## Notes

- **Google OAuth unchanged**: All Google sign-in flows work identically
- **Mobile-first**: Deep link + HTTPS fallback for verification
- **No UI needed**: Verification happens via API, frontend handles deep links
- **Backward compatible**: Existing Google users continue working
- **Privacy-conscious**: Generic responses prevent user enumeration

