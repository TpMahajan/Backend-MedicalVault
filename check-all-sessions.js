import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// Define schemas directly to avoid import issues
const sessionSchema = new mongoose.Schema({
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'DoctorUser' },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    status: String,
    diagnosis: String,
    notes: String,
    createdAt: Date,
    expiresAt: Date,
    endedAt: Date
}, { timestamps: true });

const doctorSchema = new mongoose.Schema({
    name: String,
    email: String
});

const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema, 'sessions');
const DoctorUser = mongoose.models.DoctorUser || mongoose.model('DoctorUser', doctorSchema, 'doctorusers');

async function checkAllSessions() {
    try {
        console.log('🔌 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB\n');

        // Find Dr. Yash
        const yash = await DoctorUser.findOne({ email: 'yash14@gmail.com' });
        if (!yash) {
            console.log('❌ Dr. Yash not found in database');
            await mongoose.connection.close();
            return;
        }

        console.log(`👨‍⚕️ Dr. Yash ID: ${yash._id}`);
        console.log(`📧 Email: ${yash.email}\n`);

        // Find ALL sessions for Dr. Yash
        const yashSessions = await Session.find({ doctorId: yash._id })
            .populate('patientId', 'name email')
            .sort({ createdAt: -1 });

        console.log(`📊 Total Sessions for Dr. Yash: ${yashSessions.length}\n`);

        if (yashSessions.length === 0) {
            console.log('⚠️  No sessions found for Dr. Yash');
        } else {
            console.log('📋 Sessions for Dr. Yash:\n');
            yashSessions.forEach((session, index) => {
                console.log(`${index + 1}. Session ID: ${session._id}`);
                console.log(`   Patient: ${session.patientId?.name || 'Unknown'}`);
                console.log(`   Status: ${session.status}`);
                console.log(`   Created: ${session.createdAt}`);
                console.log(`   Diagnosis: ${session.diagnosis || 'Not recorded'}`);
                console.log(`   Notes: ${session.notes || 'Not recorded'}`);
                console.log('');
            });
        }

        // Check total sessions in database
        const totalSessions = await Session.countDocuments();
        console.log(`\n📊 Total Sessions in Entire Database: ${totalSessions}`);

        // Show all sessions
        const allSessions = await Session.find()
            .populate('doctorId', 'name email')
            .populate('patientId', 'name email')
            .sort({ createdAt: -1 })
            .limit(20);

        console.log('\n📋 All Sessions in Database (up to 20):\n');
        allSessions.forEach((session, index) => {
            console.log(`${index + 1}. Session ID: ${session._id}`);
            console.log(`   Doctor: ${session.doctorId?.name || 'Unknown'} (${session.doctorId?.email || 'N/A'})`);
            console.log(`   Patient: ${session.patientId?.name || 'Unknown'} (${session.patientId?.email || 'N/A'})`);
            console.log(`   Status: ${session.status}`);
            console.log(`   Created: ${session.createdAt}`);
            console.log(`   Diagnosis: ${session.diagnosis || 'Not recorded'}`);
            console.log('');
        });

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
    } finally {
        await mongoose.connection.close();
        console.log('\n🔌 Database connection closed');
    }
}

checkAllSessions();
