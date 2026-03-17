import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Session } from './models/Session.js';
import { DoctorUser } from './models/DoctorUser.js';
import { User } from './models/User.js';

dotenv.config();

async function checkSessionsForAllDoctors() {
    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB\n');

        // Get all doctors
        const doctors = await DoctorUser.find();
        console.log(`👨‍⚕️ Found ${doctors.length} doctors in database\n`);

        if (doctors.length === 0) {
            console.log('⚠️  No doctors found in database!');
            await mongoose.connection.close();
            return;
        }

        // For each doctor, check their sessions
        for (const doctor of doctors) {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`👨‍⚕️ Doctor: ${doctor.name}`);
            console.log(`📧 Email: ${doctor.email}`);
            console.log(`🆔 ID: ${doctor._id}`);
            console.log(`${'='.repeat(60)}\n`);

            // Find sessions for this doctor
            const sessions = await Session.find({ doctorId: doctor._id })
                .populate('patientId', 'name email age gender')
                .sort({ createdAt: -1 });

            console.log(`📊 Total Sessions: ${sessions.length}\n`);

            if (sessions.length === 0) {
                console.log('   ⚠️  No sessions found for this doctor.\n');
            } else {
                sessions.forEach((session, index) => {
                    console.log(`   ${index + 1}. Session ID: ${session._id}`);
                    console.log(`      Patient: ${session.patientId?.name || 'Unknown'}`);
                    console.log(`      Status: ${session.status}`);
                    console.log(`      Created: ${session.createdAt.toLocaleString()}`);
                    console.log(`      Diagnosis: ${session.diagnosis || 'Not recorded'}`);
                    console.log(`      Notes: ${session.notes || 'Not recorded'}`);
                    console.log('');
                });
            }
        }

        // Also check for sessions without a doctor (anonymous)
        const anonymousSessions = await Session.find({ doctorId: null })
            .populate('patientId', 'name email')
            .sort({ createdAt: -1 });

        if (anonymousSessions.length > 0) {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`🔓 Anonymous Sessions (no doctor assigned)`);
            console.log(`${'='.repeat(60)}\n`);
            console.log(`📊 Total: ${anonymousSessions.length}\n`);

            anonymousSessions.forEach((session, index) => {
                console.log(`   ${index + 1}. Session ID: ${session._id}`);
                console.log(`      Patient: ${session.patientId?.name || 'Unknown'}`);
                console.log(`      Status: ${session.status}`);
                console.log(`      Created: ${session.createdAt.toLocaleString()}`);
                console.log('');
            });
        }

        console.log('\n✅ Database check complete!');
        console.log('\n💡 Summary:');
        console.log(`   - Total Doctors: ${doctors.length}`);
        console.log(`   - Total Sessions: ${await Session.countDocuments()}`);
        console.log(`   - Anonymous Sessions: ${anonymousSessions.length}`);

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
    } finally {
        await mongoose.connection.close();
        console.log('\n🔌 Database connection closed');
    }
}

checkSessionsForAllDoctors();
