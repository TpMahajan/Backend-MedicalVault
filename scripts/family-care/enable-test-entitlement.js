#!/usr/bin/env node

import mongoose from "mongoose";
import connectDB from "../../config/database.js";
import { User } from "../../models/User.js";
import { FamilyCarePlatformConfig } from "../../models/FamilyCarePlatformConfig.js";
import { writeAuditLog } from "../../middleware/auditLogger.js";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
};
const userId = String(option("--user-id") || "").trim();
const status = String(option("--status") || "trial").trim().toLowerCase();
const expiryDays = Number(option("--expires-days") || 7);
const profileLimit = Number(option("--max-managed-profiles") || 5);
const caregiverLimit = Number(option("--max-caregivers") || 5);

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (String(process.env.NODE_ENV || "development").toLowerCase() === "production") {
  fail("Refusing to enable Family Care entitlement in production.");
}
if (!args.includes("--confirm-non-production")) {
  fail("Pass --confirm-non-production to make this non-production change.");
}
if (!mongoose.isValidObjectId(userId)) {
  fail("Provide a valid --user-id ObjectId.");
}
if (!["trial", "active"].includes(status)) {
  fail("--status must be trial or active.");
}
if (!Number.isFinite(expiryDays) || expiryDays < 1 || expiryDays > 90) {
  fail("--expires-days must be between 1 and 90.");
}
if (!Number.isFinite(profileLimit) || profileLimit < 1 || profileLimit > 50) {
  fail("--max-managed-profiles must be between 1 and 50.");
}
if (!Number.isFinite(caregiverLimit) || caregiverLimit < 1 || caregiverLimit > 50) {
  fail("--max-caregivers must be between 1 and 50.");
}

try {
  await connectDB();
  const user = await User.findById(userId).select("_id role").lean();
  if (!user || String(user.role || "").toUpperCase() !== "PATIENT") {
    fail("The requested account is not an active patient identity.");
  }

  const expiresAt = new Date(Date.now() + Math.trunc(expiryDays) * 24 * 60 * 60 * 1000);
  await FamilyCarePlatformConfig.findOneAndUpdate(
    { key: "GLOBAL" },
    {
      $setOnInsert: { key: "GLOBAL" },
      $set: {
        enabled: true,
        developmentAutoEntitle: false,
        updatedBy: "family-care-test-entitlement-script",
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        "entitlements.familyCare.enabled": true,
        "entitlements.familyCare.status": status,
        "entitlements.familyCare.trialEndsAt": status === "trial" ? expiresAt : null,
        "entitlements.familyCare.subscriptionEndsAt": status === "active" ? expiresAt : null,
        "entitlements.familyCare.limits.maxManagedProfiles": Math.trunc(profileLimit),
        "entitlements.familyCare.limits.maxCaregiversPerProfile": Math.trunc(caregiverLimit),
      },
    },
  );
  await writeAuditLog({
    req: {
      auth: { id: "family-care-test-entitlement-script", role: "admin" },
      ip: "",
      headers: { "user-agent": "family-care-test-entitlement-script" },
    },
    action: "family_care_test_entitlement_enabled",
    resourceType: "User",
    resourceId: user._id,
    statusCode: 200,
    metadata: { environment: String(process.env.NODE_ENV || "development"), status },
  });
  console.log("Family Care test entitlement enabled for the requested non-production patient account.");
} catch (error) {
  console.error("Unable to enable Family Care test entitlement:", error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}

