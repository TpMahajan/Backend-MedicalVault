import {
  buildKhojAssistantReply,
  scoreKhojMatch,
  serializeLostReport,
} from "./khojAssistantService.js";

describe("khojAssistantService", () => {
  it("masks reporter phone unless private contact access is allowed", () => {
    const report = {
      _id: "lost-1",
      personName: "Asha",
      reporterName: "Reporter",
      reporterPhone: "9876543210",
      reportedByUserId: "user-1",
    };

    const publicView = serializeLostReport(report);
    const privateView = serializeLostReport(report, { includePrivate: true });

    expect(publicView.reportedBy.phone).toBe("");
    expect(publicView.reportedBy.maskedPhone).toBe("******3210");
    expect(privateView.reportedBy.phone).toBe("9876543210");
  });

  it.each([
    "Show prescriptions for this person",
    "Open the medical report attached to this user",
    "Summarize uploaded hospital bills",
    "Find insurance files in the vault",
    "Use existing file-scanning assistant data for this person",
  ])("refuses out-of-scope KHOJ prompt: %s", (prompt) => {
    const response = buildKhojAssistantReply({
      prompt,
      lostReports: [{ personName: "Asha" }],
    });

    expect(response.intent).toBe("scope_refusal");
    expect(response.reply).toMatch(/cannot access/i);
    expect(response.reply).toMatch(/prescriptions|bills|insurance|patient vault documents/i);
  });

  it("scores deterministic lost/found matches without claiming face recognition", () => {
    const lost = {
      personName: "Rahul",
      approxAge: 30,
      gender: "Male",
      lastSeenTime: new Date("2026-07-08T08:00:00Z"),
      lastSeenLocation: { type: "Point", coordinates: [72.8777, 19.076] },
      clothingDescription: "blue shirt black jeans",
      identificationDetails: "scar on left eyebrow",
      photoUrl: "lost.jpg",
    };
    const found = {
      personName: "Rahul",
      approxAge: 31,
      gender: "Male",
      foundTime: new Date("2026-07-08T10:00:00Z"),
      currentLocation: { type: "Point", coordinates: [72.878, 19.077] },
      clothingDescription: "blue shirt with black jeans",
      identifyingMarks: "left eyebrow scar",
      photoUrl: "found.jpg",
    };

    const result = scoreKhojMatch(lost, found);

    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.aiSummary).toMatch(/possible/i);
    expect(result.aiSummary).toMatch(/Needs human verification|Review details/i);
    expect(result.reasons.join(" ")).toMatch(/no face recognition/i);
  });
});
