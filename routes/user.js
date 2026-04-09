import express from 'express';
import {
  updateProfile,
  updateFCMToken,
  getUserProfile,
  deleteAccount,
  getMedicalCard,
  getAllPatients
} from '../controllers/userController.js';
import {
  updateProfileValidation,
  fcmTokenValidation
} from '../middleware/validation.js';
import { auth } from '../middleware/auth.js';
import { fcmLimiter } from '../middleware/rateLimit.js';
import { User } from '../models/User.js';
import { checkSession } from '../middleware/checkSession.js';
import { checkRole, requireOwnerOrRoles } from '../middleware/rbac.js';
import { auditTrail } from '../middleware/auditLogger.js';

const router = express.Router();

// @route   PUT /api/users/profile
router.put('/profile', auth, updateProfileValidation, updateProfile);

// @route   GET /api/users/all-patients
router.get('/all-patients', auth, checkRole('doctor', 'admin', 'superadmin'), getAllPatients);

// @route   PUT /api/users/fcm-token
router.put('/fcm-token', auth, fcmLimiter, fcmTokenValidation, updateFCMToken);

// @route   GET /api/users/:id/medical-card
router.get(
  '/:id/medical-card',
  auth,
  checkSession,
  auditTrail({
    action: 'READ_MEDICAL_CARD',
    resourceType: 'USER_MEDICAL_CARD',
    getResourceId: (req) => req.params.id,
    getPatientId: (req) => req.params.id,
  }),
  getMedicalCard
);

// @route   GET /api/users/:id
router.get(
  '/:id',
  auth,
  checkSession,
  auditTrail({
    action: 'READ_PROFILE',
    resourceType: 'USER_PROFILE',
    getResourceId: (req) => req.params.id,
    getPatientId: (req) => req.params.id,
  }),
  getUserProfile
);

// @route   POST /api/users/:id/fcm-token
router.post('/:id/fcm-token', auth, requireOwnerOrRoles({ ownerParam: 'id' }), fcmLimiter, fcmTokenValidation, async (req, res) => {
  try {
    const { token } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    user.fcmToken = token;
    await user.save();

    res.json({ success: true, message: "FCM token saved" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// @route   DELETE /api/users/account
router.delete('/account', auth, deleteAccount);

// @route   GET /api/users/:id/records
router.get('/:id/records', auth, checkSession, auditTrail({
  action: 'READ_MEDICAL_RECORDS',
  resourceType: 'USER_RECORDS',
  getResourceId: (req) => req.params.id,
  getPatientId: (req) => req.params.id,
}), async (req, res) => {
  try {
    const user = await User.findById(req.params.id).populate('medicalRecords');
    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    const patientId = String(req.params.id || "");
    const records = (user.medicalRecords || []).filter(
      (record) => String(record?.userId || "") === patientId
    );

    const grouped = {
      reports: records.filter((record) => record.category?.toLowerCase() === "report"),
      prescriptions: records.filter((record) => record.category?.toLowerCase() === "prescription"),
      bills: records.filter((record) => record.category?.toLowerCase() === "bill"),
      insurance: records.filter((record) => record.category?.toLowerCase() === "insurance"),
    };

    const { generateSignedUrl } = await import("../utils/s3Utils.js");
    const apiBaseUrl = `${req.protocol}://${req.get("host")}`;
    const groupedWithUrl = Object.fromEntries(
      await Promise.all(
        Object.entries(grouped).map(async ([key, docs]) => [
          key,
          await Promise.all(
            docs.map(async (doc) => {
              try {
                const signedUrl = await generateSignedUrl(doc.s3Key, doc.s3Bucket);
                return {
                  ...doc.toObject(),
                  url: signedUrl,
                  fileUrl: signedUrl,
                  documentUrl: signedUrl,
                };
              } catch (error) {
                console.error(`Error generating URL for doc ${doc._id}:`, error);
                const proxyUrl = `${apiBaseUrl}/api/files/${doc._id}/proxy?disposition=inline`;
                return {
                  ...doc.toObject(),
                  url: proxyUrl,
                  fileUrl: proxyUrl,
                  documentUrl: proxyUrl,
                  source: "proxy_fallback",
                  error: "Failed to generate access URL"
                };
              }
            })
          ),
        ])
      )
    );

    const role = String(req.auth?.role || '').toLowerCase();
    const mode = role === 'doctor' ? 'doctor' : role === 'admin' ? 'admin' : role === 'superadmin' ? 'superadmin' : 'patient';

    const response = {
      success: true,
      counts: Object.fromEntries(
        Object.entries(groupedWithUrl).map(([k, v]) => [k, v.length])
      ),
      records: groupedWithUrl,
      mode,
    };

    res.json(response);
  } catch (err) {
    console.error("Error fetching user records:", err);
    res.status(500).json({ success: false, msg: "Error fetching records", error: err.message });
  }
});

export default router;
