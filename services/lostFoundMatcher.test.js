import { describe, expect, it } from "@jest/globals";
import { compareLostFoundPhotos } from "./khojImageMatcher.js";
import { computeMatchScore } from "./lostFoundMatcher.js";

describe("lostFoundMatcher", () => {
  it("scores a likely lost/found pair above the suggestion threshold", () => {
    const lost = {
      approxAge: 62,
      gender: "Male",
      lastSeenTime: new Date("2026-07-07T08:00:00.000Z"),
      lastSeenLocation: { coordinates: [77.209, 28.6139] },
      description: "Elderly man wearing a white kurta and blue shawl",
      clothingDescription: "white kurta blue shawl",
      identificationDetails: "scar near left eyebrow",
      medicalNotes: "diabetes medication",
      photoUrl: "lost.jpg",
    };
    const found = {
      approxAge: 64,
      gender: "Male",
      foundTime: new Date("2026-07-07T10:30:00.000Z"),
      currentLocation: { coordinates: [77.21, 28.6145] },
      description: "Found elderly man in white kurta with blue shawl",
      condition: "carrying diabetes medication",
      photoUrl: "found.jpg",
    };

    expect(computeMatchScore(lost, found)).toBeGreaterThanOrEqual(60);
  });

  it("does not over-score unrelated reports", () => {
    const lost = {
      approxAge: 12,
      gender: "Female",
      lastSeenTime: new Date("2026-07-07T08:00:00.000Z"),
      lastSeenLocation: { coordinates: [77.209, 28.6139] },
      description: "child wearing red t-shirt",
    };
    const found = {
      approxAge: 70,
      gender: "Male",
      foundTime: new Date("2026-07-09T11:00:00.000Z"),
      currentLocation: { coordinates: [72.8777, 19.076] },
      description: "elderly man in hospital gown",
    };

    expect(computeMatchScore(lost, found)).toBeLessThan(60);
  });

  it("keeps the future KHOJ image adapter non-blocking when unconfigured", async () => {
    await expect(compareLostFoundPhotos()).resolves.toMatchObject({
      available: false,
      score: 0,
    });
  });
});
