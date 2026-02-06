import express from "express";
import { auth } from "../middleware/auth.js";
import { requirePatient } from "../middleware/auth.js";
import { Appointment } from "../models/Appointment.js";
import { Document } from "../models/File.js";
import { DoctorUser } from "../models/DoctorUser.js";

const router = express.Router();

// All routes require auth + patient role
router.use(auth, requirePatient);

// Helper: get patient ID from req (handles both _id and id)
const getPatientId = (req) => {
  return req.user?._id?.toString() || req.user?.id?.toString();
};

// POST /api/patient/appointments/request - Patient requests appointment (for self or linked family member)
router.post("/appointments/request", async (req, res) => {
  try {
    const currentUserId = getPatientId(req);
    const {
      doctorId,
      patientId: forPatientId,
      patientName,
      patientEmail,
      patientPhone,
      appointmentDate,
      appointmentTime,
      duration,
      reason,
      appointmentType,
      mode,
      notes,
    } = req.body;

    if (!doctorId || !appointmentDate || !appointmentTime || !reason) {
      return res.status(400).json({
        success: false,
        message: "doctorId, appointmentDate, appointmentTime, and reason are required.",
      });
    }

    const targetPatientId = forPatientId?.trim() || currentUserId;
    const isForSelf = targetPatientId === currentUserId;

    const { User } = await import("../models/User.js");
    const { DoctorUser } = await import("../models/DoctorUser.js");
    const patient = await User.findById(targetPatientId);
    if (!patient) {
      return res.status(404).json({ success: false, message: "Patient not found." });
    }
    if (!isForSelf) {
      const user = await User.findById(currentUserId);
      const linked = user?.linkedProfiles?.map((p) => p?.toString?.() || p) || [];
      if (!linked.includes(targetPatientId)) {
        return res.status(403).json({
          success: false,
          message: "You can only book for yourself or linked family members.",
        });
      }
    }

    const doctor = await DoctorUser.findById(doctorId);
    if (!doctor) {
      return res.status(404).json({ success: false, message: "Doctor not found." });
    }

    const appointment = new Appointment({
      patientId: targetPatientId,
      patientName: patientName || patient.name,
      patientEmail: patientEmail || patient.email || "",
      patientPhone: patientPhone || patient.mobile || "",
      appointmentDate: new Date(appointmentDate),
      appointmentTime: appointmentTime.trim(),
      duration: duration || 30,
      reason: reason.trim(),
      appointmentType: appointmentType || "consultation",
      doctorId: doctor._id,
      doctorName: doctor.name,
      doctorSpecialization: doctor.specialty || "",
      hospitalClinicName: doctor.location || "",
      mode: mode === "online" ? "online" : "in-person",
      status: "pending",
      notes: notes?.trim() || "",
      createdBy: "patient",
    });
    await appointment.save();

    const { sendNotificationToDoctor } = await import("../utils/notifications.js");
    if (doctor.fcmToken) {
      await sendNotificationToDoctor(
        doctorId,
        "New Appointment Request",
        `${patient.name || patientName} has requested an appointment for ${new Date(appointmentDate).toLocaleDateString()} at ${appointmentTime}.`,
        { type: "APPOINTMENT_PENDING", appointmentId: appointment._id.toString() }
      );
    }

    res.status(201).json({
      success: true,
      message: "Appointment request submitted. The doctor will review it.",
      appointment,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to request appointment.",
      error: error.message,
    });
  }
});

// GET /api/patient/appointments/upcoming
router.get("/appointments/upcoming", async (req, res) => {
  try {
    const patientId = getPatientId(req);
    const now = new Date();

    const appointments = await Appointment.find({
      patientId,
      status: { $in: ["scheduled", "confirmed", "pending"] },
    })
      .populate("doctorId", "name specialty location")
      .sort({ appointmentDate: 1, appointmentTime: 1 })
      .lean();

    // Filter to only future appointments (date + time combined)
    const upcoming = appointments.filter((apt) => {
      const aptDate = new Date(apt.appointmentDate);
      const [h, m] = (apt.appointmentTime || "00:00").split(":").map(Number);
      aptDate.setHours(h, m, 0, 0);
      return aptDate > now;
    });

    res.json({
      success: true,
      appointments: upcoming,
      count: upcoming.length,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch upcoming appointments.",
      error: error.message,
    });
  }
});

// GET /api/patient/appointments/past
router.get("/appointments/past", async (req, res) => {
  try {
    const patientId = getPatientId(req);
    const now = new Date();

    const appointments = await Appointment.find({
      patientId,
      status: { $in: ["completed", "cancelled", "no-show", "missed", "rescheduled"] },
    })
      .populate("doctorId", "name specialty location")
      .sort({ appointmentDate: -1, appointmentTime: -1 })
      .lean();

    // Also include past-due scheduled/confirmed (missed)
    const pastScheduled = await Appointment.find({
      patientId,
      status: { $in: ["scheduled", "confirmed"] },
    })
      .populate("doctorId", "name specialty location")
      .sort({ appointmentDate: -1, appointmentTime: -1 })
      .lean();

    const pastScheduledFiltered = pastScheduled.filter((apt) => {
      const aptDate = new Date(apt.appointmentDate);
      const [h, m] = (apt.appointmentTime || "00:00").split(":").map(Number);
      aptDate.setHours(h, m, 0, 0);
      return aptDate <= now;
    });

    const seen = new Set();
    const combined = [...appointments, ...pastScheduledFiltered];
    const past = combined
      .filter((apt) => {
        const id = apt._id?.toString();
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .sort((a, b) => {
        const da = new Date(a.appointmentDate);
        const [ha, ma] = (a.appointmentTime || "00:00").split(":").map(Number);
        da.setHours(ha, ma, 0, 0);
        const db = new Date(b.appointmentDate);
        const [hb, mb] = (b.appointmentTime || "00:00").split(":").map(Number);
        db.setHours(hb, mb, 0, 0);
        return db - da;
      });

    res.json({
      success: true,
      appointments: past,
      count: past.length,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch past appointments.",
      error: error.message,
    });
  }
});

// GET /api/patient/appointments/:id
router.get("/appointments/:id", async (req, res) => {
  try {
    const patientId = getPatientId(req);
    const { id } = req.params;

    const appointment = await Appointment.findOne({
      _id: id,
      patientId,
    })
      .populate("doctorId", "name specialty location email mobile")
      .lean();

    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: "Appointment not found.",
      });
    }

    const linkedDocs = await Document.find({
      userId: patientId,
      appointmentId: id,
    })
      .select("title type category date url s3Key _id")
      .lean();

    res.json({
      success: true,
      appointment: {
        ...appointment,
        linkedDocuments: linkedDocs,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch appointment.",
      error: error.message,
    });
  }
});

// POST /api/patient/appointments/:id/reschedule-request
router.post("/appointments/:id/reschedule-request", async (req, res) => {
  try {
    const patientId = getPatientId(req);
    const { id } = req.params;
    const { preferredDate, preferredTime, reason } = req.body;

    const appointment = await Appointment.findOne({
      _id: id,
      patientId,
      status: { $in: ["scheduled", "confirmed"] },
    });

    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: "Appointment not found or cannot be rescheduled.",
      });
    }

    const aptDateTime = new Date(appointment.appointmentDate);
    const [h, m] = (appointment.appointmentTime || "00:00").split(":").map(Number);
    aptDateTime.setHours(h, m, 0, 0);
    const tenMinutesFromNow = new Date(Date.now() + 10 * 60 * 1000);

    if (aptDateTime <= tenMinutesFromNow) {
      return res.status(400).json({
        success: false,
        message: "Cannot request reschedule when appointment is within 10 minutes.",
      });
    }

    appointment.rescheduleRequestedAt = new Date();
    appointment.rescheduleReason = reason || "";
    if (preferredDate) appointment.appointmentDate = new Date(preferredDate);
    if (preferredTime) appointment.appointmentTime = preferredTime;
    await appointment.save();

    res.json({
      success: true,
      message: "Reschedule request submitted. The doctor will review it.",
      appointment,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to submit reschedule request.",
      error: error.message,
    });
  }
});

// POST /api/patient/appointments/:id/cancel
router.post("/appointments/:id/cancel", async (req, res) => {
  try {
    const patientId = getPatientId(req);
    const { id } = req.params;

    const appointment = await Appointment.findOne({
      _id: id,
      patientId,
      status: { $in: ["scheduled", "confirmed", "pending"] },
    });

    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: "Appointment not found or cannot be cancelled.",
      });
    }

    appointment.status = "cancelled";
    await appointment.save();

    res.json({
      success: true,
      message: "Appointment cancelled successfully.",
      appointment,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to cancel appointment.",
      error: error.message,
    });
  }
});

// GET /api/patient/appointments/:id/ai-summary
router.get("/appointments/:id/ai-summary", async (req, res) => {
  try {
    const patientId = getPatientId(req);
    const { id } = req.params;

    const appointment = await Appointment.findOne({
      _id: id,
      patientId,
      status: "completed",
    }).lean();

    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: "Appointment not found or not completed.",
      });
    }

    const { AppointmentAIInsight } = await import("../models/AppointmentAIInsight.js");
    let insight = await AppointmentAIInsight.findOne({ appointmentId: id }).lean();

    if (!insight) {
      return res.json({
        success: true,
        summary: null,
        visitExplanation: null,
        message: "AI summary not yet generated. Use the AI assistant to ask about this visit.",
      });
    }

    res.json({
      success: true,
      summary: insight.summary,
      visitExplanation: insight.visitExplanation,
      suggestedFollowUpDays: insight.suggestedFollowUpDays,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch AI summary.",
      error: error.message,
    });
  }
});

export default router;
