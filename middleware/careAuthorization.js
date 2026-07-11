import mongoose from "mongoose";
import { PatientProfile } from "../models/PatientProfile.js";
import { CareRelationship } from "../models/CareRelationship.js";
import { resolveFamilyCareEntitlement } from "../services/familyCareEntitlementService.js";

export const requireFamilyCareEntitlement = async (req, res, next) => {
  if (String(req.auth?.role || "").toLowerCase() !== "patient" || !req.user) {
    return res.status(403).json({ success: false, code: "PATIENT_ACCESS_REQUIRED", message: "Patient access required" });
  }
  let entitlement;
  try {
    entitlement = await resolveFamilyCareEntitlement(req.user);
  } catch (error) {
    console.error("Family Care config lookup failed:", error.message);
    return res.status(503).json({
      success: false,
      code: "FAMILY_CARE_CONFIG_UNAVAILABLE",
      message: "Family Care configuration is temporarily unavailable",
    });
  }
  if (!entitlement.allowed) {
    return res.status(403).json({
      success: false,
      code: entitlement.code,
      message: entitlement.code === "FAMILY_CARE_DISABLED"
        ? "Family Care is currently unavailable"
        : "An active Family Care entitlement is required",
    });
  }
  req.familyCareEntitlement = entitlement;
  return next();
};

export const resolvePatientProfile = async (req, res, next) => {
  try {
    const profileId = String(req.params.profileId || "").trim();
    if (!mongoose.isValidObjectId(profileId)) {
      return res.status(400).json({ success: false, code: "INVALID_PROFILE_ID", message: "Invalid patient profile" });
    }
    const profile = await PatientProfile.findById(profileId);
    if (!profile || profile.status === "archived") {
      return res.status(404).json({ success: false, code: "PROFILE_NOT_FOUND", message: "Patient profile not found" });
    }
    req.patientProfile = profile;
    return next();
  } catch (error) {
    return next(error);
  }
};

export const requireCareRelationship = async (req, res, next) => {
  try {
    const relationship = await CareRelationship.findOne({
      patientProfileId: req.patientProfile._id,
      caregiverUserId: req.auth.id,
      status: "active",
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    });
    if (!relationship) {
      return res.status(403).json({ success: false, code: "PROFILE_ACCESS_DENIED", message: "You do not have access to this patient profile" });
    }
    req.careRelationship = relationship;
    return next();
  } catch (error) {
    return next(error);
  }
};

export const requireCarePermission = (permission) => (req, res, next) => {
  if (!req.careRelationship?.permissions?.[permission]) {
    return res.status(403).json({
      success: false,
      code: "CARE_PERMISSION_DENIED",
      permission,
      message: "Your care relationship does not permit this action",
    });
  }
  return next();
};

export const requireProfileOwner = (req, res, next) => {
  if (req.careRelationship?.role !== "owner") {
    return res.status(403).json({ success: false, code: "PROFILE_OWNER_REQUIRED", message: "Profile owner access required" });
  }
  return next();
};
