import mongoose from "mongoose";
import dotenv from "dotenv";
import User from "./models/User.js";

// Load environment variables
dotenv.config({ path: "./db.env" });

const migrateUsers = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("Connected to MongoDB");

    // Find users without mobile field
    const usersWithoutMobile = await User.find({ mobile: { $exists: false } });
    console.log(`Found ${usersWithoutMobile.length} users without mobile field`);

    // Update each user to add mobile field with a default value
    for (const user of usersWithoutMobile) {
      await User.findByIdAndUpdate(user._id, { 
        $set: { mobile: "0000000000" } // Default mobile number
      });
      console.log(`Updated user: ${user.email}`);
    }

    console.log("Migration completed successfully");
    process.exit(0);
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
};

migrateUsers();
