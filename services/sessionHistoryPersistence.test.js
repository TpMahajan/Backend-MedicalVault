import { describe, expect, it, jest } from "@jest/globals";
import {
  flushDoctorActiveSessions,
  flushExpiredAcceptedSessions,
} from "./sessionHistoryPersistence.js";

describe("sessionHistoryPersistence", () => {
  it("persists session history when doctor sessions are flushed on logout", async () => {
    const now = new Date("2026-02-25T10:00:00.000Z");
    const sessionModel = {
      find: jest.fn().mockResolvedValue([
        {
          _id: "session-1",
          doctorId: "doctor-1",
          patientId: "patient-1",
          diagnosis: "Follow-up",
          notes: "Vitals stable",
        },
      ]),
      findOneAndUpdate: jest.fn().mockResolvedValue({ _id: "session-1" }),
    };

    const result = await flushDoctorActiveSessions(sessionModel, {
      doctorId: "doctor-1",
      reason: "Doctor logged out",
      now,
    });

    expect(result).toEqual({ endedCount: 1 });
    expect(sessionModel.find).toHaveBeenCalledWith({
      doctorId: "doctor-1",
      status: { $in: ["accepted", "pending"] },
      isActive: { $ne: false },
      expiresAt: { $gt: now },
    });
    expect(sessionModel.findOneAndUpdate).toHaveBeenCalledTimes(1);

    const [filter, update, options] = sessionModel.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({
      _id: "session-1",
      doctorId: "doctor-1",
      patientId: "patient-1",
    });
    expect(update.$set.status).toBe("ended");
    expect(update.$set.isActive).toBe(false);
    expect(update.$set.endedAt).toEqual(now);
    expect(update.$set.notes).toContain("Session ended automatically: Doctor logged out.");
    expect(update.$unset).toEqual({ expiresAt: 1 });
    expect(options.upsert).toBe(true);
  });

  it("persists accepted sessions when they expire", async () => {
    const now = new Date("2026-02-25T10:00:00.000Z");
    const expiredAt = new Date("2026-02-25T09:40:00.000Z");
    const sessionModel = {
      find: jest.fn().mockResolvedValue([
        {
          _id: "session-expired",
          doctorId: "doctor-1",
          patientId: "patient-1",
          diagnosis: "Cardiology review",
          notes: "Recheck in 2 weeks",
          expiresAt: expiredAt,
        },
      ]),
      findOneAndUpdate: jest.fn().mockResolvedValue({ _id: "session-expired" }),
    };

    const result = await flushExpiredAcceptedSessions(sessionModel, { now });

    expect(result).toEqual({ modifiedCount: 1 });
    expect(sessionModel.find).toHaveBeenCalledWith({
      status: "accepted",
      isActive: { $ne: false },
      expiresAt: { $lte: now },
    });

    const [, update] = sessionModel.findOneAndUpdate.mock.calls[0];
    expect(update.$set.status).toBe("ended");
    expect(update.$set.endedAt).toEqual(expiredAt);
    expect(update.$unset).toEqual({ expiresAt: 1 });
  });

  it("is idempotent when active sessions are flushed more than once", async () => {
    const now = new Date("2026-02-25T10:00:00.000Z");
    const sessionModel = {
      find: jest
        .fn()
        .mockResolvedValueOnce([
          {
            _id: "session-1",
            doctorId: "doctor-1",
            patientId: "patient-1",
            diagnosis: "",
            notes: "",
          },
        ])
        .mockResolvedValueOnce([]),
      findOneAndUpdate: jest.fn().mockResolvedValue({ _id: "session-1" }),
    };

    const firstFlush = await flushDoctorActiveSessions(sessionModel, {
      doctorId: "doctor-1",
      reason: "Doctor logged out",
      now,
    });
    const secondFlush = await flushDoctorActiveSessions(sessionModel, {
      doctorId: "doctor-1",
      reason: "Doctor logged out",
      now,
    });

    expect(firstFlush).toEqual({ endedCount: 1 });
    expect(secondFlush).toEqual({ endedCount: 0 });
    expect(sessionModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });
});

