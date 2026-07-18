import mongoose from "mongoose";
import { SessionAccessGrant } from "../models/SessionAccessGrant.js";
import { PatientSessionSharingPreference } from "../models/PatientSessionSharingPreference.js";
import { Document } from "../models/File.js";

export const DOCUMENT_CATEGORIES = Object.freeze(["Report", "Prescription", "Bill", "Insurance"]);
export const STRUCTURED_DATA_SCOPES = Object.freeze([
  "profile",
  "allergies",
  "conditions",
  "medications",
  "appointments",
  "emergencyInformation",
]);

// A caller may pass a populated Mongoose subdocument (e.g. a Session whose
// doctorId/patientId came through .populate(...)) instead of a raw id —
// String()-ing the subdocument directly yields "[object Object]", not its
// id. Always extract ._id first when present, everywhere in this file.
const asIdString = (value) => String(value && typeof value === "object" && value._id ? value._id : value);
const asObjectId = (value) => new mongoose.Types.ObjectId(asIdString(value));
const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(asIdString(value || ""));

const DEFAULT_PREFERENCE = () => ({
  categoryDefaults: { Report: "ask", Prescription: "ask", Bill: "deny", Insurance: "deny" },
  structuredDataDefaults: {
    profile: true,
    allergies: true,
    conditions: true,
    medications: true,
    appointments: false,
    emergencyInformation: true,
  },
  capabilities: { allowDoctorDownload: false, allowDoctorUploadToPatient: true },
});

// Returns the patient's saved sharing preferences, or the product defaults if
// they have never saved any. Never creates a document as a side effect of a
// read — the record is only ever written explicitly via updatePreferences.
export const getSharingPreferences = async (patientId) => {
  const saved = await PatientSessionSharingPreference.findOne({ patientId }).lean();
  if (!saved) {
    return { ...DEFAULT_PREFERENCE(), version: 1, isDefault: true };
  }
  return {
    categoryDefaults: saved.categoryDefaults,
    structuredDataDefaults: saved.structuredDataDefaults,
    capabilities: saved.capabilities,
    version: saved.version,
    isDefault: false,
  };
};

export const updateSharingPreferences = async (patientId, patch) => {
  const current = await getSharingPreferences(patientId);
  const next = {
    categoryDefaults: { ...current.categoryDefaults, ...(patch.categoryDefaults || {}) },
    structuredDataDefaults: { ...current.structuredDataDefaults, ...(patch.structuredDataDefaults || {}) },
    capabilities: { ...current.capabilities, ...(patch.capabilities || {}) },
  };
  const updated = await PatientSessionSharingPreference.findOneAndUpdate(
    { patientId },
    { $set: next, $inc: { version: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  return {
    categoryDefaults: updated.categoryDefaults,
    structuredDataDefaults: updated.structuredDataDefaults,
    capabilities: updated.capabilities,
    version: updated.version,
    isDefault: false,
  };
};

// Builds the data the patient's approval screen needs: available document
// counts per category (only for categories the patient hasn't defaulted to
// "deny"), pre-selected document ids per the patient's saved defaults, and
// the structured-data/capability toggle defaults.
export const buildApprovalPreview = async ({ patientId }) => {
  const preferences = await getSharingPreferences(patientId);
  const docs = await Document.find({ userId: String(patientId) })
    .select("_id title category createdAt")
    .sort({ createdAt: -1 })
    .lean();

  const categories = DOCUMENT_CATEGORIES.map((category) => {
    const categoryDocs = docs.filter((doc) => doc.category === category);
    const defaultState = preferences.categoryDefaults[category] || "ask";
    const preselected = defaultState === "share" ? categoryDocs.map((doc) => String(doc._id)) : [];
    return {
      category,
      defaultState,
      documentCount: categoryDocs.length,
      documents: categoryDocs.map((doc) => ({
        id: String(doc._id),
        title: doc.title,
        category: doc.category,
        createdAt: doc.createdAt,
      })),
      preselectedDocumentIds: preselected,
    };
  });

  return {
    categories,
    structuredDataDefaults: preferences.structuredDataDefaults,
    capabilityDefaults: preferences.capabilities,
  };
};

// Materializes a SessionAccessGrant at the moment a session is accepted.
// `selection` is the patient's explicit choice from the approval screen; any
// field the patient didn't touch falls back to their saved preferences (or
// product defaults if they have none). This is a one-time snapshot: document
// ids are resolved to the exact set that exists right now, not a live query
// against the category, per the documented "no auto-share of future uploads"
// behavior.
export const materializeGrantForSession = async ({ session, selection = {} }) => {
  const patientId = asIdString(session.patientId);
  const doctorId = asIdString(session.doctorId);
  const preferences = await getSharingPreferences(patientId);

  let selectedDocumentIds = [];
  let selectedCategories = [];

  if (Array.isArray(selection.selectedDocumentIds)) {
    selectedDocumentIds = selection.selectedDocumentIds.filter(isValidObjectId);
    selectedCategories = Array.isArray(selection.selectedCategories) ? selection.selectedCategories : [];
  } else {
    // No explicit selection supplied: fall back entirely to saved defaults,
    // resolving "share" categories to their current document set.
    const docs = await Document.find({ userId: patientId }).select("_id category").lean();
    for (const category of DOCUMENT_CATEGORIES) {
      const state = preferences.categoryDefaults[category] || "ask";
      if (state === "share") {
        selectedCategories.push(category);
        selectedDocumentIds.push(...docs.filter((doc) => doc.category === category).map((doc) => String(doc._id)));
      }
    }
  }

  const structuredDataScopes = Array.isArray(selection.structuredDataScopes)
    ? selection.structuredDataScopes.filter((scope) => STRUCTURED_DATA_SCOPES.includes(scope))
    : STRUCTURED_DATA_SCOPES.filter((scope) => preferences.structuredDataDefaults[scope] === true);

  const capabilities = {
    canViewDocuments: true,
    canDownloadDocuments:
      selection.capabilities?.allowDoctorDownload ?? preferences.capabilities.allowDoctorDownload ?? false,
    canUploadDocuments:
      selection.capabilities?.allowDoctorUploadToPatient ?? preferences.capabilities.allowDoctorUploadToPatient ?? false,
  };

  if (selection.saveAsDefault === true) {
    await updateSharingPreferences(patientId, {
      categoryDefaults: selection.categoryDefaultsToSave,
      structuredDataDefaults: Object.fromEntries(
        STRUCTURED_DATA_SCOPES.map((scope) => [scope, structuredDataScopes.includes(scope)])
      ),
      capabilities: {
        allowDoctorDownload: capabilities.canDownloadDocuments,
        allowDoctorUploadToPatient: capabilities.canUploadDocuments,
      },
    });
  }

  const grant = await SessionAccessGrant.findOneAndUpdate(
    { sessionId: session._id },
    {
      $set: {
        patientId: asObjectId(patientId),
        doctorId: asObjectId(doctorId),
        selectedDocumentIds: selectedDocumentIds.map(asObjectId),
        selectedCategories,
        structuredDataScopes,
        capabilities,
        status: "active",
        grantedAt: new Date(),
        expiresAt: session.expiresAt,
        revokedAt: null,
        revokedBy: null,
      },
      $inc: { version: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return grant;
};

// The single source of truth every document/structured-data endpoint must
// consult. Returns null (never throws) when there is no currently-active,
// non-expired grant for this doctor+patient+session — callers must treat
// null as "forbidden", not "unrestricted".
export const resolveActiveGrant = async ({ sessionId, doctorId, patientId }) => {
  if (!isValidObjectId(sessionId)) return null;
  const grant = await SessionAccessGrant.findOne({
    sessionId: asObjectId(sessionId),
    doctorId: asObjectId(doctorId),
    patientId: asObjectId(patientId),
  });
  if (!grant) return null;
  if (grant.status !== "active") return null;
  if (grant.expiresAt <= new Date()) {
    // Lazily flip to "expired" so listing/audit endpoints reflect reality
    // without requiring a separate cron sweep for correctness (a sweep may
    // still exist for cleanup, but authorization never depends on it having
    // run yet).
    grant.status = "expired";
    await grant.save();
    return null;
  }
  return grant;
};

export const grantAllowsDocument = (grant, documentId) =>
  !!grant && grant.selectedDocumentIds.some((id) => String(id) === String(documentId));

const PRIVILEGED_ROLES = new Set(["admin", "superadmin"]);

// Shared list-filtering rule for any endpoint that returns a patient's
// documents to a requester who might be a doctor: a doctor sees only
// documents present in their active SessionAccessGrant (and only if the
// grant allows viewing at all), never the patient's full document set.
// Patients/admins/superadmins are unaffected — their access is already
// enforced upstream by checkSession's identity/role check.
export const filterDocumentsForRequester = (req, docs) => {
  const role = String(req.auth?.role || "").toLowerCase();
  if (PRIVILEGED_ROLES.has(role)) return docs;
  if (role === "patient") return docs;
  if (role === "doctor") {
    const grant = req.sessionAccessGrant;
    if (!grant || grant.capabilities?.canViewDocuments !== true) return [];
    return docs.filter((doc) => grantAllowsDocument(grant, doc._id));
  }
  return [];
};

// Same rule, applied to structured (non-document) health data scopes. A
// doctor may only read a structured-data section if it is present in their
// active grant's structuredDataScopes.
export const grantAllowsStructuredData = (req, scope) => {
  const role = String(req.auth?.role || "").toLowerCase();
  if (PRIVILEGED_ROLES.has(role)) return true;
  if (role === "patient") return true;
  if (role === "doctor") {
    const grant = req.sessionAccessGrant;
    return !!grant && grant.structuredDataScopes.includes(scope);
  }
  return false;
};

// Keeps an existing session's expiry in sync when the session itself is
// extended, without touching any previously-granted scope — extension must
// never silently expand what was shared.
export const syncGrantExpiry = async ({ sessionId, expiresAt }) => {
  await SessionAccessGrant.updateOne(
    { sessionId: asObjectId(sessionId), status: "active" },
    { $set: { expiresAt }, $inc: { version: 1 } }
  );
};

export const revokeGrant = async ({ sessionId, revokedBy }) => {
  const grant = await SessionAccessGrant.findOneAndUpdate(
    { sessionId: asObjectId(sessionId), status: "active" },
    { $set: { status: "revoked", revokedAt: new Date(), revokedBy: asObjectId(revokedBy) }, $inc: { version: 1 } },
    { new: true }
  );
  return grant;
};
