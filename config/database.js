import mongoose from "mongoose";
import dotenv from "dotenv";
import dns from "dns";

// Load standard env first; keep db.env compatibility for older setups.
dotenv.config();
dotenv.config({ path: "./db.env" });

const connectDB = async () => {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error("MONGO_URI is not set in environment variables");
    }

    // Fix: Windows DNS resolver fails on MongoDB Atlas SRV lookups.
    // Force Node.js to use Google DNS which correctly resolves SRV records.
    dns.setServers(["8.8.8.8", "8.8.4.4"]);

    await mongoose.connect(process.env.MONGO_URI, {
      dbName: "healthvault",
      family: 4, // Use IPv4, avoids IPv6 DNS resolution issues on Windows
    });

    console.log("MongoDB connected");
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    process.exit(1);
  }
};

export default connectDB;
