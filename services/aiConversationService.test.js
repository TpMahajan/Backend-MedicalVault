import { describe, expect, it } from "@jest/globals";
import {
  activeConversationFilter,
  aiChatRetentionHours,
  isAiChatExpired,
  nextAiChatExpiry,
} from "./aiConversationService.js";

describe("aiConversationService", () => {
  it("uses a 48-hour retention period by default", () => {
    const previous = process.env.AI_CHAT_RETENTION_HOURS;
    delete process.env.AI_CHAT_RETENTION_HOURS;
    const from = new Date("2026-07-10T10:00:00.000Z");
    expect(aiChatRetentionHours()).toBe(48);
    expect(nextAiChatExpiry(from).toISOString()).toBe("2026-07-12T10:00:00.000Z");
    if (previous) process.env.AI_CHAT_RETENTION_HOURS = previous;
  });

  it("treats elapsed expiry as expired even before MongoDB TTL deletion", () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    expect(isAiChatExpired({ expiresAt: new Date("2026-07-10T09:59:59.000Z") }, now)).toBe(true);
    expect(isAiChatExpired({ expiresAt: new Date("2026-07-10T10:00:01.000Z") }, now)).toBe(false);
  });

  it("filters active conversations by account, patient profile, assistant type, and expiry", () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    expect(activeConversationFilter({
      userId: "user-1",
      userRole: "patient",
      patientProfileId: "64b1234567890abcdef12345",
      now,
    })).toEqual({
      userId: "user-1",
      userRole: "patient",
      patientProfileId: "64b1234567890abcdef12345",
      assistantType: "medical",
      status: "active",
      expiresAt: { $gt: now },
    });
  });
});
