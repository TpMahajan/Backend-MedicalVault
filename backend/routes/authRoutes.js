import express from "express";
import jwt from "jsonwebtoken";
import { User } from "../models/User.js";
import { auth } from "../middleware/auth.js";
import { getMe, updateMe } from "../controllers/authController.js";
import { DoctorUser } from "../models/DoctorUser.js";  // doctor model

const router = express.Router();

// ================= Patient Signup =================
router.post("/signup", async (req, res) => {
  try {
    const { name, email, password, mobile } = req.body;

    if (!name || !email || !password || !mobile) {
      return res.status(400).json({ message: "Name, email, mobile, and password are required" });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    const newUser = new User({
      name,
      email: email.toLowerCase(),
      password,
      mobile,
    });

    await newUser.save();

    const token = jwt.sign(
      { userId: newUser._id, role: "patient" },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    res.status(201).json({
      success: true,
      message: "User registered successfully",
      user: {
        id: newUser._id.toString(),
        name: newUser.name,
        email: newUser.email,
        mobile: newUser.mobile,
      },
      token,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ================= Patient Login =================
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    const isValid = await user.comparePassword(password);
    if (!isValid) return res.status(400).json({ message: "Invalid credentials" });

    const token = jwt.sign(
      { userId: user._id, role: "patient" },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    user.lastLogin = new Date();
    await user.save();

    res.status(200).json({
      success: true,
      message: "Login successful",
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        mobile: user.mobile,
        profilePicture: user.profilePicture,
      },
      token,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ================= Doctor Signup =================
router.post("/doctor/signup", async (req, res) => {
  try {
    const { name, email, password, specialization } = req.body;

    if (!name || !email || !password || !specialization) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const existingDoctor = await DoctorUser.findOne({ email: email.toLowerCase() });
    if (existingDoctor) {
      return res.status(400).json({ message: "Doctor already exists" });
    }

    const newDoctor = new DoctorUser({
      name,
      email: email.toLowerCase(),
      password,
      specialization,
    });

    await newDoctor.save();

    const token = jwt.sign(
      { doctorId: newDoctor._id, role: "doctor" },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    res.status(201).json({
      success: true,
      message: "Doctor registered successfully",
      doctor: {
        id: newDoctor._id.toString(),
        name: newDoctor.name,
        email: newDoctor.email,
        specialization: newDoctor.specialization,
      },
      token,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ================= Doctor Login =================
router.post("/doctor/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const doctor = await DoctorUser.findOne({ email: email.toLowerCase() });
    if (!doctor) return res.status(400).json({ message: "Invalid credentials" });

    const isValid = await doctor.comparePassword(password);
    if (!isValid) return res.status(400).json({ message: "Invalid credentials" });

    const token = jwt.sign(
      { doctorId: doctor._id, role: "doctor" },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    doctor.lastLogin = new Date();
    await doctor.save();

    res.status(200).json({
      success: true,
      message: "Login successful",
      doctor: {
        id: doctor._id.toString(),
        name: doctor.name,
        email: doctor.email,
        specialization: doctor.specialization,
      },
      token,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ================= Current User/Doctor =================
router.get("/me", auth, getMe);
router.put("/me", auth, updateMe);

// ================= Debug Login Endpoint =================
router.post("/debug-login", async (req, res) => {
  try {
    const { email, password, userType } = req.body;
    
    console.log('🔍 Debug login attempt:', {
      email: email,
      userType: userType,
      hasPassword: !!password
    });

    let user, token, role;
    
    if (userType === 'doctor') {
      user = await DoctorUser.findOne({ email: email.toLowerCase() });
      role = 'doctor';
      console.log('👨‍⚕️ Looking for doctor:', user ? 'Found' : 'Not found');
    } else {
      user = await User.findOne({ email: email.toLowerCase() });
      role = 'patient';
      console.log('👤 Looking for patient:', user ? 'Found' : 'Not found');
    }

    if (!user) {
      return res.status(400).json({ 
        success: false,
        message: "User not found",
        debug: { email, userType, role }
      });
    }

    const isValid = await user.comparePassword(password);
    console.log('🔐 Password valid:', isValid);
    
    if (!isValid) {
      return res.status(400).json({ 
        success: false,
        message: "Invalid password",
        debug: { email, userType, role }
      });
    }

    token = jwt.sign(
      { userId: user._id, role: role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    console.log('✅ Login successful:', {
      userId: user._id,
      role: role,
      tokenGenerated: !!token
    });

    res.json({
      success: true,
      message: "Debug login successful",
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: role
      },
      token,
      debug: {
        userType: userType,
        role: role,
        tokenPayload: { userId: user._id, role: role }
      }
    });

  } catch (error) {
    console.error('Debug login error:', error);
    res.status(500).json({ 
      success: false,
      message: "Debug login failed",
      error: error.message 
    });
  }
});

// ================= Test Endpoint for QR Scanner =================
router.post("/test-patient", async (req, res) => {
  try {
    // Create a test patient for QR scanner testing
    const testPatient = new User({
      name: "Test Patient",
      email: "test.patient@example.com",
      password: "test123",
      mobile: "+1234567890",
      age: 30,
      gender: "Male",
      bloodType: "O+"
    });

    // Check if test patient already exists
    const existingPatient = await User.findOne({ email: "test.patient@example.com" });
    let patient;
    
    if (existingPatient) {
      patient = existingPatient;
    } else {
      await testPatient.save();
      patient = testPatient;
    }

    // Generate token
    const token = jwt.sign(
      { userId: patient._id, role: "patient" },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    res.json({
      success: true,
      message: "Test patient token generated",
      token,
      patient: {
        id: patient._id.toString(),
        name: patient.name,
        email: patient.email,
        mobile: patient.mobile
      }
    });
  } catch (error) {
    console.error("Test patient creation error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create test patient"
    });
  }
});

export default router;
