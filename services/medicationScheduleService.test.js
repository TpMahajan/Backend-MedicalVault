import { jest } from "@jest/globals";

const bulkWrite = jest.fn(async (operations) => ({ upsertedCount: operations.length }));
const updateMany = jest.fn(async () => ({ modifiedCount: 1 }));

await jest.unstable_mockModule("../models/MedicationDoseEvent.js", () => ({
  MedicationDoseEvent: { bulkWrite, updateMany },
}));

const {
  buildDoseEventCandidates,
  generateRollingDoseEvents,
  localDateTimeParts,
  validateMedicationScheduleInput,
  zonedDateTimeToUtc,
} = await import("./medicationScheduleService.js");

const schedule = (overrides = {}) => ({
  _id: "schedule-1",
  medicationOrderId: "order-1",
  patientProfileId: "profile-1",
  status: "active",
  scheduleType: "twice_daily",
  localTimes: ["08:00", "20:00"],
  weekdays: [],
  intervalHours: null,
  timezone: "Asia/Kolkata",
  activeStartDate: new Date("2026-07-14T00:00:00.000Z"),
  activeEndDate: null,
  ...overrides,
});

describe("medication schedule service", () => {
  beforeEach(() => jest.clearAllMocks());

  it("stores a profile-local 20:00 Asia/Kolkata dose as the correct UTC instant", () => {
    const instant = zonedDateTimeToUtc("2026-07-14", "20:00", "Asia/Kolkata");
    expect(instant.toISOString()).toBe("2026-07-14T14:30:00.000Z");
    expect(localDateTimeParts(instant, "Asia/Kolkata")).toEqual({
      year: 2026, month: 7, day: 14, hour: 20, minute: 0, second: 0,
    });
  });

  it("creates exactly one candidate per exact local time and never uses server-local time", () => {
    const events = buildDoseEventCandidates({
      schedule: schedule(),
      now: new Date("2026-07-14T00:00:00.000Z"),
      days: 2,
    });
    expect(events).toHaveLength(4);
    expect(events.map((event) => event.originalLocalTime)).toEqual(["08:00", "20:00", "08:00", "20:00"]);
    expect(events.every((event) => event.scheduleTimezone === "Asia/Kolkata")).toBe(true);
  });

  it("uses a durable schedule/instant upsert key for rolling generation", async () => {
    const outcome = await generateRollingDoseEvents({
      schedule: schedule(),
      now: new Date("2026-07-14T00:00:00.000Z"),
      days: 1,
    });
    expect(outcome).toEqual({ generated: 2, candidates: 2 });
    expect(bulkWrite).toHaveBeenCalledTimes(1);
    const operations = bulkWrite.mock.calls[0][0];
    expect(operations).toHaveLength(2);
    expect(operations[0].updateOne.filter).toEqual({
      medicationScheduleId: "schedule-1",
      scheduledAt: expect.any(Date),
    });
  });

  it("rejects an imprecise schedule without exact local times", () => {
    const fields = validateMedicationScheduleInput({
      scheduleType: "once_daily",
      localTimes: ["morning"],
      timezone: "Asia/Kolkata",
    });
    expect(fields.localTimes).toBeTruthy();
  });

  it("requires the exact number of local times for daily frequency choices", () => {
    expect(validateMedicationScheduleInput({
      scheduleType: "twice_daily",
      localTimes: ["08:00"],
      timezone: "Asia/Kolkata",
    }).localTimes).toContain("two times");
    expect(validateMedicationScheduleInput({
      scheduleType: "three_times_daily",
      localTimes: ["08:00", "14:00"],
      timezone: "Asia/Kolkata",
    }).localTimes).toContain("three times");
    expect(validateMedicationScheduleInput({
      scheduleType: "twice_daily",
      localTimes: ["08:00", "20:00"],
      timezone: "Asia/Kolkata",
    }).localTimes).toBeUndefined();
  });
});
