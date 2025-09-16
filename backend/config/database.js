import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config({ path: "./db.env" });

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      dbName: "healthvault",       // ✅ explicitly select your DB
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ MongoDB Connected:", process.env.MONGO_URI);
  } catch (error) {
    console.error("❌ MongoDB connection failed:", error);
    process.exit(1);
  }
};

export default connectDB;
