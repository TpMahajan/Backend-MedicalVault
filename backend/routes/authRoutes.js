import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { auth } from "../middleware/auth.js"; // ✅ make sure you have this middleware
import { getMe, updateMe } from "../controllers/authController.js";

const router = express.Router();

// ================= Signup =================
router.post("/signup", async (req, res) => {
  try {
    const { name, email, password, mobile } = req.body;

    // Validate required fields
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
      // aadhaar is not required at signup, defaults to null
    });

    await newUser.save();

    // Generate JWT token
    const token = jwt.sign(
      { id: newUser._id, email: newUser.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.status(201).json({
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


// ================= Login =================
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    const isValid = await user.comparePassword(password);
    if (!isValid) return res.status(400).json({ message: "Invalid credentials" });

    const token = jwt.sign(
      { id: user._id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    res.status(200).json({
      message: "Login successful",
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        mobile: user.mobile,
        aadhaar: user.aadhaar,
        dateOfBirth: user.dateOfBirth,
        age: user.age,
        gender: user.gender,
        bloodType: user.bloodType,
        height: user.height,
        weight: user.weight,
        lastVisit: user.lastVisit,
        nextAppointment: user.nextAppointment,
        emergencyContact: user.emergencyContact,
        medicalHistory: user.medicalHistory,
        medications: user.medications,
        medicalRecords: user.medicalRecords,
        profilePicture: user.profilePicture,
      },
      token,
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ================= Get Current User =================
router.get("/me", auth, getMe);

// ================= Update Current User =================
router.put("/me", auth, updateMe);

// ================= Test Endpoint =================
router.get("/test", (req, res) => {
  res.json({ message: "Test endpoint working", timestamp: new Date().toISOString() });
});

export default router;
