import { writeAuditLog } from "../middleware/auditLogger.js";
import {
  FAMILY_PROFILE_REQUEST_POLICIES,
  normalizeFamilyProfileAccessControls,
  patchFamilyProfileAccessControls,
} from "../services/familyProfileAccessControls.js";

const response = (controls) => ({ success: true, data: { controls } });

export const getFamilyProfileAccessControls = async (req, res) => {
  const controls = normalizeFamilyProfileAccessControls(req.user.familyProfileAccessControls || {});
  return res.json(response(controls));
};

export const updateFamilyProfileAccessControls = async (req, res) => {
  const input = req.body || {};
  if (input.requestPolicy !== undefined && !FAMILY_PROFILE_REQUEST_POLICIES.includes(input.requestPolicy)) {
    return res.status(400).json({
      success: false,
      code: "INVALID_PROFILE_ACCESS_REQUEST_POLICY",
      message: "Use a supported profile access request policy.",
    });
  }
  for (const key of ["allowProfileAccessRequests", "requireApprovalForEveryRequest"]) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") {
      return res.status(400).json({ success: false, code: "VALIDATION_ERROR", message: `${key} must be true or false.` });
    }
  }
  const controls = patchFamilyProfileAccessControls(req.user.familyProfileAccessControls || {}, input);
  req.user.familyProfileAccessControls = controls;
  await req.user.save();
  await writeAuditLog({
    req,
    action: "family_profile_access_controls_updated",
    resourceType: "UserFamilyProfileAccessControls",
    resourceId: req.auth.id,
  });
  return res.json(response(controls));
};
