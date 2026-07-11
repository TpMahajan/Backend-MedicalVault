import express from "express";
import { auth } from "../middleware/auth.js";
import {
  requireFamilyCareEntitlement,
  resolvePatientProfile,
  requireCareRelationship,
  requireCarePermission,
  requireProfileOwner,
} from "../middleware/careAuthorization.js";
import { familyCareInvitationLimiter } from "../middleware/familyCareRateLimit.js";
import * as controller from "../controllers/familyCareController.js";

const router = express.Router();
router.use(auth, requireFamilyCareEntitlement);

router.get("/dashboard", controller.dashboard);
router.get("/profiles", controller.listProfiles);
router.post("/profiles", controller.createProfile);
router.get("/invitations", controller.listInvitations);
router.post("/invitations/:invitationId/accept", controller.acceptInvitation);
router.post("/invitations/:invitationId/decline", controller.declineInvitation);

router.get("/profiles/:profileId", resolvePatientProfile, requireCareRelationship, requireCarePermission("profileRead"), controller.getProfile);
router.get("/profiles/:profileId/summary", resolvePatientProfile, requireCareRelationship, requireCarePermission("profileRead"), controller.getProfile);
router.patch("/profiles/:profileId", resolvePatientProfile, requireCareRelationship, requireCarePermission("profileEdit"), controller.updateProfile);
router.post("/profiles/:profileId/archive", resolvePatientProfile, requireCareRelationship, requireProfileOwner, controller.archiveProfile);
router.get("/profiles/:profileId/caregivers", resolvePatientProfile, requireCareRelationship, requireCarePermission("caregiverManagement"), controller.listCaregivers);
router.post("/profiles/:profileId/invitations", familyCareInvitationLimiter, resolvePatientProfile, requireCareRelationship, requireCarePermission("caregiverManagement"), controller.createInvitation);
router.patch("/profiles/:profileId/caregivers/:relationshipId", resolvePatientProfile, requireCareRelationship, requireCarePermission("caregiverManagement"), controller.updateCaregiver);
router.delete("/profiles/:profileId/caregivers/:relationshipId", resolvePatientProfile, requireCareRelationship, requireCarePermission("caregiverManagement"), controller.revokeCaregiver);

export default router;
