import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function checkDatabase() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB\n');

        const db = mongoose.connection.db;

        // List all collections
        const collections = await db.listCollections().toArray();
        console.log('📚 Collections in database:');
        collections.forEach(c => console.log(`   - ${c.name}`));
        console.log('');

        // Count documents in sessions collection
        const sessionsCount = await db.collection('sessions').countDocuments();
        console.log(`📊 Total sessions: ${sessionsCount}\n`);

        // Get all sessions
        const sessions = await db.collection('sessions').find().sort({ createdAt: -1 }).toArray();
        console.log('📋 All Sessions:\n');
        sessions.forEach((s, i) => {
            console.log(`${i + 1}. ID: ${s._id}`);
            console.log(`   Doctor ID: ${s.doctorId}`);
            console.log(`   Patient ID: ${s.patientId}`);
            console.log(`   Status: ${s.status}`);
            console.log(`   Created: ${s.createdAt}`);
            console.log(`   Diagnosis: ${s.diagnosis || 'N/A'}`);
            console.log('');
        });

        // Count doctors
        const doctorsCount = await db.collection('doctorusers').countDocuments();
        console.log(`\n👨‍⚕️ Total doctors: ${doctorsCount}\n`);

        // Get sample doctors
        const doctors = await db.collection('doctorusers').find().limit(5).toArray();
        console.log('Sample Doctors:\n');
        doctors.forEach((d, i) => {
            console.log(`${i + 1}. Name: ${d.name}`);
            console.log(`   Email: ${d.email}`);
            console.log(`   ID: ${d._id}`);
            console.log('');
        });

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await mongoose.connection.close();
        console.log('🔌 Disconnected');
    }
}

checkDatabase();
