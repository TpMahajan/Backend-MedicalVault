import { MedicationDoseEvent } from "../models/MedicationDoseEvent.js";

export const ROLLING_DOSE_EVENT_DAYS = 14;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isValidIanaTimezone = (timezone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch (_) {
    return false;
  }
};

const formatterFor = (timezone) => new Intl.DateTimeFormat("en-CA", {
  timeZone: timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const partsFor = (date, timezone) => Object.fromEntries(
  formatterFor(timezone).formatToParts(date)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]),
);

export const localDateTimeParts = (date, timezone) => {
  const parts = partsFor(date, timezone);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second || 0),
  };
};

export const localDateFor = (date, timezone) => {
  const parts = localDateTimeParts(date, timezone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
};

export const addLocalDays = (date, days) => {
  const [year, month, day] = String(date).split("-").map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return result.toISOString().slice(0, 10);
};

const weekdayFor = (date) => {
  const [year, month, day] = String(date).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
};

const localTimeParts = (time) => {
  const [hour, minute] = String(time).split(":").map(Number);
  return { hour, minute };
};

// Resolve a wall-clock date/time in a named IANA zone to its UTC instant.
// Iterating the Intl-derived offset avoids server locale and fixed-offset bugs.
export const zonedDateTimeToUtc = (date, time, timezone) => {
  const [year, month, day] = String(date).split("-").map(Number);
  const { hour, minute } = localTimeParts(time);
  const intended = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = intended;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = localDateTimeParts(new Date(guess), timezone);
    const observedAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const next = intended - (observedAsUtc - guess);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
};

const dateOnly = (value) => value instanceof Date
  ? value.toISOString().slice(0, 10)
  : String(value || "").slice(0, 10);

const sameOrAfter = (left, right) => left >= right;
const sameOrBefore = (left, right) => left <= right;

export const validateMedicationScheduleInput = (input = {}) => {
  const fields = {};
  const type = String(input.scheduleType || "");
  const localTimes = Array.isArray(input.localTimes) ? input.localTimes : [];
  if (!type) fields.scheduleType = "Select a frequency.";
  if (type !== "as_needed" && (!localTimes.length || localTimes.some((time) => !TIME.test(String(time))))) {
    fields.localTimes = "Use one or more exact local times in HH:mm format.";
  }
  if (type === "once_daily" && localTimes.length !== 1) fields.localTimes = "Once daily requires one time.";
  if (type === "twice_daily" && localTimes.length !== 2) fields.localTimes = "Twice daily requires two times.";
  if (type === "three_times_daily" && localTimes.length !== 3) fields.localTimes = "Three times daily requires three times.";
  if (["specific_weekdays", "weekly"].includes(type)
    && (!Array.isArray(input.weekdays) || !input.weekdays.length || input.weekdays.some((day) => !Number.isInteger(Number(day)) || Number(day) < 0 || Number(day) > 6))) {
    fields.weekdays = "Select one or more weekdays.";
  }
  if (type === "every_x_hours" && (!Number.isFinite(Number(input.intervalHours)) || Number(input.intervalHours) < 1 || Number(input.intervalHours) > 720)) {
    fields.intervalHours = "Enter an interval between 1 and 720 hours.";
  }
  if (!isValidIanaTimezone(input.timezone)) fields.timezone = "Choose a valid IANA timezone.";
  return fields;
};

const dateMatchesSchedule = ({ schedule, date, startDate }) => {
  const type = schedule.scheduleType;
  if (["once_daily", "twice_daily", "three_times_daily", "specific_times", "custom"].includes(type)) return true;
  if (["specific_weekdays", "weekly"].includes(type)) return (schedule.weekdays || []).map(Number).includes(weekdayFor(date));
  if (type === "alternate_days") {
    const start = Date.parse(`${startDate}T00:00:00.000Z`);
    const current = Date.parse(`${date}T00:00:00.000Z`);
    return Math.floor((current - start) / 86400000) % 2 === 0;
  }
  return false;
};

const eventCandidate = ({ schedule, medicationOrderId, patientProfileId, localDate, localTime, timezone }) => ({
  medicationOrderId,
  medicationScheduleId: schedule._id,
  patientProfileId,
  scheduledAt: zonedDateTimeToUtc(localDate, localTime, timezone),
  originalLocalDate: localDate,
  originalLocalTime: localTime,
  scheduleTimezone: timezone,
  status: "pending",
  audit: [{ action: "generated", at: new Date(), details: { source: "rolling_window" } }],
});

const intervalCandidates = ({ schedule, medicationOrderId, patientProfileId, startDate, endDate, timezone }) => {
  const anchorTime = schedule.localTimes?.[0] || "08:00";
  const anchor = zonedDateTimeToUtc(startDate, anchorTime, timezone);
  const interval = Number(schedule.intervalHours) * 60 * 60 * 1000;
  const first = zonedDateTimeToUtc(startDate, "00:00", timezone);
  const end = zonedDateTimeToUtc(endDate, "23:59", timezone);
  const result = [];
  for (let at = anchor.getTime(); at <= end.getTime(); at += interval) {
    if (at < first.getTime()) continue;
    const local = localDateTimeParts(new Date(at), timezone);
    const localDate = `${String(local.year).padStart(4, "0")}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
    const localTime = `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`;
    result.push(eventCandidate({ schedule, medicationOrderId, patientProfileId, localDate, localTime, timezone }));
  }
  return result;
};

export const buildDoseEventCandidates = ({ schedule, medicationOrderId, patientProfileId, now = new Date(), days = ROLLING_DOSE_EVENT_DAYS }) => {
  if (schedule.status !== "active" || schedule.scheduleType === "as_needed") return [];
  const timezone = schedule.timezone;
  const startDate = dateOnly(schedule.activeStartDate);
  const windowStart = localDateFor(now, timezone);
  const windowEnd = addLocalDays(windowStart, Math.max(1, days) - 1);
  const endDate = schedule.activeEndDate ? dateOnly(schedule.activeEndDate) : windowEnd;
  const first = sameOrAfter(windowStart, startDate) ? windowStart : startDate;
  const last = sameOrBefore(endDate, windowEnd) ? endDate : windowEnd;
  if (!first || !last || first > last) return [];
  if (schedule.scheduleType === "every_x_hours") {
    return intervalCandidates({ schedule, medicationOrderId, patientProfileId, startDate, endDate: last, timezone })
      .filter((item) => item.scheduledAt >= zonedDateTimeToUtc(first, "00:00", timezone));
  }
  const events = [];
  for (let date = first; date <= last; date = addLocalDays(date, 1)) {
    if (!dateMatchesSchedule({ schedule, date, startDate })) continue;
    for (const time of [...new Set(schedule.localTimes || [])].sort()) {
      events.push(eventCandidate({ schedule, medicationOrderId, patientProfileId, localDate: date, localTime: time, timezone }));
    }
  }
  return events;
};

export const generateRollingDoseEvents = async ({ schedule, medicationOrderId = schedule.medicationOrderId, patientProfileId = schedule.patientProfileId, now = new Date(), days = ROLLING_DOSE_EVENT_DAYS }) => {
  const candidates = buildDoseEventCandidates({ schedule, medicationOrderId, patientProfileId, now, days });
  if (!candidates.length) return { generated: 0, candidates: 0 };
  const operations = candidates.map((candidate) => ({
    updateOne: {
      filter: { medicationScheduleId: candidate.medicationScheduleId, scheduledAt: candidate.scheduledAt },
      update: { $setOnInsert: candidate },
      upsert: true,
    },
  }));
  const result = await MedicationDoseEvent.bulkWrite(operations, { ordered: false });
  return { generated: Number(result.upsertedCount || 0), candidates: candidates.length };
};

export const cancelFuturePendingDoseEvents = async ({
  medicationScheduleId,
  from = new Date(),
  reason = "schedule_changed",
  statuses = ["pending"],
}) => MedicationDoseEvent.updateMany(
  // A schedule edit is prospective. Never rewrite a due, snoozed, missed,
  // or confirmed event because it is part of the dose history.
  { medicationScheduleId, scheduledAt: { $gt: from }, status: { $in: statuses } },
  { $set: { status: "cancelled", snoozedUntil: null }, $push: { audit: { action: "cancelled", at: new Date(), details: { reason } } } },
);
