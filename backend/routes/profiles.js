import express from "express";
import jwt from "jsonwebtoken";
import { User } from "../models/User.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();

// ================= GET LINKED PROFILES =================
router.get("/", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id || req.user.id)
      .populate('linkedProfiles', 'name email profilePicture')
      .select('linkedProfiles');

    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: "User not found" 
      });
    }

    res.json({
      success: true,
      message: "Linked profiles fetched successfully",
      data: {
        linkedProfiles: user.linkedProfiles || []
      }
    });
  } catch (error) {
    console.error("Get profiles error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Internal server error" 
    });
  }
});

// ================= ADD SELF PROFILE =================
router.post("/add-self", auth, async (req, res) => {
  try {
    const { email, password } = req.body;
    const currentUserId = req.user._id || req.user.id;

    if (!email || !password) {
      return res.status(400).json({ 
        success: false, 
        message: "Email and password are required" 
      });
    }

    // Find the existing user by email
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (!existingUser) {
      return res.status(404).json({ 
        success: false, 
        message: "User with this email not found" 
      });
    }

    // Verify password
    const isValidPassword = await existingUser.comparePassword(password);
    if (!isValidPassword) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid password" 
      });
    }

    // Check if user is trying to link themselves
    if (existingUser._id.toString() === currentUserId.toString()) {
      return res.status(400).json({ 
        success: false, 
        message: "Cannot link your own profile" 
      });
    }

    // Check if profile is already linked
    const currentUser = await User.findById(currentUserId);
    if (currentUser.linkedProfiles.includes(existingUser._id)) {
      return res.status(400).json({ 
        success: false, 
        message: "Profile already linked" 
      });
    }

    // Add the profile to linked profiles
    currentUser.linkedProfiles.push(existingUser._id);
    await currentUser.save();

    // Fetch updated linked profiles
    const updatedUser = await User.findById(currentUserId)
      .populate('linkedProfiles', 'name email profilePicture')
      .select('linkedProfiles');

    res.json({
      success: true,
      message: "Profile linked successfully",
      data: {
        linkedProfiles: updatedUser.linkedProfiles
      }
    });
  } catch (error) {
    console.error("Add self profile error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Internal server error" 
    });
  }
});

// ================= ADD OTHER PROFILE =================
router.post("/add-other", auth, async (req, res) => {
  try {
    const { name, email, mobile, password } = req.body;
    const currentUserId = req.user._id || req.user.id;

    if (!name || !email || !mobile || !password) {
      return res.status(400).json({ 
        success: false, 
        message: "Name, email, mobile, and password are required" 
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ 
        success: false, 
        message: "User with this email already exists" 
      });
    }

    // Create new user
    const newUser = new User({
      name,
      email: email.toLowerCase(),
      password,
      mobile,
    });

    await newUser.save();

    // Add the new profile to current user's linked profiles
    const currentUser = await User.findById(currentUserId);
    currentUser.linkedProfiles.push(newUser._id);
    await currentUser.save();

    // Fetch updated linked profiles
    const updatedUser = await User.findById(currentUserId)
      .populate('linkedProfiles', 'name email profilePicture')
      .select('linkedProfiles');

    res.status(201).json({
      success: true,
      message: "New profile created and linked successfully",
      data: {
        linkedProfiles: updatedUser.linkedProfiles,
        newProfile: {
          id: newUser._id,
          name: newUser.name,
          email: newUser.email,
          mobile: newUser.mobile
        }
      }
    });
  } catch (error) {
    console.error("Add other profile error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Internal server error" 
    });
  }
});

// ================= REMOVE LINKED PROFILE =================
router.delete("/remove/:profileId", auth, async (req, res) => {
  try {
    const { profileId } = req.params;
    const currentUserId = req.user._id || req.user.id;

    const currentUser = await User.findById(currentUserId);
    if (!currentUser) {
      return res.status(404).json({ 
        success: false, 
        message: "User not found" 
      });
    }

    // Remove the profile from linked profiles
    currentUser.linkedProfiles = currentUser.linkedProfiles.filter(
      profile => profile.toString() !== profileId
    );
    await currentUser.save();

    // Fetch updated linked profiles
    const updatedUser = await User.findById(currentUserId)
      .populate('linkedProfiles', 'name email profilePicture')
      .select('linkedProfiles');

    res.json({
      success: true,
      message: "Profile removed successfully",
      data: {
        linkedProfiles: updatedUser.linkedProfiles
      }
    });
  } catch (error) {
    console.error("Remove profile error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Internal server error" 
    });
  }
});

// ================= SWITCH TO PROFILE =================
router.post("/switch/:profileId", auth, async (req, res) => {
  try {
    const { profileId } = req.params;
    const { password } = req.body;
    const currentUserId = req.user._id || req.user.id;

    if (!password) {
      return res.status(400).json({ 
        success: false, 
        message: "Password is required to switch profiles" 
      });
    }

    // Find the target profile
    const targetProfile = await User.findById(profileId);
    if (!targetProfile) {
      return res.status(404).json({ 
        success: false, 
        message: "Profile not found" 
      });
    }

    // Check if the profile is linked to current user
    const currentUser = await User.findById(currentUserId);
    const isLinked = currentUser.linkedProfiles.some(
      profile => profile.toString() === profileId
    );

    // Allow switching to own profile or linked profiles
    const isOwnProfile = profileId === currentUserId.toString();
    if (!isOwnProfile && !isLinked) {
      return res.status(403).json({ 
        success: false, 
        message: "You don't have permission to switch to this profile" 
      });
    }

    // Verify password for the target profile
    const isValidPassword = await targetProfile.comparePassword(password);
    if (!isValidPassword) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid password for this profile" 
      });
    }

    // Generate new token for the target profile
    const token = jwt.sign(
      { userId: targetProfile._id, role: "patient" },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    // Update last login
    targetProfile.lastLogin = new Date();
    await targetProfile.save();

    res.json({
      success: true,
      message: "Profile switched successfully",
      data: {
        user: {
          id: targetProfile._id.toString(),
          name: targetProfile.name,
          email: targetProfile.email,
          mobile: targetProfile.mobile,
          profilePicture: targetProfile.profilePicture,
        },
        token
      }
    });
  } catch (error) {
    console.error("Switch profile error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Internal server error" 
    });
  }
});

export default router;
