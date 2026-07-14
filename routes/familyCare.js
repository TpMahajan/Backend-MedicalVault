import express from "express";
import { auth } from "../middleware/auth.js";
import {
  requireFamilyCareEntitlement,
  resolvePatientProfile,
  requireCareRelationship,
  requireCarePermission,
  allowArchivedFamilyCareProfile,
  requireArchiveProfileOwner,
  requireProfileOwner,
} from "../middleware/careAuthorization.js";
import { familyCareInvitationLimiter, familyCareUserSearchLimiter } from "../middleware/familyCareRateLimit.js";
import * as controller from "../controllers/familyCareController.js";
import * as connections from "../controllers/familyCareConnectionsController.js";
import * as medications from "../controllers/familyCareMedicationController.js";
import * as appointments from "../controllers/familyCareAppointmentController.js";
import * as notificationPreferences from "../controllers/familyCareNotificationPreferencesController.js";
import { CareInvitation } from "../models/CareInvitation.js";

const router = express.Router();
router.use(auth, requireFamilyCareEntitlement);

router.get("/dashboard", controller.dashboard);
router.get("/profiles", controller.listProfiles);
router.post("/profiles", controller.createProfile);
router.get("/users/search", familyCareUserSearchLimiter, connections.searchExistingUsers);
router.get("/connections", connections.listConnections);
router.get("/invitations", connections.listConnectionInvitations);
router.post("/invitations", familyCareInvitationLimiter, connections.createConnectionInvitation);
router.post("/invitations/:invitationId/accept", async (req, res, next) => {
  try {
    const invitation = await CareInvitation.findById(req.params.invitationId).select("kind").lean();
    if (invitation?.kind === "connection") return connections.acceptConnectionInvitation(req, res);
    return controller.acceptInvitation(req, res);
  } catch (error) { return next(error); }
});
router.post("/invitations/:invitationId/decline", async (req, res, next) => {
  try {
    const invitation = await CareInvitation.findById(req.params.invitationId).select("kind").lean();
    if (invitation?.kind === "connection") return connections.declineConnectionInvitation(req, res);
    return controller.declineInvitation(req, res);
  } catch (error) { return next(error); }
});
router.post("/invitations/:invitationId/cancel", connections.cancelConnectionInvitation);
router.patch("/connections/:connectionId", connections.updateConnection);
router.delete("/connections/:connectionId", connections.deleteConnection);
router.get("/notification-preferences", notificationPreferences.getGlobalFamilyCareNotificationPreferences);
router.patch("/notification-preferences", notificationPreferences.updateGlobalFamilyCareNotificationPreferences);
router.get("/doctors", appointments.listFamilyDoctors);

router.get("/profiles/:profileId", resolvePatientProfile, requireCareRelationship, requireCarePermission("profileRead"), controller.getProfile);
router.get("/profiles/:profileId/summary", resolvePatientProfile, requireCareRelationship, requireCarePermission("profileRead"), controller.getProfile);
router.patch("/profiles/:profileId", resolvePatientProfile, requireCareRelationship, requireCarePermission("profileEdit"), controller.updateProfile);
router.post("/profiles/:profileId/archive", allowArchivedFamilyCareProfile, resolvePatientProfile, requireArchiveProfileOwner, controller.archiveProfile);
router.post("/profiles/:profileId/link-account", familyCareInvitationLimiter, resolvePatientProfile, requireCareRelationship, requireProfileOwner, connections.requestManagedProfileLink);
router.post("/profile-links/:linkId/accept", connections.acceptManagedProfileLink);
router.post("/profile-links/:linkId/decline", connections.declineManagedProfileLink);
router.get("/profiles/:profileId/notification-preferences", resolvePatientProfile, requireCareRelationship, notificationPreferences.getProfileFamilyCareNotificationPreferences);
router.patch("/profiles/:profileId/notification-preferences", resolvePatientProfile, requireCareRelationship, notificationPreferences.updateProfileFamilyCareNotificationPreferences);
router.get("/profiles/:profileId/appointments", resolvePatientProfile, requireCareRelationship, requireCarePermission("appointmentsView"), appointments.listFamilyAppointments);
router.post("/profiles/:profileId/appointments", resolvePatientProfile, requireCareRelationship, requireCarePermission("appointmentsManage"), appointments.createFamilyAppointment);
router.get("/profiles/:profileId/appointments/:appointmentId", resolvePatientProfile, requireCareRelationship, requireCarePermission("appointmentsView"), appointments.getFamilyAppointment);
router.patch("/profiles/:profileId/appointments/:appointmentId", resolvePatientProfile, requireCareRelationship, requireCarePermission("appointmentsManage"), appointments.updateFamilyAppointment);
router.post("/profiles/:profileId/appointments/:appointmentId/cancel", resolvePatientProfile, requireCareRelationship, requireCarePermission("appointmentsManage"), appointments.cancelFamilyAppointment);
router.get("/profiles/:profileId/medications", resolvePatientProfile, requireCareRelationship, requireCarePermission("medicationsView"), medications.listMedications);
router.post("/profiles/:profileId/medications", resolvePatientProfile, requireCareRelationship, requireCarePermission("medicationsManage"), medications.createMedication);
router.patch("/profiles/:profileId/medications/:medicationId", resolvePatientProfile, requireCareRelationship, requireCarePermission("medicationsManage"), medications.updateMedication);
router.post("/profiles/:profileId/medications/:medicationId/pause", resolvePatientProfile, requireCareRelationship, requireCarePermission("medicationsManage"), medications.pauseMedication);
router.post("/profiles/:profileId/medications/:medicationId/resume", resolvePatientProfile, requireCareRelationship, requireCarePermission("medicationsManage"), medications.resumeMedication);
router.post("/profiles/:profileId/medications/:medicationId/stop", resolvePatientProfile, requireCareRelationship, requireCarePermission("medicationsManage"), medications.stopMedication);
router.get("/profiles/:profileId/doses/today", resolvePatientProfile, requireCareRelationship, requireCarePermission("medicationsView"), medications.listTodayDoses);
router.post("/profiles/:profileId/doses/:doseEventId/taken", resolvePatientProfile, requireCareRelationship, requireCarePermission("dosesConfirm"), medications.markDoseTaken);
router.post("/profiles/:profileId/doses/:doseEventId/skipped", resolvePatientProfile, requireCareRelationship, requireCarePermission("dosesConfirm"), medications.markDoseSkipped);
router.post("/profiles/:profileId/doses/:doseEventId/snooze", resolvePatientProfile, requireCareRelationship, requireCarePermission("dosesConfirm"), medications.snoozeDose);
router.post("/profiles/:profileId/doses/:doseEventId/correction", resolvePatientProfile, requireCareRelationship, requireCarePermission("dosesConfirm"), medications.correctDose);
router.get("/profiles/:profileId/caregivers", resolvePatientProfile, requireCareRelationship, requireCarePermission("caregiverManagement"), controller.listCaregivers);
router.post("/profiles/:profileId/invitations", familyCareInvitationLimiter, resolvePatientProfile, requireCareRelationship, requireCarePermission("caregiverManagement"), controller.createInvitation);
router.patch("/profiles/:profileId/caregivers/:relationshipId", resolvePatientProfile, requireCareRelationship, requireCarePermission("caregiverManagement"), controller.updateCaregiver);
router.delete("/profiles/:profileId/caregivers/:relationshipId", resolvePatientProfile, requireCareRelationship, requireCarePermission("caregiverManagement"), controller.revokeCaregiver);

export default router;
