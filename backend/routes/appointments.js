const express = require("express");
const Appointment = require("../models/Appointment");
const auth = require("../middleware/auth");

const router = express.Router();

// POST /api/appointments - Create new appointment
router.post("/", auth, async (req, res) => {
  try {
    console.log("Create appointment API called");
    console.log("Appointment data:", req.body);
    
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
      notes 
    } = req.body;
    
    // Validate required fields
    if (!patientId || !patientName || !appointmentDate || !appointmentTime || !reason) {
      return res.status(400).json({
        success: false,
        message: "Patient ID, name, appointment date, time, and reason are required.",
      });
    }

    // Create new appointment
    const appointment = new Appointment({
      patientId: patientId.trim(),
      patientName: patientName.trim(),
      patientEmail: patientEmail ? patientEmail.trim() : "",
      patientPhone: patientPhone ? patientPhone.trim() : "",
      appointmentDate: new Date(appointmentDate),
      appointmentTime: appointmentTime.trim(),
      duration: duration || 30,
      reason: reason.trim(),
      appointmentType: appointmentType || "consultation",
      notes: notes ? notes.trim() : "",
      doctorId: req.doctor._id,
      doctorName: req.doctor.name,
    });

    await appointment.save();

    console.log("Appointment created successfully:", {
      id: appointment._id,
      patientName: appointment.patientName,
      appointmentDate: appointment.appointmentDate,
      appointmentTime: appointment.appointmentTime,
      reason: appointment.reason,
      doctorId: appointment.doctorId
    });

    res.status(201).json({
      success: true,
      message: "Appointment created successfully.",
      appointment: {
        id: appointment._id,
        patientName: appointment.patientName,
        appointmentDate: appointment.appointmentDate,
        appointmentTime: appointment.appointmentTime,
        reason: appointment.reason,
        notes: appointment.notes,
        status: appointment.status,
        createdAt: appointment.createdAt,
      },
    });
  } catch (error) {
    console.error("Appointment creation error:", error);
    
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: "Validation error.",
        errors,
      });
    }

    res.status(500).json({
      success: false,
      message: "Internal server error while creating appointment.",
    });
  }
});

// GET /api/appointments - Get all appointments for the doctor
router.get("/", auth, async (req, res) => {
  try {
    console.log("Get appointments API called for doctor:", req.doctor._id);
    
    const appointments = await Appointment.find({ doctorId: req.doctor._id })
      .sort({ appointmentDate: 1, appointmentTime: 1 })
      .select("-doctorId");

    console.log(`Found ${appointments.length} appointments`);

    res.json({
      success: true,
      message: "Appointments retrieved successfully.",
      appointments,
      count: appointments.length,
    });
  } catch (error) {
    console.error("Get appointments error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error while retrieving appointments.",
    });
  }
});

// GET /api/appointments/:id - Get specific appointment
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

    res.json({
      success: true,
      message: "Appointment retrieved successfully.",
      appointment,
    });
  } catch (error) {
    console.error("Get appointment error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error while retrieving appointment.",
    });
  }
});

// PUT /api/appointments/:id - Update appointment
router.put("/:id", auth, async (req, res) => {
  try {
    const { patientName, appointmentDate, appointmentTime, reason, notes, status } = req.body;
    
    const updateData = {
      patientName: patientName ? patientName.trim() : undefined,
      appointmentDate: appointmentDate ? new Date(appointmentDate) : undefined,
      appointmentTime: appointmentTime ? appointmentTime.trim() : undefined,
      reason: reason ? reason.trim() : undefined,
      notes: notes ? notes.trim() : undefined,
      status: status || undefined,
    };

    // Remove undefined values
    Object.keys(updateData).forEach(key => 
      updateData[key] === undefined && delete updateData[key]
    );

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

    res.json({
      success: true,
      message: "Appointment updated successfully.",
      appointment,
    });
  } catch (error) {
    console.error("Update appointment error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error while updating appointment.",
    });
  }
});

// DELETE /api/appointments/:id - Delete appointment
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

    res.json({
      success: true,
      message: "Appointment deleted successfully.",
    });
  } catch (error) {
    console.error("Delete appointment error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error while deleting appointment.",
    });
  }
});

module.exports = router;

