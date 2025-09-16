import mongoose from "mongoose";
import dotenv from "dotenv";

// Load environment variables
dotenv.config({ path: "./db.env" });

const fixMobileField = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("Connected to MongoDB");

    // Update the specific user to add mobile field
    const result = await mongoose.connection.db.collection('users').updateOne(
      { email: "ram@aially.com" },
      { $set: { mobile: "9999999999" } } // Add a default mobile number
    );

    console.log("Update result:", result);
    console.log("Mobile field added to user");
    
    // Verify the update
    const user = await mongoose.connection.db.collection('users').findOne(
      { email: "ram@aially.com" }
    );
    console.log("Updated user mobile:", user.mobile);

    process.exit(0);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
};

fixMobileField();
