import express from "express";
import { Appointment } from "../models/Appointment.js";
import { User } from "../models/User.js";
import { auth } from "../middleware/auth.js";
import { sendNotification } from "../utils/notifications.js";

const router = express.Router();

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

// ================= Create Appointment =================
router.post("/", auth, async (req, res) => {
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
      if (patient && patient.fcmToken) {
        await sendNotification(
          patientId,
          'New Appointment Scheduled',
          `You have a new appointment scheduled for ${new Date(appointmentDate).toLocaleDateString()} at ${appointmentTime} with Dr. ${req.doctor.name}`,
          {
            type: 'APPOINTMENT_SCHEDULED',
            appointmentId: appointment._id,
            doctorName: req.doctor.name,
            appointmentDate: appointmentDate,
            appointmentTime: appointmentTime,
            reason: reason
          }
        );
        console.log('✅ Appointment notification sent to patient');
      } else {
        console.log('⚠️ Patient not found or no FCM token available for notification');
      }
    } catch (notificationError) {
      console.error('❌ Error sending appointment notification:', notificationError);
      // Don't fail the appointment creation if notification fails
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
router.get("/", auth, async (req, res) => {
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
router.get("/:id", auth, async (req, res) => {
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

// ================= Update Appointment =================
router.put("/:id", auth, async (req, res) => {
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
      const patient = await User.findById(appointment.patientId);
      if (patient && patient.fcmToken) {
        await sendNotification(
          appointment.patientId,
          'Appointment Updated',
          `Your appointment has been updated. New details: ${new Date(appointment.appointmentDate).toLocaleDateString()} at ${appointment.appointmentTime}`,
          {
            type: 'APPOINTMENT_UPDATED',
            appointmentId: appointment._id,
            doctorName: req.doctor.name,
            appointmentDate: appointment.appointmentDate,
            appointmentTime: appointment.appointmentTime,
            reason: appointment.reason
          }
        );
        console.log('✅ Appointment update notification sent to patient');
      }
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
router.delete("/:id", auth, async (req, res) => {
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
      const patient = await User.findById(appointment.patientId);
      if (patient && patient.fcmToken) {
        await sendNotification(
          appointment.patientId,
          'Appointment Cancelled',
          `Your appointment scheduled for ${new Date(appointment.appointmentDate).toLocaleDateString()} at ${appointment.appointmentTime} has been cancelled.`,
          {
            type: 'APPOINTMENT_CANCELLED',
            appointmentId: appointment._id,
            doctorName: req.doctor.name,
            appointmentDate: appointment.appointmentDate,
            appointmentTime: appointment.appointmentTime,
            reason: appointment.reason
          }
        );
        console.log('✅ Appointment cancellation notification sent to patient');
      }
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
router.get("/patient/:patientId", auth, async (req, res) => {
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
router.get("/patient/:patientId/next", auth, async (req, res) => {
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
