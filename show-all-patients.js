import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function showAllPatients() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ Connected to MongoDB\n');

        const db = mongoose.connection.db;

        // Count total patients
        const patientsCount = await db.collection('users').countDocuments();
        console.log(`👥 Total Patients in Database: ${patientsCount}\n`);

        if (patientsCount === 0) {
            console.log('⚠️  No patients found in database');
            await mongoose.connection.close();
            return;
        }

        // Get all patients
        const patients = await db.collection('users').find().sort({ createdAt: -1 }).toArray();

        console.log('='.repeat(80));
        console.log('📋 ALL PATIENT RECORDS');
        console.log('='.repeat(80));
        console.log('');

        patients.forEach((patient, index) => {
            console.log(`${index + 1}. Patient ID: ${patient._id}`);
            console.log(`   Name: ${patient.name || 'N/A'}`);
            console.log(`   Email: ${patient.email || 'N/A'}`);
            console.log(`   Mobile: ${patient.mobile || 'N/A'}`);
            console.log(`   Age: ${patient.age || 'N/A'}`);
            console.log(`   Gender: ${patient.gender || 'N/A'}`);
            console.log(`   Blood Type: ${patient.bloodType || 'N/A'}`);
            console.log(`   Date of Birth: ${patient.dateOfBirth || 'N/A'}`);
            console.log(`   Address: ${patient.address || 'N/A'}`);
            console.log(`   Emergency Contact: ${patient.emergencyContact || 'N/A'}`);
            console.log(`   Medical History: ${patient.medicalHistory || 'N/A'}`);
            console.log(`   Allergies: ${patient.allergies || 'N/A'}`);
            console.log(`   Current Medications: ${patient.currentMedications || 'N/A'}`);
            console.log(`   Session Count: ${patient.sessionCount || 0}`);
            console.log(`   Created At: ${patient.createdAt || 'N/A'}`);
            console.log(`   Profile Picture: ${patient.profilePicture ? 'Yes' : 'No'}`);
            console.log('');
            console.log('-'.repeat(80));
            console.log('');
        });

        console.log(`\n✅ Total Patients Displayed: ${patients.length}`);

        // Summary statistics
        console.log('\n📊 STATISTICS:');
        console.log('─'.repeat(80));

        const withEmail = patients.filter(p => p.email).length;
        const withMobile = patients.filter(p => p.mobile).length;
        const withAge = patients.filter(p => p.age).length;
        const withGender = patients.filter(p => p.gender).length;
        const withBloodType = patients.filter(p => p.bloodType).length;

        console.log(`   Patients with Email: ${withEmail}`);
        console.log(`   Patients with Mobile: ${withMobile}`);
        console.log(`   Patients with Age: ${withAge}`);
        console.log(`   Patients with Gender: ${withGender}`);
        console.log(`   Patients with Blood Type: ${withBloodType}`);

        // Gender distribution
        const genderCounts = {};
        patients.forEach(p => {
            if (p.gender) {
                genderCounts[p.gender] = (genderCounts[p.gender] || 0) + 1;
            }
        });

        if (Object.keys(genderCounts).length > 0) {
            console.log('\n   Gender Distribution:');
            Object.entries(genderCounts).forEach(([gender, count]) => {
                console.log(`      ${gender}: ${count}`);
            });
        }

        // Blood type distribution
        const bloodTypeCounts = {};
        patients.forEach(p => {
            if (p.bloodType) {
                bloodTypeCounts[p.bloodType] = (bloodTypeCounts[p.bloodType] || 0) + 1;
            }
        });

        if (Object.keys(bloodTypeCounts).length > 0) {
            console.log('\n   Blood Type Distribution:');
            Object.entries(bloodTypeCounts).forEach(([type, count]) => {
                console.log(`      ${type}: ${count}`);
            });
        }

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error(error.stack);
    } finally {
        await mongoose.connection.close();
        console.log('\n🔌 Database connection closed');
    }
}

showAllPatients();
