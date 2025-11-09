import { LostPersonReport } from "../models/LostPersonReport.js";
import { LostFoundMatch } from "../models/LostFoundMatch.js";

const LOST_RADIUS_METERS = 10000; // 10km
const TIME_WINDOW_HOURS = 48;
const MATCH_THRESHOLD = 60;

export function computeMatchScore(lost, found) {
  let score = 0;

  if (lost.approxAge && found.approxAge) {
    const diff = Math.abs(lost.approxAge - found.approxAge);
    if (diff <= 3) score += 25;
    else if (diff <= 5) score += 15;
  }

  if (lost.gender && found.gender && lost.gender === found.gender) {
    score += 20;
  }

  score += 20;

  if (lost.description && found.description) {
    const lostWords = lost.description.toLowerCase().split(/\W+/);
    const foundWords = found.description.toLowerCase().split(/\W+/);
    const setLost = new Set(lostWords.filter((w) => w.length > 3));
    let common = 0;
    for (const word of foundWords) {
      if (word.length <= 3) continue;
      if (setLost.has(word)) common += 1;
    }
    if (common >= 3) score += 35;
    else if (common >= 1) score += 20;
  }

  return Math.min(score, 100);
}

export async function matchFoundToLost(foundReport) {
  if (
    !foundReport.currentLocation ||
    !Array.isArray(foundReport.currentLocation.coordinates)
  ) {
    return [];
  }

  const since = new Date(
    foundReport.foundTime.getTime() - TIME_WINDOW_HOURS * 60 * 60 * 1000
  );

  const candidates = await LostPersonReport.find({
    status: "open",
    gender: { $in: [foundReport.gender, "Unknown"] },
    lastSeenTime: { $gte: since },
    lastSeenLocation: {
      $near: {
        $geometry: {
          type: "Point",
          coordinates: foundReport.currentLocation.coordinates,
        },
        $maxDistance: LOST_RADIUS_METERS,
      },
    },
  });

  const matches = [];

  for (const lost of candidates) {
    const score = computeMatchScore(lost, foundReport);
    if (score >= MATCH_THRESHOLD) {
      const existing = await LostFoundMatch.findOne({
        lostReportId: lost._id,
        foundReportId: foundReport._id,
      });

      if (existing) {
        if (existing.score !== score || existing.status !== "suggested") {
          existing.score = score;
          existing.status = "suggested";
          existing.reviewedByAdminId = null;
          existing.reviewedAt = null;
          await existing.save();
        }
        matches.push(existing);
      } else {
        const match = await LostFoundMatch.create({
          lostReportId: lost._id,
          foundReportId: foundReport._id,
          score,
        });
        matches.push(match);
      }
    }
  }

  return matches;
}

export const constants = {
  LOST_RADIUS_METERS,
  TIME_WINDOW_HOURS,
  MATCH_THRESHOLD,
};

