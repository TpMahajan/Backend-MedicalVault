const ACTIVE_SESSION_STATUSES = ["accepted", "pending"];

const normalizeDate = (dateLike) => {
  if (dateLike instanceof Date && !Number.isNaN(dateLike.getTime())) {
    return dateLike;
  }

  const parsed = new Date(dateLike);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

export const persistSessionHistory = async (
  sessionModel,
  { sessionId, doctorId, patientId, diagnosis, notes, endedAt = new Date() }
) => {
  if (!sessionModel || !sessionId || !patientId) {
    console.warn("Skipping session history persistence due to missing identifiers", {
      hasSessionModel: !!sessionModel,
      hasSessionId: !!sessionId,
      hasPatientId: !!patientId,
    });
    return null;
  }

  const finalizedAt = normalizeDate(endedAt);
  const filter = {
    _id: sessionId,
    patientId,
    ...(doctorId ? { doctorId } : {}),
  };

  const setPayload = {
    status: "ended",
    isActive: false,
    endedAt: finalizedAt,
  };

  if (diagnosis !== undefined) setPayload.diagnosis = diagnosis;
  if (notes !== undefined) setPayload.notes = notes;

  return sessionModel.findOneAndUpdate(
    filter,
    {
      $set: setPayload,
      $unset: { expiresAt: 1 },
      $setOnInsert: {
        patientId,
        ...(doctorId ? { doctorId } : {}),
      },
    },
    {
      new: true,
      upsert: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    }
  );
};

export const flushDoctorActiveSessions = async (
  sessionModel,
  { doctorId, reason = null, now = new Date() } = {}
) => {
  if (!sessionModel || !doctorId) {
    console.warn("Skipping active session flush due to missing identifiers", {
      hasSessionModel: !!sessionModel,
      hasDoctorId: !!doctorId,
    });
    return { endedCount: 0 };
  }

  const activeSessions = await sessionModel.find({
    doctorId,
    status: { $in: ACTIVE_SESSION_STATUSES },
    isActive: { $ne: false },
    expiresAt: { $gt: normalizeDate(now) },
  });

  let endedCount = 0;
  for (const session of activeSessions) {
    const autoNote = reason ? `Session ended automatically: ${reason}.` : null;
    const mergedNotes = autoNote
      ? session.notes
        ? `${session.notes}\n\n${autoNote}`
        : autoNote
      : session.notes;

    const saved = await persistSessionHistory(sessionModel, {
      sessionId: session._id,
      doctorId: session.doctorId || doctorId,
      patientId: session.patientId,
      diagnosis: session.diagnosis,
      notes: mergedNotes,
      endedAt: now,
    });

    if (saved) endedCount += 1;
  }

  return { endedCount };
};

export const flushExpiredAcceptedSessions = async (
  sessionModel,
  { now = new Date() } = {}
) => {
  if (!sessionModel) {
    console.warn("Skipping expired session flush because session model is missing");
    return { modifiedCount: 0 };
  }

  const cutoff = normalizeDate(now);
  const expiredSessions = await sessionModel.find({
    status: "accepted",
    isActive: { $ne: false },
    expiresAt: { $lte: cutoff },
  });

  let modifiedCount = 0;
  for (const session of expiredSessions) {
    const saved = await persistSessionHistory(sessionModel, {
      sessionId: session._id,
      doctorId: session.doctorId,
      patientId: session.patientId,
      diagnosis: session.diagnosis,
      notes: session.notes,
      endedAt: session.expiresAt || cutoff,
    });

    if (saved) modifiedCount += 1;
  }

  return { modifiedCount };
};

