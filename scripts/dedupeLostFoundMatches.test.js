import { describe, expect, it } from "@jest/globals";
import {
  isBetter,
  planDedupe,
  statusRank,
} from "./dedupe-lost-found-matches.js";

describe("dedupe-lost-found-matches planner", () => {
  it("ranks confirmed > rejected > suggested", () => {
    expect(statusRank("confirmed")).toBeGreaterThan(statusRank("rejected"));
    expect(statusRank("rejected")).toBeGreaterThan(statusRank("suggested"));
    expect(statusRank("anything-else")).toBe(statusRank("suggested"));
  });

  it("prefers a confirmed record over a higher-scored suggested one", () => {
    const confirmedLowScore = { status: "confirmed", score: 61 };
    const suggestedHighScore = { status: "suggested", score: 99 };
    expect(isBetter(confirmedLowScore, suggestedHighScore)).toBe(true);
  });

  it("breaks status ties by score, then recency", () => {
    const older = {
      status: "suggested",
      score: 70,
      createdAt: "2026-07-01T00:00:00.000Z",
    };
    const higherScore = { status: "suggested", score: 80, createdAt: older.createdAt };
    expect(isBetter(higherScore, older)).toBe(true);

    const newer = {
      status: "suggested",
      score: 70,
      updatedAt: "2026-07-05T00:00:00.000Z",
    };
    expect(isBetter(newer, older)).toBe(true);
  });

  it("keeps exactly one record per (lost, found) pair", () => {
    const docs = [
      { _id: "a", lostReportId: "L1", foundReportId: "F1", status: "suggested", score: 60 },
      { _id: "b", lostReportId: "L1", foundReportId: "F1", status: "confirmed", score: 62 },
      { _id: "c", lostReportId: "L1", foundReportId: "F1", status: "suggested", score: 90 },
      { _id: "d", lostReportId: "L2", foundReportId: "F2", status: "suggested", score: 70 },
    ];

    const { keepByPair, keepIds, duplicateIds } = planDedupe(docs);

    // Two unique pairs -> two kept records.
    expect(keepByPair.size).toBe(2);
    // The confirmed record "b" wins its pair despite a lower score than "c".
    expect(keepIds.has("b")).toBe(true);
    expect(keepIds.has("d")).toBe(true);
    expect(duplicateIds.map(String).sort()).toEqual(["a", "c"]);
  });

  it("produces no duplicates when every pair is already unique", () => {
    const docs = [
      { _id: "a", lostReportId: "L1", foundReportId: "F1", status: "suggested", score: 60 },
      { _id: "b", lostReportId: "L1", foundReportId: "F2", status: "suggested", score: 60 },
      { _id: "c", lostReportId: "L2", foundReportId: "F1", status: "suggested", score: 60 },
    ];
    const { duplicateIds } = planDedupe(docs);
    expect(duplicateIds).toHaveLength(0);
  });
});
