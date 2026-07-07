import { LostPersonReport } from "../models/LostPersonReport.js";

const asText = (value) => (value == null ? "" : String(value).trim());

const escapeRegex = (value) =>
  String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const isLostPersonIntent = (prompt = "") => {
  const lower = String(prompt || "").toLowerCase();
  if (!lower.trim()) return false;
  const intentMarkers = [
    "lost person",
    "missing person",
    "missing",
    "reported lost",
    "search lost",
    "find lost",
    "tell me about this lost person",
    "is this person reported lost",
  ];
  return intentMarkers.some((marker) => lower.includes(marker));
};

export const extractLostPersonSearchTerms = (prompt = "") => {
  const cleaned = String(prompt || "")
    .replace(/[?!.]/g, " ")
    .replace(/\b(tell|show|search|find|about|for|me|this|person|lost|missing|reported|details|is|the|a|an)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const name = cleaned
    .split(" ")
    .filter((part) => /^[a-zA-Z][a-zA-Z.'-]{1,}$/.test(part))
    .slice(0, 3)
    .join(" ");

  return { name };
};

const safeReport = (report = {}) => ({
  id: String(report._id || ""),
  personName: report.personName || null,
  approxAge: report.approxAge ?? null,
  gender: report.gender || "Unknown",
  description: asText(report.description).slice(0, 260) || null,
  photoUrl: report.photoUrl || null,
  photoAvailable: Boolean(report.photoUrl),
  lastSeenLocation:
    report.lastSeenLocationText ||
    [report.area, report.city, report.state].filter(Boolean).join(", ") ||
    null,
  lastSeenTime: report.lastSeenTime || null,
  status: report.status || "open",
  contactActionAvailable: Boolean(report.allowReporterContact),
});

export const buildLostFoundAiContext = async (prompt = "") => {
  if (!isLostPersonIntent(prompt)) {
    return { intent: false, matches: [], reply: "", structuredData: null };
  }

  const { name } = extractLostPersonSearchTerms(prompt);
  const query = { status: "open" };
  if (name) {
    query.personName = { $regex: escapeRegex(name), $options: "i" };
  }

  const reports = await LostPersonReport.find(query)
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();
  const matches = reports.map(safeReport);

  const reply =
    matches.length === 0
      ? "No matching active lost-person report was found. You can create a found-person report if you have found someone and want admins to review it."
      : [
          `I found ${matches.length} active lost-person report${matches.length === 1 ? "" : "s"} that may match.`,
          ...matches.map((item, index) => {
            const parts = [
              `${index + 1}. ${item.personName || "Unnamed person"}`,
              item.approxAge ? `approx age ${item.approxAge}` : null,
              item.gender || null,
              item.lastSeenLocation ? `last seen near ${item.lastSeenLocation}` : null,
              item.lastSeenTime ? `last seen time: ${new Date(item.lastSeenTime).toISOString()}` : null,
            ].filter(Boolean);
            return parts.join(" - ");
          }),
          "Open the report detail or create a found-person report if you have relevant information.",
        ].join("\n");

  return {
    intent: true,
    matches,
    reply,
    structuredData: {
      title: "Lost-person matches",
      items: matches,
    },
  };
};
