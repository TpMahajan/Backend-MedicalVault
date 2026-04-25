import express from "express";
import { requireAdminAuth, requireAdminPermissions } from "../middleware/adminAuth.js";
import {
  getSummary,
  listReports,
  updateReportStatus,
  sendReporterNotification,
  listMatches,
  confirmMatch,
  rejectMatch,
} from "../controllers/lostFoundAdminController.js";

const router = express.Router();

router.get(
  "/summary",
  requireAdminAuth,
  requireAdminPermissions("VIEW_SOS"),
  getSummary
);
router.get(
  "/reports",
  requireAdminAuth,
  requireAdminPermissions("VIEW_SOS"),
  listReports
);
router.patch(
  "/reports/:id/status",
  requireAdminAuth,
  requireAdminPermissions("HANDLE_SOS"),
  updateReportStatus
);
router.post(
  "/reports/:id/notify",
  requireAdminAuth,
  requireAdminPermissions("HANDLE_SOS"),
  sendReporterNotification
);
router.get(
  "/matches",
  requireAdminAuth,
  requireAdminPermissions("VIEW_SOS"),
  listMatches
);
router.post(
  "/matches/:id/confirm",
  requireAdminAuth,
  requireAdminPermissions("HANDLE_SOS"),
  confirmMatch
);
router.post(
  "/matches/:id/reject",
  requireAdminAuth,
  requireAdminPermissions("HANDLE_SOS"),
  rejectMatch
);

export default router;

