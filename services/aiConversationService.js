import { AIChat } from "../models/AIChat.js";

const DEFAULT_RETENTION_HOURS = 48;

const positiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const aiChatRetentionHours = () =>
  positiveInteger(process.env.AI_CHAT_RETENTION_HOURS, DEFAULT_RETENTION_HOURS);

export const nextAiChatExpiry = (from = new Date()) =>
  new Date(from.getTime() + aiChatRetentionHours() * 60 * 60 * 1000);

export const isAiChatExpired = (conversation, now = new Date()) => {
  const expiresAt = conversation?.expiresAt ? new Date(conversation.expiresAt) : null;
  return !expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt <= now;
};

export const activeConversationFilter = ({
  userId,
  userRole,
  patientProfileId,
  assistantType = "medical",
  now = new Date(),
}) => ({
  userId: String(userId || ""),
  userRole,
  patientProfileId,
  assistantType,
  status: "active",
  expiresAt: { $gt: now },
});

export const resolveActiveConversation = async (scope, { includeMessages = true } = {}) => {
  const now = new Date();
  const filter = activeConversationFilter({ ...scope, now });
  const query = AIChat.findOne(filter).sort({ lastActivityAt: -1, updatedAt: -1 });
  const conversation = includeMessages ? await query : await query.select("-messages");
  return conversation || null;
};

export const markConversationInactive = async ({
  conversationId,
  scope,
  status = "archived",
  now = new Date(),
}) => {
  const allowedStatuses = new Set(["archived", "cleared", "expired"]);
  const nextStatus = allowedStatuses.has(status) ? status : "archived";
  const result = await AIChat.findOneAndUpdate(
    {
      _id: conversationId,
      userId: String(scope.userId || ""),
      userRole: scope.userRole,
      patientProfileId: scope.patientProfileId,
      assistantType: scope.assistantType || "medical",
      status: "active",
    },
    { $set: { status: nextStatus, lastActivityAt: now } },
    { new: true },
  );
  return result || null;
};
