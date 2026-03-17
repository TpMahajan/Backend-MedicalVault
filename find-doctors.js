import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const sessionSchema = new mongoose.Schema({
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'DoctorUser' },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    status: String,
    diagnosis: String,
    notes: String,
    createdAt: Date
}, { timestamps: true });

const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema, 'sessions');
const DoctorUser = mongoose.models.DoctorUser || mongoose.model('DoctorUser', {}, 'doctorusers');

async function findDoctors() {
    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected\n');

        // Find all doctors
        const doctors = await DoctorUser.find().limit(10);
        console.log(`👨‍⚕️ Found ${doctors.length} doctors:\n`);

        doctors.forEach((doc, i) => {
            console.log(`${i + 1}. Name: ${doc.name || 'N/A'}`);
            console.log(`   Email: ${doc.email || 'N/A'}`);
            console.log(`   ID: ${doc._id}`);
            console.log('');
        });

        // Find all sessions
        const sessions = await Session.find()
            .populate('doctorId')
            .populate('patientId')
            .sort({ createdAt: -1 });

        console.log(`\n📊 Total Sessions: ${sessions.length}\n`);

        sessions.forEach((s, i) => {
            console.log(`${i + 1}. ID: ${s._id}`);
            console.log(`   Doctor ID: ${s.doctorId?._id || s.doctorId || 'N/A'}`);
            console.log(`   Patient ID: ${s.patientId?._id || s.patientId || 'N/A'}`);
            console.log(`   Status: ${s.status}`);
            console.log(`   Created: ${s.createdAt}`);
            console.log('');
        });

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await mongoose.connection.close();
    }
}

findDoctors();
