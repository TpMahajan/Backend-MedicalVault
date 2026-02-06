import express from "express";
import multer from "multer";
import multerS3 from "multer-s3";
import path from "path";
import { Appointment } from "../models/Appointment.js";
import { User } from "../models/User.js";
import { Document } from "../models/File.js";
import { auth, requireDoctor } from "../middleware/auth.js";
import { sendNotification, sendNotificationToDoctor } from "../utils/notifications.js";
import s3Client, { BUCKET_NAME, REGION } from "../config/s3.js";

const router = express.Router();

const appointmentFileUpload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: BUCKET_NAME,
    key: (req, file, cb) => {
      const baseName = path.parse(file.originalname).name.replace(/\s+/g, "_");
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `medical-vault/${Date.now()}-${baseName}${ext}`);
    },
    contentType: multerS3.AUTO_CONTENT_TYPE,
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// ✅ Helper function to update patient's nextAppointment
const updatePatientNextAppointment = async (patientId) => {
  try {
    const nextAppointment = await Appointment.findOne({ 
      patientId: patientId,
      status: { $in: ['scheduled', 'confirmed'] },
      appointmentDate: { $gte: new Date() }
    })
      .sort({ appointmentDate: 1, appointmentTime: 1 });

    if (nextAppointment) {
      const appointmentDateTime = `${nextAppointment.appointmentDate.toISOString().split('T')[0]}T${nextAppointment.appointmentTime}`;
      const formattedDate = new Date(appointmentDateTime).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });
      const formattedTime = new Date(appointmentDateTime).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });
      
      await User.findByIdAndUpdate(patientId, {
        nextAppointment: `${formattedDate} at ${formattedTime}`
      });
      
      console.log('✅ Updated patient nextAppointment to next available appointment');
    } else {
      // No upcoming appointments, clear the nextAppointment
      await User.findByIdAndUpdate(patientId, {
        nextAppointment: null
      });
      
      console.log('✅ Cleared patient nextAppointment - no upcoming appointments');
    }
  } catch (error) {
    console.error('❌ Error updating patient nextAppointment:', error);
  }
};

// ================= Calendar View =================
router.get("/calendar", auth, requireDoctor, async (req, res) => {
  try {
    const { view = "week", date } = req.query;
    const baseDate = date ? new Date(date) : new Date();
    let start, end;
    if (view === "day") {
      start = new Date(baseDate);
      start.setHours(0, 0, 0, 0);
      end = new Date(start);
      end.setDate(end.getDate() + 1);
    } else if (view === "month") {
      start = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1);
      end = new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 0, 23, 59, 59);
    } else {
      const day = baseDate.getDay();
      const diff = baseDate.getDate() - day + (day === 0 ? -6 : 1);
      start = new Date(baseDate);
      start.setDate(diff);
      start.setHours(0, 0, 0, 0);
      end = new Date(start);
      end.setDate(end.getDate() + 7);
    }
    const appointments = await Appointment.find({
      doctorId: req.doctor._id,
      appointmentDate: { $gte: start, $lt: end },
      status: { $nin: ["cancelled"] },
    })
      .sort({ appointmentDate: 1, appointmentTime: 1 })
      .lean();
    res.json({ success: true, appointments });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ================= List View =================
router.get("/list", auth, requireDoctor, async (req, res) => {
  try {
    const { filter = "upcoming" } = req.query;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    let query = { doctorId: req.doctor._id };
    if (filter === "today") {
      query.appointmentDate = { $gte: todayStart, $lte: todayEnd };
      query.status = { $nin: ["cancelled"] };
    } else if (filter === "past") {
      query.$or = [
        { appointmentDate: { $lt: todayStart } },
        { status: { $in: ["completed", "cancelled", "no-show", "missed"] } },
      ];
    } else {
      query.appointmentDate = { $gte: now };
      query.status = { $in: ["pending", "scheduled", "confirmed"] };
    }
    const appointments = await Appointment.find(query)
      .sort({ appointmentDate: 1, appointmentTime: 1 })
      .lean();
    res.json({ success: true, appointments, count: appointments.length });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ================= Create Appointment =================
router.post("/", auth, requireDoctor, async (req, res) => {
  try {
    const {
      patientId,
      patientName,
      patientEmail,
      patientPhone,
      appointmentDate,
      appointmentTime,
      duration,
      reason,
      appointmentType,
      notes,
      mode,
      hospitalClinicName,
      videoCallUrl,
    } = req.body;

    if (!patientId || !patientName || !appointmentDate || !appointmentTime || !reason) {
      return res.status(400).json({
        success: false,
        message:
          "Patient ID, name, appointment date, time, and reason are required.",
      });
    }

    const appointment = new Appointment({
      patientId: patientId.trim(),
      patientName: patientName.trim(),
      patientEmail: patientEmail?.trim() || "",
      patientPhone: patientPhone?.trim() || "",
      appointmentDate: new Date(appointmentDate),
      appointmentTime: appointmentTime.trim(),
      duration: duration || 30,
      reason: reason.trim(),
      appointmentType: appointmentType || "consultation",
      notes: notes?.trim() || "",
      doctorId: req.doctor._id,
      doctorName: req.doctor.name,
      doctorSpecialization: req.doctor.specialty || "",
      hospitalClinicName: hospitalClinicName?.trim() || req.doctor.location || "",
      mode: mode === "online" ? "online" : "in-person",
      videoCallUrl: videoCallUrl?.trim() || "",
      createdBy: "doctor",
    });

    await appointment.save();

    // ✅ Update patient's nextAppointment field
    try {
      const patient = await User.findById(patientId);
      if (patient) {
        // Format the appointment date and time for storage
        const appointmentDateTime = `${appointmentDate}T${appointmentTime}`;
        const formattedDate = new Date(appointmentDateTime).toLocaleDateString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });
        const formattedTime = new Date(appointmentDateTime).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        });
        
        await User.findByIdAndUpdate(patientId, {
          nextAppointment: `${formattedDate} at ${formattedTime}`,
          lastVisit: patient.lastVisit || new Date().toISOString().split('T')[0] // Update last visit if not set
        });
        
        console.log('✅ Updated patient nextAppointment:', {
          patientId,
          nextAppointment: `${formattedDate} at ${formattedTime}`
        });
      } else {
        console.log('⚠️ Patient not found with ID:', patientId);
      }
    } catch (updateError) {
      console.error('❌ Error updating patient nextAppointment:', updateError);
      // Don't fail the appointment creation if patient update fails
    }

    // ✅ Send notification to patient about the new appointment
    try {
      const patient = await User.findById(patientId);
      const notifData = {
        type: 'APPOINTMENT_BOOKED',
        appointmentId: appointment._id.toString(),
        doctorName: req.doctor.name,
        appointmentDate: appointmentDate,
        appointmentTime: appointmentTime,
        reason: reason,
        deepLink: `/appointments/${appointment._id}`,
      };
      const { Notification } = await import('../models/Notification.js');
      const notification = new Notification({
        title: 'New Appointment Scheduled',
        body: `You have a new appointment scheduled for ${new Date(appointmentDate).toLocaleDateString()} at ${appointmentTime} with Dr. ${req.doctor.name}`,
        type: 'appointment',
        data: notifData,
        recipientId: patientId,
        recipientRole: 'patient',
        senderId: req.doctor._id.toString(),
        senderRole: 'doctor',
      });
      await notification.save();
      if (patient?.fcmToken) {
        await sendNotification(patientId, 'New Appointment Scheduled', notification.body, notifData);
      }
      const { broadcastNotification } = await import('../controllers/notificationController.js');
      await broadcastNotification(notification);
    } catch (notificationError) {
      console.error('❌ Error sending appointment notification:', notificationError);
    }

    res.status(201).json({
      success: true,
      message: "Appointment created successfully.",
      appointment,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Internal server error while creating appointment.",
      error: error.message,
    });
  }
});

// ================= Get All Appointments =================
router.get("/", auth, requireDoctor, async (req, res) => {
  try {
    const appointments = await Appointment.find({ doctorId: req.doctor._id })
      .sort({ appointmentDate: 1, appointmentTime: 1 })
      .select("-doctorId");

    res.json({
      success: true,
      message: "Appointments retrieved successfully.",
      appointments,
      count: appointments.length,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Internal server error while retrieving appointments.",
      error: error.message,
    });
  }
});

// ================= Get Appointment by ID =================
router.get("/:id", auth, requireDoctor, async (req, res) => {
  try {
    const appointment = await Appointment.findOne({
      _id: req.params.id,
      doctorId: req.doctor._id,
    });

    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: "Appointment not found.",
      });
    }

    res.json({ success: true, appointment });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Internal server error while retrieving appointment.",
      error: error.message,
    });
  }
});

// ================= Accept Pending =================
router.put("/:id/accept", auth, requireDoctor, async (req, res) => {
  try {
    const appointment = await Appointment.findOneAndUpdate(
      { _id: req.params.id, doctorId: req.doctor._id, status: "pending" },
      { status: "confirmed" },
      { new: true }
    );
    if (!appointment) {
      return res.status(404).json({ success: false, message: "Appointment not found or not pending." });
    }
    const patient = await User.findById(appointment.patientId);
    if (patient?.fcmToken) {
      await sendNotification(
        appointment.patientId,
        "Appointment Approved",
        `Your appointment with Dr. ${req.doctor.name} on ${new Date(appointment.appointmentDate).toLocaleDateString()} at ${appointment.appointmentTime} has been approved.`,
        { type: "APPOINTMENT_APPROVED", appointmentId: appointment._id.toString() }
      );
    }
    res.json({ success: true, appointment });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ================= Reject Pending =================
router.put("/:id/reject", auth, requireDoctor, async (req, res) => {
  try {
    const appointment = await Appointment.findOneAndUpdate(
      { _id: req.params.id, doctorId: req.doctor._id, status: "pending" },
      { status: "cancelled" },
      { new: true }
    );
    if (!appointment) {
      return res.status(404).json({ success: false, message: "Appointment not found or not pending." });
    }
    const patient = await User.findById(appointment.patientId);
    if (patient?.fcmToken) {
      await sendNotification(
        appointment.patientId,
        "Appointment Declined",
        `Your appointment request with Dr. ${req.doctor.name} has been declined.`,
        { type: "APPOINTMENT_CANCELLED", appointmentId: appointment._id.toString() }
      );
    }
    res.json({ success: true, appointment });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ================= Mark Completed =================
router.put("/:id/complete", auth, requireDoctor, async (req, res) => {
  try {
    const appointment = await Appointment.findOneAndUpdate(
      { _id: req.params.id, doctorId: req.doctor._id },
      { status: "completed" },
      { new: true }
    );
    if (!appointment) {
      return res.status(404).json({ success: false, message: "Appointment not found." });
    }
    const patient = await User.findById(appointment.patientId);
    if (patient?.fcmToken) {
      await sendNotification(
        appointment.patientId,
        "Appointment Completed",
        `Your appointment with Dr. ${req.doctor.name} has been marked as completed.`,
        { type: "APPOINTMENT_COMPLETED", appointmentId: appointment._id.toString() }
      );
    }
    await updatePatientNextAppointment(appointment.patientId);
    res.json({ success: true, appointment });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ================= Mark No-Show =================
router.put("/:id/no-show", auth, requireDoctor, async (req, res) => {
  try {
    const appointment = await Appointment.findOneAndUpdate(
      { _id: req.params.id, doctorId: req.doctor._id },
      { status: "no-show" },
      { new: true }
    );
    if (!appointment) {
      return res.status(404).json({ success: false, message: "Appointment not found." });
    }
    await updatePatientNextAppointment(appointment.patientId);
    res.json({ success: true, appointment });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ================= Doctor Running Late =================
router.put("/:id/running-late", auth, requireDoctor, async (req, res) => {
  try {
    const { minutes } = req.body;
    const appointment = await Appointment.findOneAndUpdate(
      { _id: req.params.id, doctorId: req.doctor._id },
      {
        doctorRunningLateAt: new Date(),
        doctorRunningLateMinutes: Number(minutes) || 15,
      },
      { new: true }
    );
    if (!appointment) {
      return res.status(404).json({ success: false, message: "Appointment not found." });
    }
    const patient = await User.findById(appointment.patientId);
    if (patient?.fcmToken) {
      await sendNotification(
        appointment.patientId,
        "Doctor Running Late",
        `Dr. ${req.doctor.name} is running about ${appointment.doctorRunningLateMinutes} minutes late. Your appointment is still scheduled for ${appointment.appointmentTime}.`,
        { type: "DOCTOR_RUNNING_LATE", appointmentId: appointment._id.toString() }
      );
    }
    res.json({ success: true, appointment });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ================= Update Notes =================
router.put("/:id/notes", auth, requireDoctor, async (req, res) => {
  try {
    const { doctorNotesPrivate, doctorNotesShared } = req.body;
    const updateData = {};
    if (doctorNotesPrivate !== undefined) updateData.doctorNotesPrivate = doctorNotesPrivate;
    if (doctorNotesShared !== undefined) updateData.doctorNotesShared = doctorNotesShared;
    const appointment = await Appointment.findOneAndUpdate(
      { _id: req.params.id, doctorId: req.doctor._id },
      updateData,
      { new: true }
    );
    if (!appointment) {
      return res.status(404).json({ success: false, message: "Appointment not found." });
    }
    res.json({ success: true, appointment });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ================= Upload Prescription =================
router.post("/:id/upload-prescription", auth, requireDoctor, appointmentFileUpload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded." });
    const appointment = await Appointment.findOne({ _id: req.params.id, doctorId: req.doctor._id });
    if (!appointment) return res.status(404).json({ success: false, message: "Appointment not found." });
    const doc = await Document.create({
      userId: appointment.patientId,
      doctorId: req.doctor._id,
      appointmentId: appointment._id,
      title: req.body.title || req.file.originalname,
      type: "Prescription",
      category: "Prescription",
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      fileType: req.file.mimetype,
      size: req.file.size,
      fileSize: req.file.size,
      s3Key: req.file.key,
      s3Bucket: req.file.bucket,
      s3Region: REGION,
    });
    res.status(201).json({ success: true, document: doc });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ================= Upload Report =================
router.post("/:id/upload-report", auth, requireDoctor, appointmentFileUpload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded." });
    const appointment = await Appointment.findOne({ _id: req.params.id, doctorId: req.doctor._id });
    if (!appointment) return res.status(404).json({ success: false, message: "Appointment not found." });
    const doc = await Document.create({
      userId: appointment.patientId,
      doctorId: req.doctor._id,
      appointmentId: appointment._id,
      title: req.body.title || req.file.originalname,
      type: "Report",
      category: "Report",
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      fileType: req.file.mimetype,
      size: req.file.size,
      fileSize: req.file.size,
      s3Key: req.file.key,
      s3Bucket: req.file.bucket,
      s3Region: REGION,
    });
    res.status(201).json({ success: true, document: doc });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ================= Update Appointment =================
router.put("/:id", auth, requireDoctor, async (req, res) => {
  try {
    const { patientName, appointmentDate, appointmentTime, reason, notes, status } = req.body;

    const updateData = {
      patientName: patientName?.trim(),
      appointmentDate: appointmentDate ? new Date(appointmentDate) : undefined,
      appointmentTime: appointmentTime?.trim(),
      reason: reason?.trim(),
      notes: notes?.trim(),
      status: status || undefined,
    };

    Object.keys(updateData).forEach((key) => updateData[key] === undefined && delete updateData[key]);

    const appointment = await Appointment.findOneAndUpdate(
      { _id: req.params.id, doctorId: req.doctor._id },
      updateData,
      { new: true, runValidators: true }
    );

    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: "Appointment not found.",
      });
    }

    // ✅ Update patient's nextAppointment to the next available appointment
    await updatePatientNextAppointment(appointment.patientId);

    // ✅ Send notification to patient about appointment update
    try {
      const notifData = {
        type: 'APPOINTMENT_RESCHEDULED',
        appointmentId: appointment._id.toString(),
        doctorName: req.doctor.name,
        appointmentDate: appointment.appointmentDate,
        appointmentTime: appointment.appointmentTime,
        reason: appointment.reason,
        deepLink: `/appointments/${appointment._id}`,
      };
      const { Notification } = await import('../models/Notification.js');
      const body = `Your appointment has been updated. New details: ${new Date(appointment.appointmentDate).toLocaleDateString()} at ${appointment.appointmentTime}`;
      const notification = new Notification({
        title: 'Appointment Updated',
        body,
        type: 'appointment',
        data: notifData,
        recipientId: appointment.patientId,
        recipientRole: 'patient',
        senderId: req.doctor._id.toString(),
        senderRole: 'doctor',
      });
      await notification.save();
      const patient = await User.findById(appointment.patientId);
      if (patient?.fcmToken) {
        await sendNotification(appointment.patientId, 'Appointment Updated', body, notifData);
      }
      const { broadcastNotification } = await import('../controllers/notificationController.js');
      await broadcastNotification(notification);
    } catch (notificationError) {
      console.error('❌ Error sending appointment update notification:', notificationError);
    }

    res.json({ success: true, message: "Appointment updated successfully.", appointment });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Internal server error while updating appointment.",
      error: error.message,
    });
  }
});

// ================= Delete Appointment =================
router.delete("/:id", auth, requireDoctor, async (req, res) => {
  try {
    const appointment = await Appointment.findOneAndDelete({
      _id: req.params.id,
      doctorId: req.doctor._id,
    });

    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: "Appointment not found.",
      });
    }

    // ✅ Update patient's nextAppointment to the next available appointment
    await updatePatientNextAppointment(appointment.patientId);

    // ✅ Send notification to patient about appointment cancellation
    try {
      const notifData = {
        type: 'APPOINTMENT_CANCELLED',
        appointmentId: appointment._id.toString(),
        doctorName: req.doctor.name,
        appointmentDate: appointment.appointmentDate,
        appointmentTime: appointment.appointmentTime,
        reason: appointment.reason,
        deepLink: `/appointments/${appointment._id}`,
      };
      const body = `Your appointment scheduled for ${new Date(appointment.appointmentDate).toLocaleDateString()} at ${appointment.appointmentTime} has been cancelled.`;
      const { Notification } = await import('../models/Notification.js');
      const notification = new Notification({
        title: 'Appointment Cancelled',
        body,
        type: 'appointment',
        data: notifData,
        recipientId: appointment.patientId,
        recipientRole: 'patient',
        senderId: req.doctor._id.toString(),
        senderRole: 'doctor',
      });
      await notification.save();
      const patient = await User.findById(appointment.patientId);
      if (patient?.fcmToken) {
        await sendNotification(appointment.patientId, 'Appointment Cancelled', body, notifData);
      }
      const { broadcastNotification } = await import('../controllers/notificationController.js');
      await broadcastNotification(notification);
    } catch (notificationError) {
      console.error('❌ Error sending appointment cancellation notification:', notificationError);
    }

    res.json({ success: true, message: "Appointment deleted successfully." });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Internal server error while deleting appointment.",
      error: error.message,
    });
  }
});

// ================= Get Appointments for Specific Patient =================
router.get("/patient/:patientId", auth, requireDoctor, async (req, res) => {
  try {
    const { patientId } = req.params;
    
    const appointments = await Appointment.find({ 
      patientId: patientId,
      doctorId: req.doctor._id 
    })
      .sort({ appointmentDate: 1, appointmentTime: 1 })
      .select("-doctorId");

    res.json({
      success: true,
      message: "Patient appointments retrieved successfully.",
      appointments,
      count: appointments.length,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Internal server error while retrieving patient appointments.",
      error: error.message,
    });
  }
});

// ================= Get Patient's Next Appointment =================
router.get("/patient/:patientId/next", auth, requireDoctor, async (req, res) => {
  try {
    const { patientId } = req.params;
    
    const nextAppointment = await Appointment.findOne({ 
      patientId: patientId,
      doctorId: req.doctor._id,
      status: { $in: ['scheduled', 'confirmed'] },
      appointmentDate: { $gte: new Date() }
    })
      .sort({ appointmentDate: 1, appointmentTime: 1 })
      .select("-doctorId");

    if (!nextAppointment) {
      return res.json({
        success: true,
        message: "No upcoming appointments found for this patient.",
        appointment: null,
      });
    }

    res.json({
      success: true,
      message: "Next appointment retrieved successfully.",
      appointment: nextAppointment,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Internal server error while retrieving next appointment.",
      error: error.message,
    });
  }
});

// ✅ ESM Export
export default router;
