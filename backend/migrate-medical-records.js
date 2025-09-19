import { Document } from "./models/File.js";
import { User } from "./models/User.js";
import "./config/database.js";

async function migrateMedicalRecords() {
  try {
    console.log("🔄 Starting medical records migration...");
    
    // Get all documents
    const documents = await Document.find({});
    console.log(`📁 Found ${documents.length} documents to migrate`);
    
    let migratedCount = 0;
    let errorCount = 0;
    
    for (const doc of documents) {
      try {
        // Find the user for this document
        const user = await User.findById(doc.userId);
        if (!user) {
          console.log(`❌ User not found for document ${doc._id}`);
          errorCount++;
          continue;
        }
        
        // Check if this document is already in the user's medicalRecords
        const existingRecord = user.medicalRecords?.find(
          record => record.documentId?.toString() === doc._id.toString()
        );
        
        if (existingRecord) {
          console.log(`⏭️ Document ${doc._id} already exists in user ${user._id} medicalRecords`);
          continue;
        }
        
        // Add the document to user's medicalRecords
        await User.findByIdAndUpdate(
          doc.userId,
          {
            $push: {
              medicalRecords: {
                documentId: doc._id,
                title: doc.title,
                category: doc.category,
                uploadedAt: doc.uploadedAt,
                fileType: doc.fileType,
                cloudinaryUrl: doc.cloudinaryUrl,
                cloudinaryPublicId: doc.cloudinaryPublicId,
                originalName: doc.originalName,
                size: doc.size
              }
            }
          },
          { new: true }
        );
        
        console.log(`✅ Migrated document ${doc._id} to user ${user._id} medicalRecords`);
        migratedCount++;
        
      } catch (err) {
        console.error(`❌ Error migrating document ${doc._id}:`, err.message);
        errorCount++;
      }
    }
    
    console.log(`\n🎉 Migration completed!`);
    console.log(`✅ Successfully migrated: ${migratedCount} documents`);
    console.log(`❌ Errors: ${errorCount} documents`);
    
  } catch (err) {
    console.error("❌ Migration failed:", err);
  } finally {
    process.exit(0);
  }
}

migrateMedicalRecords();
