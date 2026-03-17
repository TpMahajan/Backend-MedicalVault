import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function checkDoctorPatients() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB\n');

        const db = mongoose.connection.db;

        // Find Dr. Yash
        const yash = await db.collection('doctorusers').findOne({ name: /yash/i });

        if (!yash) {
            console.log('❌ Dr. Yash not found');

            // List all doctors
            const doctors = await db.collection('doctorusers').find().limit(5).toArray();
            console.log('\n📋 Available Doctors:');
            doctors.forEach((d, i) => {
                console.log(`${i + 1}. ${d.name} (${d.email}) - ID: ${d._id}`);
            });

            await mongoose.connection.close();
            return;
        }

        console.log(`👨‍⚕️ Dr. Yash ID: ${yash._id}`);
        console.log(`📧 Email: ${yash.email}\n`);

        // Find all sessions for Dr. Yash
        const sessions = await db.collection('sessions').find({ doctorId: yash._id }).toArray();
        console.log(`📊 Total Sessions for Dr. Yash: ${sessions.length}\n`);

        if (sessions.length > 0) {
            console.log('📋 Sessions:\n');
            for (const session of sessions) {
                const patient = await db.collection('users').findOne({ _id: session.patientId });
                console.log(`   - Patient: ${patient?.name || 'Unknown'} (ID: ${session.patientId})`);
                console.log(`     Status: ${session.status}`);
                console.log(`     Created: ${session.createdAt}`);
                console.log('');
            }
        }

        // Find all appointments for Dr. Yash
        const appointments = await db.collection('appointments').find({ doctorId: yash._id }).toArray();
        console.log(`\n📅 Total Appointments for Dr. Yash: ${appointments.length}\n`);

        if (appointments.length > 0) {
            console.log('📋 Appointments:\n');
            for (const appt of appointments) {
                const patient = await db.collection('users').findOne({ _id: appt.patientId });
                console.log(`   - Patient: ${patient?.name || 'Unknown'} (ID: ${appt.patientId})`);
                console.log(`     Status: ${appt.status}`);
                console.log('');
            }
        }

        // Get unique patient IDs
        const sessionPatientIds = sessions.map(s => s.patientId?.toString()).filter(Boolean);
        const appointmentPatientIds = appointments.map(a => a.patientId?.toString()).filter(Boolean);
        const allPatientIds = [...new Set([...sessionPatientIds, ...appointmentPatientIds])];

        console.log(`\n📊 Total Unique Patients for Dr. Yash: ${allPatientIds.length}\n`);

        if (allPatientIds.length > 0) {
            console.log('📋 Patient Details:\n');
            for (const patientId of allPatientIds) {
                const patient = await db.collection('users').findOne({ _id: new mongoose.Types.ObjectId(patientId) });
                if (patient) {
                    console.log(`   - ${patient.name}`);
                    console.log(`     Email: ${patient.email}`);
                    console.log(`     Mobile: ${patient.mobile || 'N/A'}`);
                    console.log(`     ID: ${patient._id}`);
                    console.log('');
                }
            }
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await mongoose.connection.close();
        console.log('🔌 Disconnected');
    }
}

checkDoctorPatients();
