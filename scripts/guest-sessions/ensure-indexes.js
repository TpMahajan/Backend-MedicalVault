/*
 * Additive, idempotent guest-session index migration.
 *
 * Run after deploying the model code and before enabling the feature flag:
 *   node scripts/guest-sessions/ensure-indexes.js
 *
 * Rollback: disable GUEST_CLINICAL_SESSIONS_ENABLED. Do not drop these
 * collections/indexes automatically because consent and audit evidence have
 * their own retention obligations.
 */
import dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: "./db.env" });

import connectDB from "../../config/database.js";
import { GuestClinicalSession } from "../../models/GuestClinicalSession.js";
import { GuestClinicalConsent } from "../../models/GuestClinicalConsent.js";
import { GuestClinicalAuditEvent } from "../../models/GuestClinicalAuditEvent.js";

try {
  await connectDB();
  await Promise.all([
    GuestClinicalSession.syncIndexes(),
    GuestClinicalConsent.syncIndexes(),
    GuestClinicalAuditEvent.syncIndexes(),
  ]);
  console.log("Guest clinical session indexes are up to date.");
  process.exitCode = 0;
} catch (error) {
  console.error("Guest clinical session index migration failed:", error?.message || error);
  process.exitCode = 1;
}
