import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Session } from './models/Session.js';
import { DoctorUser } from './models/DoctorUser.js';
import { User } from './models/User.js';

dotenv.config();

async function testSessionData() {
    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB\n');

        // Count total sessions
        const totalSessions = await Session.countDocuments();
        console.log(`📊 Total Sessions in Database: ${totalSessions}\n`);

        if (totalSessions === 0) {
            console.log('⚠️  No sessions found in database!');
            console.log('💡 You may need to create some test sessions first.\n');
        } else {
            // Get all sessions with populated data
            const sessions = await Session.find()
                .populate('doctorId', 'name email')
                .populate('patientId', 'name email')
                .sort({ createdAt: -1 })
                .limit(10);

            console.log('📋 Latest 10 Sessions:\n');
            sessions.forEach((session, index) => {
                console.log(`${index + 1}. Session ID: ${session._id}`);
                console.log(`   Doctor: ${session.doctorId?.name || 'N/A'} (${session.doctorId?.email || 'N/A'})`);
                console.log(`   Patient: ${session.patientId?.name || 'N/A'} (${session.patientId?.email || 'N/A'})`);
                console.log(`   Status: ${session.status}`);
                console.log(`   Created: ${session.createdAt}`);
                console.log(`   Diagnosis: ${session.diagnosis || 'Not recorded'}`);
                console.log(`   Notes: ${session.notes || 'Not recorded'}`);
                console.log('');
            });

            // Group sessions by doctor
            const sessionsByDoctor = await Session.aggregate([
                {
                    $group: {
                        _id: '$doctorId',
                        count: { $sum: 1 }
                    }
                }
            ]);

            console.log('\n📊 Sessions per Doctor:');
            for (const doc of sessionsByDoctor) {
                if (doc._id) {
                    const doctor = await DoctorUser.findById(doc._id);
                    console.log(`   ${doctor?.name || 'Unknown'}: ${doc.count} sessions`);
                } else {
                    console.log(`   Anonymous: ${doc.count} sessions`);
                }
            }
        }

        // Check doctors
        const totalDoctors = await DoctorUser.countDocuments();
        console.log(`\n👨‍⚕️ Total Doctors: ${totalDoctors}`);

        if (totalDoctors > 0) {
            const doctors = await DoctorUser.find().limit(5);
            console.log('\n📋 Sample Doctors:');
            doctors.forEach((doc, index) => {
                console.log(`${index + 1}. ${doc.name} (${doc.email}) - ID: ${doc._id}`);
            });
        }

        // Check patients
        const totalPatients = await User.countDocuments();
        console.log(`\n👤 Total Patients: ${totalPatients}`);

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await mongoose.connection.close();
        console.log('\n🔌 Database connection closed');
    }
}

testSessionData();
