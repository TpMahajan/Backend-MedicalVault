import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const lostFoundMatchMock = {
  findOne: jest.fn(),
  create: jest.fn(),
};

const highScoreLostReport = {
  _id: "lost-1",
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

const highScoreFoundReport = {
  _id: "found-1",
  approxAge: 64,
  gender: "Male",
  foundTime: new Date("2026-07-07T10:30:00.000Z"),
  currentLocation: { coordinates: [77.21, 28.6145] },
  description: "Found elderly man in white kurta with blue shawl",
  condition: "carrying diabetes medication",
  photoUrl: "found.jpg",
};

const makeCandidateQuery = (candidates) => {
  const query = Promise.resolve(candidates);
  query.limit = () => query;
  return query;
};

jest.unstable_mockModule("../models/LostPersonReport.js", () => ({
  LostPersonReport: { find: jest.fn(() => makeCandidateQuery([])) },
}));
jest.unstable_mockModule("../models/FoundPersonReport.js", () => ({
  FoundPersonReport: {
    find: jest.fn(() => makeCandidateQuery([highScoreFoundReport])),
  },
}));
jest.unstable_mockModule("../models/LostFoundMatch.js", () => ({
  LostFoundMatch: lostFoundMatchMock,
}));
jest.unstable_mockModule("./khojImageMatcher.js", () => ({
  compareLostFoundPhotos: jest.fn(async () => ({ available: false, score: 0 })),
}));

const { matchLostToFound } = await import("./lostFoundMatcher.js");

describe("lostFoundMatcher match upsert", () => {
  beforeEach(() => {
    lostFoundMatchMock.findOne.mockReset();
    lostFoundMatchMock.create.mockReset();
  });

  it("creates a single suggested match for a new lost/found pair", async () => {
    lostFoundMatchMock.findOne.mockResolvedValue(null);
    lostFoundMatchMock.create.mockImplementation(async (payload) => ({
      ...payload,
      status: "suggested",
    }));

    const matches = await matchLostToFound(highScoreLostReport);

    expect(matches).toHaveLength(1);
    expect(lostFoundMatchMock.create).toHaveBeenCalledTimes(1);
    expect(lostFoundMatchMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        lostReportId: "lost-1",
        foundReportId: "found-1",
      }),
    );
  });

  it("recovers from a duplicate-key race without creating a second record", async () => {
    const concurrentRecord = {
      lostReportId: "lost-1",
      foundReportId: "found-1",
      score: 10,
      status: "suggested",
      reviewedByAdminId: null,
      reviewedAt: null,
      save: jest.fn(async function save() {
        return this;
      }),
    };

    // First findOne (pre-create check) misses; create hits the unique index;
    // second findOne returns the record the concurrent matcher created.
    lostFoundMatchMock.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(concurrentRecord);
    const duplicateKeyError = Object.assign(new Error("E11000 duplicate key"), {
      code: 11000,
    });
    lostFoundMatchMock.create.mockRejectedValue(duplicateKeyError);

    const matches = await matchLostToFound(highScoreLostReport);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(concurrentRecord);
    expect(concurrentRecord.save).toHaveBeenCalledTimes(1);
    expect(concurrentRecord.score).toBeGreaterThanOrEqual(60);
  });

  it("never downgrades a confirmed match back to suggested", async () => {
    const confirmedRecord = {
      lostReportId: "lost-1",
      foundReportId: "found-1",
      score: 88,
      status: "confirmed",
      save: jest.fn(),
    };
    lostFoundMatchMock.findOne.mockResolvedValue(confirmedRecord);

    const matches = await matchLostToFound(highScoreLostReport);

    expect(matches).toHaveLength(1);
    expect(matches[0].status).toBe("confirmed");
    expect(confirmedRecord.save).not.toHaveBeenCalled();
    expect(lostFoundMatchMock.create).not.toHaveBeenCalled();
  });
});
