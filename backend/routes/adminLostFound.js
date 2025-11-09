import express from "express";
import { requireAdminAuth } from "../middleware/adminAuth.js";
import {
  getSummary,
  listMatches,
  confirmMatch,
  rejectMatch,
} from "../controllers/lostFoundAdminController.js";

const router = express.Router();

router.get("/summary", requireAdminAuth, getSummary);
router.get("/matches", requireAdminAuth, listMatches);
router.post("/matches/:id/confirm", requireAdminAuth, confirmMatch);
router.post("/matches/:id/reject", requireAdminAuth, rejectMatch);

export default router;

