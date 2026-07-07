import { AISettings } from "../models/AISettings.js";
import { AIUsage } from "../models/AIUsage.js";

const DEFAULT_SETTINGS = {
  patientDailyMessageLimit: Number(process.env.AI_DAILY_PATIENT_MESSAGE_LIMIT || 10),
  doctorDailyMessageLimit: Number(process.env.AI_DAILY_DOCTOR_MESSAGE_LIMIT || 25),
  adminDailyMessageLimit: Number(process.env.AI_DAILY_ADMIN_MESSAGE_LIMIT || 50),
  maxInputTokensPerRequest: Number(process.env.AI_MAX_INPUT_TOKENS || 1500),
  maxOutputTokensPerRequest: Number(process.env.AI_MAX_OUTPUT_TOKENS || 700),
  maxInputChars: Number(process.env.AI_MAX_INPUT_CHARS || 6000),
  maxChatHistoryMessages: Number(process.env.AI_MAX_CHAT_HISTORY_MESSAGES || 6),
  maxDocumentsPerRequest: Number(process.env.AI_MAX_DOCUMENTS_PER_REQUEST || 3),
  allowedModels: String(process.env.AI_ALLOWED_MODELS || "gpt-4o-mini")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean),
  defaultModel: String(process.env.AI_DEFAULT_MODEL || "gpt-4o-mini").trim(),
  documentVerificationAiEnabled:
    String(process.env.AI_DOCUMENT_VERIFICATION_ENABLED || "true").toLowerCase() !== "false",
  aiAssistantEnabled:
    String(process.env.AI_ASSISTANT_ENABLED || "true").toLowerCase() !== "false",
  hardDailyTokenBudget: Number(process.env.AI_DAILY_GLOBAL_TOKEN_BUDGET || 100000),
  hardDailyCostBudget: Number(process.env.AI_DAILY_GLOBAL_COST_BUDGET || 10),
};

const normalizeRole = (role) => String(role || "patient").trim().toLowerCase();

export const getDateKey = (date = new Date()) => date.toISOString().slice(0, 10);

export const getResetAt = (date = new Date()) => {
  const reset = new Date(date);
  reset.setUTCHours(24, 0, 0, 0);
  return reset;
};

export const estimateTokensFromText = (text = "") =>
  Math.ceil(String(text || "").length / 4);

export const estimateAiCost = ({ inputTokens = 0, outputTokens = 0 } = {}) =>
  Number(((inputTokens * 0.00000015) + (outputTokens * 0.0000006)).toFixed(6));

export const getAISettings = async () => {
  const settings = await AISettings.findOneAndUpdate(
    { key: "GLOBAL" },
    { $setOnInsert: { key: "GLOBAL", ...DEFAULT_SETTINGS } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
};

const limitForRole = (settings, role) => {
  const normalized = normalizeRole(role);
  if (normalized === "patient") return Number(settings.patientDailyMessageLimit);
  if (normalized === "doctor") return Number(settings.doctorDailyMessageLimit);
  if (normalized === "admin" || normalized === "superadmin") {
    return Number(settings.adminDailyMessageLimit);
  }
  return Number(settings.patientDailyMessageLimit);
};

export const summarizeAIUsage = async ({ dateKey = getDateKey() } = {}) => {
  const rows = await AIUsage.find({ dateKey }).lean();
  const totals = rows.reduce(
    (acc, row) => {
      acc.messages += Number(row.messageCount || 0);
      acc.inputTokens += Number(row.tokenInputCount || 0);
      acc.outputTokens += Number(row.tokenOutputCount || 0);
      acc.estimatedCost += Number(row.estimatedCost || 0);
      acc.byEndpoint[row.endpoint || "unknown"] =
        (acc.byEndpoint[row.endpoint || "unknown"] || 0) +
        Number(row.messageCount || 0);
      return acc;
    },
    { messages: 0, inputTokens: 0, outputTokens: 0, estimatedCost: 0, byEndpoint: {} },
  );

  totals.estimatedCost = Number(totals.estimatedCost.toFixed(6));
  return { dateKey, totals, rows };
};

export const assertAIUsageAllowed = async ({
  userId,
  role,
  endpoint = "ai.ask",
  inputText = "",
} = {}) => {
  const settings = await getAISettings();
  if (!settings.aiAssistantEnabled && endpoint.startsWith("ai.")) {
    const error = new Error("AI assistant is currently disabled.");
    error.statusCode = 503;
    error.code = "AI_ASSISTANT_DISABLED";
    throw error;
  }

  const maxInputChars = Number(settings.maxInputChars || DEFAULT_SETTINGS.maxInputChars);
  if (String(inputText || "").length > maxInputChars) {
    const error = new Error(`Please keep AI requests under ${maxInputChars} characters.`);
    error.statusCode = 400;
    error.code = "AI_INPUT_TOO_LARGE";
    throw error;
  }

  const dateKey = getDateKey();
  const resetAt = getResetAt();
  const normalizedRole = normalizeRole(role);
  const usage = await AIUsage.findOne({
    userId: String(userId || ""),
    role: normalizedRole,
    dateKey,
    endpoint,
  }).lean();

  const limit = limitForRole(settings, normalizedRole);
  const used = Number(usage?.messageCount || 0);
  if (limit > 0 && used >= limit) {
    const error = new Error(
      `You have used your ${limit} AI messages for today. Please try again tomorrow.`,
    );
    error.statusCode = 429;
    error.code = "AI_DAILY_LIMIT_REACHED";
    error.limit = limit;
    error.used = used;
    error.resetAt = resetAt;
    throw error;
  }

  const summary = await summarizeAIUsage({ dateKey });
  const totalTokens =
    Number(summary.totals.inputTokens || 0) + Number(summary.totals.outputTokens || 0);
  if (
    Number(settings.hardDailyTokenBudget || 0) > 0 &&
    totalTokens >= Number(settings.hardDailyTokenBudget)
  ) {
    const error = new Error("Daily AI token budget has been reached.");
    error.statusCode = 429;
    error.code = "AI_GLOBAL_TOKEN_BUDGET_REACHED";
    throw error;
  }
  if (
    Number(settings.hardDailyCostBudget || 0) > 0 &&
    Number(summary.totals.estimatedCost || 0) >= Number(settings.hardDailyCostBudget)
  ) {
    const error = new Error("Daily AI cost budget has been reached.");
    error.statusCode = 429;
    error.code = "AI_GLOBAL_COST_BUDGET_REACHED";
    throw error;
  }

  return { settings, usage, limit, used, resetAt };
};

export const recordAIUsage = async ({
  userId,
  role,
  endpoint = "ai.ask",
  inputTokens = 0,
  outputTokens = 0,
  estimatedCost,
} = {}) => {
  const dateKey = getDateKey();
  const resetAt = getResetAt();
  const normalizedRole = normalizeRole(role);
  const resolvedCost =
    estimatedCost ?? estimateAiCost({ inputTokens, outputTokens });

  return AIUsage.findOneAndUpdate(
    {
      userId: String(userId || ""),
      role: normalizedRole,
      dateKey,
      endpoint,
    },
    {
      $inc: {
        messageCount: 1,
        tokenInputCount: Math.max(0, Math.round(inputTokens)),
        tokenOutputCount: Math.max(0, Math.round(outputTokens)),
        estimatedCost: resolvedCost,
      },
      $setOnInsert: { resetAt },
    },
    { upsert: true, new: true },
  );
};
