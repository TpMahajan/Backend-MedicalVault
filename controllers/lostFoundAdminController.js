import { LostPersonReport } from "../models/LostPersonReport.js";
import { FoundPersonReport } from "../models/FoundPersonReport.js";
import { LostFoundMatch } from "../models/LostFoundMatch.js";

export const getSummary = async (req, res) => {
  try {
    const [openLostCount, unmatchedFoundCount, suggestedMatchesCount] =
      await Promise.all([
        LostPersonReport.countDocuments({ status: "open" }),
        FoundPersonReport.countDocuments({ status: "unmatched" }),
        LostFoundMatch.countDocuments({ status: "suggested" }),
      ]);

    res.json({
      success: true,
      summary: {
        openLostCount,
        unmatchedFoundCount,
        suggestedMatchesCount,
      },
    });
  } catch (error) {
    console.error("getSummary error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load lost & found summary",
    });
  }
};

export const listMatches = async (req, res) => {
  try {
    const status = req.query.status || "suggested";
    const matches = await LostFoundMatch.find({ status })
      .sort({ score: -1, createdAt: -1 })
      .populate(
        "lostReportId",
        "personName approxAge gender description lastSeenLocation lastSeenTime photoUrl status"
      )
      .populate(
        "foundReportId",
        "approxAge gender description currentLocation foundTime photoUrl condition status currentHospitalId"
      );

    res.json({
      success: true,
      data: { matches },
    });
  } catch (error) {
    console.error("listMatches error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch lost & found matches",
    });
  }
};

export const confirmMatch = async (req, res) => {
  try {
    const matchId = req.params.id;
    const match = await LostFoundMatch.findById(matchId);
    if (!match) {
      return res
        .status(404)
        .json({ success: false, message: "Match suggestion not found" });
    }

    match.status = "confirmed";
    match.reviewedByAdminId = req.admin._id;
    match.reviewedAt = new Date();
    await match.save();

    await Promise.all([
      LostPersonReport.findByIdAndUpdate(match.lostReportId, {
        status: "matched",
        matchedFoundReportId: match.foundReportId,
      }),
      FoundPersonReport.findByIdAndUpdate(match.foundReportId, {
        status: "matched",
        matchedLostReportId: match.lostReportId,
      }),
      LostFoundMatch.updateMany(
        {
          _id: { $ne: match._id },
          $or: [
            { lostReportId: match.lostReportId },
            { foundReportId: match.foundReportId },
          ],
          status: "suggested",
        },
        {
          $set: {
            status: "rejected",
            reviewedByAdminId: req.admin._id,
            reviewedAt: new Date(),
          },
        }
      ),
    ]);

    res.json({
      success: true,
      message: "Match confirmed",
    });
  } catch (error) {
    console.error("confirmMatch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to confirm match",
    });
  }
};

export const rejectMatch = async (req, res) => {
  try {
    const matchId = req.params.id;
    const match = await LostFoundMatch.findById(matchId);
    if (!match) {
      return res
        .status(404)
        .json({ success: false, message: "Match suggestion not found" });
    }

    match.status = "rejected";
    match.reviewedByAdminId = req.admin._id;
    match.reviewedAt = new Date();
    await match.save();

    res.json({
      success: true,
      message: "Match rejected",
    });
  } catch (error) {
    console.error("rejectMatch error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to reject match",
    });
  }
};

