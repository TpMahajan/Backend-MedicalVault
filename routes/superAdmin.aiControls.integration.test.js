import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const state = {
  settings: {
    key: "GLOBAL",
    aiAssistantEnabled: true,
    documentVerificationAiEnabled: true,
    patientDailyMessageLimit: 10,
    doctorDailyMessageLimit: 25,
    adminDailyMessageLimit: 50,
    maxInputChars: 6000,
    maxOutputTokens: 700,
    maxChatHistoryMessages: 6,
    maxDocumentsPerRequest: 3,
    allowedModels: ["gpt-4o-mini"],
    defaultModel: "gpt-4o-mini",
    hardDailyTokenBudget: 100000,
    hardDailyCostBudget: 10,
  },
  usageRows: [
    {
      _id: { userId: "patient-1", role: "patient" },
      messages: 10,
      inputTokens: 1200,
      outputTokens: 700,
      estimatedCost: 0.0123456,
    },
  ],
};

const requireSuperAdminAuthMock = jest.fn((req, _res, next) => {
  req.auth = { id: "superadmin@example.com", email: "superadmin@example.com" };
  req.superAdmin = { email: "superadmin@example.com" };
  next();
});

const writeAuditLogMock = jest.fn(async () => {});
const getAISettingsMock = jest.fn(async () => state.settings);
const getDateKeyMock = jest.fn(() => "2026-07-07");
const summarizeAIUsageMock = jest.fn(async ({ dateKey } = {}) => ({
  dateKey: dateKey || "2026-07-07",
  totals: {
    messages: 12,
    inputTokens: 1500,
    outputTokens: 850,
    totalTokens: 2350,
    estimatedCost: 0.017,
  },
  byEndpoint: [{ endpoint: "ai.ask", messages: 10 }],
  byRole: [{ role: "patient", messages: 10 }],
}));

const aiSettingsFindOneAndUpdateMock = jest.fn((_filter, update) => {
  state.settings = {
    ...state.settings,
    ...(update?.$set || {}),
  };
  return { lean: async () => state.settings };
});

const aiUsageAggregateMock = jest.fn(async () => state.usageRows);

await jest.unstable_mockModule("../middleware/superAdminAuth.js", () => ({
  requireSuperAdminAuth: requireSuperAdminAuthMock,
}));

await jest.unstable_mockModule("../middleware/auditLogger.js", () => ({
  writeAuditLog: writeAuditLogMock,
}));

await jest.unstable_mockModule("../services/aiGovernance.js", () => ({
  getAISettings: getAISettingsMock,
  getDateKey: getDateKeyMock,
  summarizeAIUsage: summarizeAIUsageMock,
}));

await jest.unstable_mockModule("../models/AISettings.js", () => ({
  AISettings: {
    findOneAndUpdate: aiSettingsFindOneAndUpdateMock,
  },
}));

await jest.unstable_mockModule("../models/AIUsage.js", () => ({
  AIUsage: {
    aggregate: aiUsageAggregateMock,
  },
}));

await jest.unstable_mockModule("../config/firebase.js", () => ({
  initializeFirebase: jest.fn(),
  sendPushNotification: jest.fn(),
}));

const { default: superAdminRouter } = await import("./superAdmin.js");

const app = express();
app.use(express.json());
app.use("/api/superadmin", superAdminRouter);

describe("superadmin AI controls", () => {
  beforeEach(() => {
    state.settings = {
      key: "GLOBAL",
      aiAssistantEnabled: true,
      documentVerificationAiEnabled: true,
      patientDailyMessageLimit: 10,
      doctorDailyMessageLimit: 25,
      adminDailyMessageLimit: 50,
      maxInputChars: 6000,
      maxOutputTokens: 700,
      maxChatHistoryMessages: 6,
      maxDocumentsPerRequest: 3,
      allowedModels: ["gpt-4o-mini"],
      defaultModel: "gpt-4o-mini",
      hardDailyTokenBudget: 100000,
      hardDailyCostBudget: 10,
    };
    writeAuditLogMock.mockClear();
    getAISettingsMock.mockClear();
    summarizeAIUsageMock.mockClear();
    aiSettingsFindOneAndUpdateMock.mockClear();
    aiUsageAggregateMock.mockClear();
  });

  it("returns editable AI settings", async () => {
    const res = await request(app).get("/api/superadmin/ai-settings");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.settings.patientDailyMessageLimit).toBe(10);
    expect(res.body.settings.allowedModels).toEqual(["gpt-4o-mini"]);
  });

  it("updates patient limits and writes an audit log", async () => {
    const res = await request(app)
      .put("/api/superadmin/ai-settings")
      .send({
        patientDailyMessageLimit: 15,
        aiAssistantEnabled: false,
        allowedModels: "gpt-4o-mini,gpt-4.1-mini",
        defaultModel: "gpt-4.1-mini",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.settings.patientDailyMessageLimit).toBe(15);
    expect(res.body.settings.aiAssistantEnabled).toBe(false);
    expect(res.body.settings.allowedModels).toEqual([
      "gpt-4o-mini",
      "gpt-4.1-mini",
    ]);
    expect(res.body.settings.defaultModel).toBe("gpt-4.1-mini");
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "UPDATE_AI_SETTINGS",
        resourceType: "AI_SETTINGS",
      }),
    );
  });

  it("returns usage summary and top users", async () => {
    const summary = await request(app).get("/api/superadmin/ai-usage-summary");
    expect(summary.status).toBe(200);
    expect(summary.body.totals.messages).toBe(12);
    expect(summarizeAIUsageMock).toHaveBeenCalledWith({ dateKey: "2026-07-07" });

    const users = await request(app).get("/api/superadmin/ai-usage-users");
    expect(users.status).toBe(200);
    expect(users.body.users).toEqual([
      {
        userId: "patient-1",
        role: "patient",
        messages: 10,
        inputTokens: 1200,
        outputTokens: 700,
        estimatedCost: 0.012346,
      },
    ]);
    expect(aiUsageAggregateMock).toHaveBeenCalled();
  });
});
