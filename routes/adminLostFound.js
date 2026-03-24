import express from "express";
import { requireAdminAuth, requireAdminPermissions } from "../middleware/adminAuth.js";
import {
  getSummary,
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

