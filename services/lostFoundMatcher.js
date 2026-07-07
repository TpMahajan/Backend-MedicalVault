import { LostPersonReport } from "../models/LostPersonReport.js";
import { FoundPersonReport } from "../models/FoundPersonReport.js";
import { LostFoundMatch } from "../models/LostFoundMatch.js";
import { compareLostFoundPhotos } from "./khojImageMatcher.js";

const LOST_RADIUS_METERS = 10000; // 10km
const TIME_WINDOW_HOURS = 48;
const MATCH_THRESHOLD = 60;
const TEXT_FIELDS = [
  "description",
  "clothingDescription",
  "identificationDetails",
  "medicalNotes",
  "condition",
];

const asText = (value) => (value == null ? "" : String(value).trim());

const normalizeGender = (value) => {
  const raw = asText(value).toLowerCase();
  if (!raw || raw === "unknown") return "Unknown";
  if (raw === "male") return "Male";
  if (raw === "female") return "Female";
  if (raw === "other") return "Other";
  return "Unknown";
};

const safeDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const tokenize = (text) =>
  asText(text)
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 3);

const combinedNotes = (record) =>
  TEXT_FIELDS.map((field) => asText(record?.[field]))
    .filter(Boolean)
    .join(" ");

const coordinatePair = (record, fieldName) => {
  const coordinates = record?.[fieldName]?.coordinates;
  return Array.isArray(coordinates) && coordinates.length === 2
    ? coordinates.map((value) => Number(value))
    : null;
};

const haversineDistanceMeters = (left, right) => {
  if (!left || !right) return null;
  const [lng1, lat1] = left;
  const [lng2, lat2] = right;
  if (![lng1, lat1, lng2, lat2].every(Number.isFinite)) return null;

  const toRad = (deg) => (deg * Math.PI) / 180;
  const earthRadius = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const textSimilarityScore = (lost, found) => {
  const lostTokens = new Set(tokenize(combinedNotes(lost)));
  const foundTokens = tokenize(combinedNotes(found));
  if (!lostTokens.size || !foundTokens.length) return 0;

  let common = 0;
  for (const token of foundTokens) {
    if (lostTokens.has(token)) common += 1;
  }
  if (common >= 5) return 25;
  if (common >= 3) return 18;
  if (common >= 1) return 10;
  return 0;
};

export function computeMatchScore(lost, found) {
  let score = 0;

  if (lost.approxAge && found.approxAge) {
    const diff = Math.abs(lost.approxAge - found.approxAge);
    if (diff <= 3) score += 24;
    else if (diff <= 5) score += 15;
    else if (diff <= 8) score += 8;
  }

  const lostGender = normalizeGender(lost.gender);
  const foundGender = normalizeGender(found.gender);
  if (lostGender !== "Unknown" && foundGender !== "Unknown") {
    if (lostGender === foundGender) score += 18;
  } else if (lostGender === "Unknown" || foundGender === "Unknown") {
    score += 6;
  }

  const lostTime = safeDate(lost.lastSeenTime);
  const foundTime = safeDate(found.foundTime);
  if (lostTime && foundTime) {
    const diffHours = Math.abs(foundTime.getTime() - lostTime.getTime()) / 36e5;
    if (diffHours <= 12) score += 16;
    else if (diffHours <= 24) score += 12;
    else if (diffHours <= TIME_WINDOW_HOURS) score += 8;
  } else {
    score += 4;
  }

  const lostCoordinates = coordinatePair(lost, "lastSeenLocation");
  const foundCoordinates = coordinatePair(found, "currentLocation");
  const distanceMeters = haversineDistanceMeters(
    lostCoordinates,
    foundCoordinates,
  );
  if (distanceMeters != null) {
    if (distanceMeters <= 1000) score += 20;
    else if (distanceMeters <= 5000) score += 14;
    else if (distanceMeters <= LOST_RADIUS_METERS) score += 8;
  } else if (
    asText(lost.lastSeenLocationText) ||
    asText(found.currentHospitalId)
  ) {
    score += 5;
  }

  score += textSimilarityScore(lost, found);

  if (lost.photoUrl && found.photoUrl) {
    // Current mode only applies a small photo-presence boost. Future KHOJ image
    // adapters can return an additional bounded confidence without blocking saves.
    score += 7;
  }

  return Math.min(score, 100);
}

const refreshSuggestedMatch = async (existing, score) => {
  if (existing.status !== "confirmed") {
    existing.score = score;
    existing.status = "suggested";
    existing.reviewedByAdminId = null;
    existing.reviewedAt = null;
    await existing.save();
  }
  return existing;
};

const upsertSuggestedMatch = async ({ lost, found, score }) => {
  const pairFilter = {
    lostReportId: lost._id,
    foundReportId: found._id,
  };

  const existing = await LostFoundMatch.findOne(pairFilter);
  if (existing) {
    return refreshSuggestedMatch(existing, score);
  }

  try {
    return await LostFoundMatch.create({ ...pairFilter, score });
  } catch (error) {
    // Duplicate key: a concurrent matcher run created the pair first
    // (unique index on lostReportId+foundReportId). Update that record.
    if (error?.code === 11000) {
      const concurrent = await LostFoundMatch.findOne(pairFilter);
      if (concurrent) {
        return refreshSuggestedMatch(concurrent, score);
      }
    }
    throw error;
  }
};

const buildLostCandidateQuery = (foundReport) => {
  const query = {
    status: "open",
    gender: { $in: [normalizeGender(foundReport.gender), "Unknown"] },
  };

  const foundTime = safeDate(foundReport.foundTime);
  if (foundTime) {
    query.lastSeenTime = {
      $gte: new Date(foundTime.getTime() - TIME_WINDOW_HOURS * 60 * 60 * 1000),
      $lte: new Date(foundTime.getTime() + TIME_WINDOW_HOURS * 60 * 60 * 1000),
    };
  }

  const foundCoordinates = coordinatePair(foundReport, "currentLocation");
  if (foundCoordinates) {
    query.lastSeenLocation = {
      $near: {
        $geometry: {
          type: "Point",
          coordinates: foundCoordinates,
        },
        $maxDistance: LOST_RADIUS_METERS,
      },
    };
  }

  return query;
};

const buildFoundCandidateQuery = (lostReport) => {
  const query = {
    status: { $in: ["unmatched", "under_evaluation"] },
    gender: { $in: [normalizeGender(lostReport.gender), "Unknown"] },
  };

  const lostTime = safeDate(lostReport.lastSeenTime);
  if (lostTime) {
    query.foundTime = {
      $gte: new Date(lostTime.getTime() - TIME_WINDOW_HOURS * 60 * 60 * 1000),
      $lte: new Date(lostTime.getTime() + TIME_WINDOW_HOURS * 60 * 60 * 1000),
    };
  }

  const lostCoordinates = coordinatePair(lostReport, "lastSeenLocation");
  if (lostCoordinates) {
    query.currentLocation = {
      $near: {
        $geometry: {
          type: "Point",
          coordinates: lostCoordinates,
        },
        $maxDistance: LOST_RADIUS_METERS,
      },
    };
  }

  return query;
};

const applyFutureImageSignal = async ({ lost, found, score }) => {
  try {
    const imageSignal = await compareLostFoundPhotos({ lost, found });
    if (
      !imageSignal?.available ||
      !Number.isFinite(Number(imageSignal.score))
    ) {
      return score;
    }
    return Math.min(
      100,
      score + Math.max(0, Math.min(10, Number(imageSignal.score))),
    );
  } catch {
    return score;
  }
};

export async function matchFoundToLost(foundReport) {
  const query = buildLostCandidateQuery(foundReport);
  const candidatesQuery = LostPersonReport.find(query);
  if (typeof candidatesQuery.limit === "function") {
    candidatesQuery.limit(100);
  }
  const candidates = await candidatesQuery;

  const matches = [];

  for (const lost of candidates) {
    let score = computeMatchScore(lost, foundReport);
    score = await applyFutureImageSignal({ lost, found: foundReport, score });
    if (score >= MATCH_THRESHOLD) {
      matches.push(
        await upsertSuggestedMatch({ lost, found: foundReport, score }),
      );
    }
  }

  return matches;
}

export async function matchLostToFound(lostReport) {
  const query = buildFoundCandidateQuery(lostReport);
  const candidatesQuery = FoundPersonReport.find(query);
  if (typeof candidatesQuery.limit === "function") {
    candidatesQuery.limit(100);
  }
  const candidates = await candidatesQuery;

  const matches = [];

  for (const found of candidates) {
    let score = computeMatchScore(lostReport, found);
    score = await applyFutureImageSignal({ lost: lostReport, found, score });
    if (score >= MATCH_THRESHOLD) {
      matches.push(
        await upsertSuggestedMatch({ lost: lostReport, found, score }),
      );
    }
  }

  return matches;
}

export const constants = {
  LOST_RADIUS_METERS,
  TIME_WINDOW_HOURS,
  MATCH_THRESHOLD,
};
