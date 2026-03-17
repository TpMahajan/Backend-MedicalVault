import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function checkAllSessions() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB\n');

        const db = mongoose.connection.db;

        // Get all sessions from database
        const sessions = await db.collection('sessions').find().sort({ createdAt: -1 }).toArray();

        console.log(`📊 Total Sessions in Database: ${sessions.length}\n`);
        console.log('='.repeat(80));
        console.log('ALL SESSION RECORDS');
        console.log('='.repeat(80));
        console.log('');

        for (const [index, session] of sessions.entries()) {
            console.log(`${index + 1}. Session ID: ${session._id}`);
            console.log(`   Doctor ID: ${session.doctorId}`);
            console.log(`   Patient ID: ${session.patientId}`);
            console.log(`   Status: ${session.status}`);
            console.log(`   Is Active: ${session.isActive}`);
            console.log(`   Created At: ${session.createdAt}`);
            console.log(`   Expires At: ${session.expiresAt || 'N/A'}`);
            console.log(`   Ended At: ${session.endedAt || 'N/A'}`);
            console.log(`   Diagnosis: ${session.diagnosis || 'N/A'}`);
            console.log(`   Notes: ${session.notes || 'N/A'}`);

            // Get patient details
            if (session.patientId) {
                const patient = await db.collection('users').findOne({ _id: session.patientId });
                if (patient) {
                    console.log(`   Patient Name: ${patient.name}`);
                    console.log(`   Patient Email: ${patient.email}`);
                }
            }

            // Get doctor details
            if (session.doctorId) {
                const doctor = await db.collection('doctor_users').findOne({ _id: session.doctorId });
                if (doctor) {
                    console.log(`   Doctor Name: ${doctor.name}`);
                    console.log(`   Doctor Email: ${doctor.email}`);
                }
            }

            console.log('');
            console.log('-'.repeat(80));
            console.log('');
        }

        // Group by doctor
        const sessionsByDoctor = {};
        for (const session of sessions) {
            const doctorId = session.doctorId?.toString() || 'Unknown';
            if (!sessionsByDoctor[doctorId]) {
                sessionsByDoctor[doctorId] = [];
            }
            sessionsByDoctor[doctorId].push(session);
        }

        console.log('\n📊 SESSIONS BY DOCTOR:\n');
        for (const [doctorId, doctorSessions] of Object.entries(sessionsByDoctor)) {
            const doctor = await db.collection('doctor_users').findOne({ _id: new mongoose.Types.ObjectId(doctorId) });
            console.log(`Doctor: ${doctor?.name || 'Unknown'} (${doctorId})`);
            console.log(`   Total Sessions: ${doctorSessions.length}`);
            console.log(`   Active: ${doctorSessions.filter(s => s.status === 'accepted' && s.expiresAt > new Date()).length}`);
            console.log(`   Completed: ${doctorSessions.filter(s => s.status === 'ended' || (s.status === 'accepted' && s.expiresAt <= new Date())).length}`);
            console.log(`   Cancelled: ${doctorSessions.filter(s => s.status === 'declined').length}`);
            console.log('');
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
    } finally {
        await mongoose.connection.close();
        console.log('🔌 Database connection closed');
    }
}

checkAllSessions();
