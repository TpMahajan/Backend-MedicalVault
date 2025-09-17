import express from "express";
import { Appointment } from "../models/Appointment.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();

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

    res.json({ success: true, message: "Appointment deleted successfully." });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Internal server error while deleting appointment.",
      error: error.message,
    });
  }
});

// ✅ ESM Export
export default router;
