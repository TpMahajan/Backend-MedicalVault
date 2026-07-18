import { jest } from "@jest/globals";

const PATIENT_ID = "507f1f77bcf86cd799439011";
const DOCTOR_ID = "507f1f77bcf86cd799439012";
const SESSION_ID = "507f1f77bcf86cd799439013";
const DOC_REPORT_1 = "507f1f77bcf86cd799439021";
const DOC_REPORT_2 = "507f1f77bcf86cd799439022";
const DOC_BILL_1 = "507f1f77bcf86cd799439023";

const preferenceState = { record: null };
const grantState = { record: null };

const preferenceFindOneMock = jest.fn(async () => preferenceState.record);
const preferenceFindOneAndUpdateMock = jest.fn(async (filter, update) => {
  const current = preferenceState.record || {
    patientId: PATIENT_ID,
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
    version: 1,
  };
  const next = {
    ...current,
    ...update.$set,
    version: current.version + (update.$inc?.version || 0),
  };
  preferenceState.record = next;
  return next;
});

const documentFindMock = jest.fn(async () => [
  { _id: DOC_REPORT_1, category: "Report", title: "Report 1", createdAt: new Date("2026-01-01") },
  { _id: DOC_REPORT_2, category: "Report", title: "Report 2", createdAt: new Date("2026-01-02") },
  { _id: DOC_BILL_1, category: "Bill", title: "Bill 1", createdAt: new Date("2026-01-03") },
]);

const grantFindOneAndUpdateMock = jest.fn(async (filter, update) => {
  const current = grantState.record || { version: 0 };
  const next = {
    _id: "grant-1",
    sessionId: SESSION_ID,
    ...current,
    ...update.$set,
    version: (current.version || 0) + (update.$inc?.version || 0),
    save: jest.fn(async function save() {
      grantState.record = this;
      return this;
    }),
  };
  grantState.record = next;
  return next;
});

const grantFindOneMock = jest.fn(async () => grantState.record);

await jest.unstable_mockModule("../models/PatientSessionSharingPreference.js", () => ({
  PatientSessionSharingPreference: {
    findOne: (...args) => ({ lean: async () => preferenceFindOneMock(...args) }),
    findOneAndUpdate: (...args) => ({ lean: async () => preferenceFindOneAndUpdateMock(...args) }),
  },
}));
await jest.unstable_mockModule("../models/File.js", () => ({
  Document: {
    find: (...args) => ({
      select: () => ({
        sort: () => ({ lean: async () => documentFindMock(...args) }),
        lean: async () => documentFindMock(...args),
      }),
      lean: async () => documentFindMock(...args),
    }),
  },
}));
await jest.unstable_mockModule("../models/SessionAccessGrant.js", () => ({
  SessionAccessGrant: {
    findOneAndUpdate: grantFindOneAndUpdateMock,
    findOne: grantFindOneMock,
    updateOne: jest.fn(async () => ({ modifiedCount: 1 })),
  },
}));

const {
  getSharingPreferences,
  updateSharingPreferences,
  buildApprovalPreview,
  materializeGrantForSession,
  resolveActiveGrant,
  grantAllowsDocument,
  filterDocumentsForRequester,
  grantAllowsStructuredData,
  DOCUMENT_CATEGORIES,
  STRUCTURED_DATA_SCOPES,
} = await import("./sessionAccessGrantService.js");

beforeEach(() => {
  preferenceState.record = null;
  grantState.record = null;
  jest.clearAllMocks();
});

describe("getSharingPreferences", () => {
  it("returns product defaults when the patient has never saved preferences", async () => {
    const prefs = await getSharingPreferences(PATIENT_ID);
    expect(prefs.isDefault).toBe(true);
    expect(prefs.categoryDefaults.Report).toBe("ask");
    expect(prefs.categoryDefaults.Bill).toBe("deny");
    expect(prefs.capabilities.allowDoctorDownload).toBe(false);
  });

  it("returns the saved record once the patient has customized it", async () => {
    preferenceState.record = {
      categoryDefaults: { Report: "share", Prescription: "ask", Bill: "deny", Insurance: "deny" },
      structuredDataDefaults: {
        profile: true,
        allergies: false,
        conditions: false,
        medications: false,
        appointments: false,
        emergencyInformation: true,
      },
      capabilities: { allowDoctorDownload: true, allowDoctorUploadToPatient: false },
      version: 3,
    };
    const prefs = await getSharingPreferences(PATIENT_ID);
    expect(prefs.isDefault).toBe(false);
    expect(prefs.categoryDefaults.Report).toBe("share");
    expect(prefs.capabilities.allowDoctorDownload).toBe(true);
  });
});

describe("updateSharingPreferences", () => {
  it("merges a partial patch onto existing defaults rather than replacing the whole document", async () => {
    const updated = await updateSharingPreferences(PATIENT_ID, {
      categoryDefaults: { Report: "share" },
    });
    expect(updated.categoryDefaults.Report).toBe("share");
    // Untouched categories keep their defaults.
    expect(updated.categoryDefaults.Bill).toBe("deny");
  });
});

describe("buildApprovalPreview", () => {
  it("lists every real document category with correct counts and documents", async () => {
    const preview = await buildApprovalPreview({ patientId: PATIENT_ID });
    const reportCategory = preview.categories.find((c) => c.category === "Report");
    const billCategory = preview.categories.find((c) => c.category === "Bill");
    expect(reportCategory.documentCount).toBe(2);
    expect(billCategory.documentCount).toBe(1);
    expect(preview.categories.map((c) => c.category)).toEqual(DOCUMENT_CATEGORIES);
  });

  it("pre-selects documents in a category only when its default is 'share'", async () => {
    preferenceState.record = {
      categoryDefaults: { Report: "share", Prescription: "ask", Bill: "deny", Insurance: "deny" },
      structuredDataDefaults: {},
      capabilities: {},
      version: 1,
    };
    const preview = await buildApprovalPreview({ patientId: PATIENT_ID });
    const reportCategory = preview.categories.find((c) => c.category === "Report");
    const billCategory = preview.categories.find((c) => c.category === "Bill");
    expect(reportCategory.preselectedDocumentIds).toEqual([DOC_REPORT_1, DOC_REPORT_2]);
    expect(billCategory.preselectedDocumentIds).toEqual([]);
  });
});

describe("materializeGrantForSession", () => {
  const session = { _id: SESSION_ID, doctorId: DOCTOR_ID, patientId: PATIENT_ID, expiresAt: new Date(Date.now() + 20 * 60 * 1000) };

  it("materializes exactly the patient's explicit document selection, not a live category query", async () => {
    const grant = await materializeGrantForSession({
      session,
      selection: {
        selectedDocumentIds: [DOC_REPORT_1],
        selectedCategories: ["Report"],
        structuredDataScopes: ["allergies"],
        capabilities: { allowDoctorDownload: true, allowDoctorUploadToPatient: false },
      },
    });
    expect(grant.selectedDocumentIds.map(String)).toEqual([DOC_REPORT_1]);
    expect(grant.structuredDataScopes).toEqual(["allergies"]);
    expect(grant.capabilities.canDownloadDocuments).toBe(true);
    expect(grant.capabilities.canUploadDocuments).toBe(false);
    expect(grant.capabilities.canViewDocuments).toBe(true);
  });

  it("falls back to saved category defaults when no explicit selection is supplied", async () => {
    preferenceState.record = {
      categoryDefaults: { Report: "share", Prescription: "ask", Bill: "deny", Insurance: "deny" },
      structuredDataDefaults: {
        profile: true,
        allergies: true,
        conditions: false,
        medications: false,
        appointments: false,
        emergencyInformation: false,
      },
      capabilities: { allowDoctorDownload: false, allowDoctorUploadToPatient: true },
      version: 2,
    };
    const grant = await materializeGrantForSession({ session, selection: {} });
    expect(grant.selectedDocumentIds.map(String).sort()).toEqual([DOC_REPORT_1, DOC_REPORT_2].sort());
    expect(grant.structuredDataScopes.sort()).toEqual(["allergies", "profile"].sort());
  });

  it("saves the selection as the new default only when saveAsDefault is explicitly true", async () => {
    await materializeGrantForSession({
      session,
      selection: {
        selectedDocumentIds: [DOC_REPORT_1],
        structuredDataScopes: ["allergies"],
        capabilities: { allowDoctorDownload: true, allowDoctorUploadToPatient: true },
        saveAsDefault: true,
        categoryDefaultsToSave: { Report: "share" },
      },
    });
    expect(preferenceFindOneAndUpdateMock).toHaveBeenCalled();
  });

  it("does not touch saved defaults when saveAsDefault is omitted (the common case)", async () => {
    await materializeGrantForSession({
      session,
      selection: { selectedDocumentIds: [DOC_REPORT_1] },
    });
    expect(preferenceFindOneAndUpdateMock).not.toHaveBeenCalled();
  });

  it("never includes structured-data scopes outside the real product list", async () => {
    const grant = await materializeGrantForSession({
      session,
      selection: { selectedDocumentIds: [], structuredDataScopes: ["allergies", "not_a_real_scope"] },
    });
    expect(grant.structuredDataScopes).toEqual(["allergies"]);
  });
});

describe("resolveActiveGrant", () => {
  it("returns null when no grant exists for this session", async () => {
    grantState.record = null;
    const grant = await resolveActiveGrant({ sessionId: SESSION_ID, doctorId: DOCTOR_ID, patientId: PATIENT_ID });
    expect(grant).toBeNull();
  });

  it("returns null when the grant has been revoked", async () => {
    grantState.record = { status: "revoked", expiresAt: new Date(Date.now() + 60000) };
    const grant = await resolveActiveGrant({ sessionId: SESSION_ID, doctorId: DOCTOR_ID, patientId: PATIENT_ID });
    expect(grant).toBeNull();
  });

  it("returns null and flips status to expired when past expiresAt, without requiring a separate cron sweep", async () => {
    const save = jest.fn(async function () { return this; });
    grantState.record = { status: "active", expiresAt: new Date(Date.now() - 1000), save };
    const grant = await resolveActiveGrant({ sessionId: SESSION_ID, doctorId: DOCTOR_ID, patientId: PATIENT_ID });
    expect(grant).toBeNull();
    expect(save).toHaveBeenCalled();
    expect(grantState.record.status).toBe("expired");
  });

  it("returns the grant when active and not expired", async () => {
    grantState.record = { status: "active", expiresAt: new Date(Date.now() + 60000) };
    const grant = await resolveActiveGrant({ sessionId: SESSION_ID, doctorId: DOCTOR_ID, patientId: PATIENT_ID });
    expect(grant).not.toBeNull();
  });
});

describe("grantAllowsDocument", () => {
  it("returns false for a null grant (fail closed)", () => {
    expect(grantAllowsDocument(null, DOC_REPORT_1)).toBe(false);
  });

  it("returns true only for a document id present in the grant", () => {
    const grant = { selectedDocumentIds: [DOC_REPORT_1] };
    expect(grantAllowsDocument(grant, DOC_REPORT_1)).toBe(true);
    expect(grantAllowsDocument(grant, DOC_REPORT_2)).toBe(false);
  });
});

describe("filterDocumentsForRequester", () => {
  const docs = [{ _id: DOC_REPORT_1 }, { _id: DOC_REPORT_2 }, { _id: DOC_BILL_1 }];

  it("returns the full list unfiltered for a patient (ownership already enforced upstream)", () => {
    const req = { auth: { role: "patient" } };
    expect(filterDocumentsForRequester(req, docs)).toBe(docs);
  });

  it("returns the full list unfiltered for admin/superadmin", () => {
    expect(filterDocumentsForRequester({ auth: { role: "admin" } }, docs)).toBe(docs);
    expect(filterDocumentsForRequester({ auth: { role: "superadmin" } }, docs)).toBe(docs);
  });

  it("returns nothing for a doctor with no active grant on the request", () => {
    const req = { auth: { role: "doctor" } };
    expect(filterDocumentsForRequester(req, docs)).toEqual([]);
  });

  it("returns nothing for a doctor whose grant has canViewDocuments=false", () => {
    const req = {
      auth: { role: "doctor" },
      sessionAccessGrant: { capabilities: { canViewDocuments: false }, selectedDocumentIds: [DOC_REPORT_1] },
    };
    expect(filterDocumentsForRequester(req, docs)).toEqual([]);
  });

  it("returns only the grant-selected documents for an authorized doctor", () => {
    const req = {
      auth: { role: "doctor" },
      sessionAccessGrant: {
        capabilities: { canViewDocuments: true },
        selectedDocumentIds: [DOC_REPORT_1],
      },
    };
    expect(filterDocumentsForRequester(req, docs)).toEqual([{ _id: DOC_REPORT_1 }]);
  });

  it("never leaks a document the doctor can guess the id of but was not granted", () => {
    const req = {
      auth: { role: "doctor" },
      sessionAccessGrant: { capabilities: { canViewDocuments: true }, selectedDocumentIds: [] },
    };
    // A doctor requesting a list that happens to include a document they
    // were never granted must not see it, even if it's technically in the
    // same patient's document set.
    expect(filterDocumentsForRequester(req, docs)).toEqual([]);
  });
});

describe("grantAllowsStructuredData", () => {
  it("allows a patient full access to their own structured data", () => {
    expect(grantAllowsStructuredData({ auth: { role: "patient" } }, "allergies")).toBe(true);
  });

  it("denies a doctor with no grant", () => {
    expect(grantAllowsStructuredData({ auth: { role: "doctor" } }, "allergies")).toBe(false);
  });

  it("allows a doctor only for scopes present in their active grant", () => {
    const req = { auth: { role: "doctor" }, sessionAccessGrant: { structuredDataScopes: ["allergies"] } };
    expect(grantAllowsStructuredData(req, "allergies")).toBe(true);
    expect(grantAllowsStructuredData(req, "medications")).toBe(false);
  });
});

describe("STRUCTURED_DATA_SCOPES / DOCUMENT_CATEGORIES", () => {
  it("only names scopes/categories that map to real product fields", () => {
    // Regression guard: these lists are the security boundary for what a
    // doctor may ever be granted, so accidental additions here are a real
    // vulnerability, not just a display bug.
    expect(DOCUMENT_CATEGORIES).toEqual(["Report", "Prescription", "Bill", "Insurance"]);
    expect(STRUCTURED_DATA_SCOPES).toEqual([
      "profile",
      "allergies",
      "conditions",
      "medications",
      "appointments",
      "emergencyInformation",
    ]);
  });
});
