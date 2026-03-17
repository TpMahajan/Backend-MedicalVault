// Test script to verify the /api/doctors/patients endpoint
// This script tests the MongoDB connection and patient fetching

import fetch from 'node-fetch';

const API_BASE = 'http://localhost:5000';

async function testDoctorPatientsEndpoint() {
    console.log('🧪 Testing /api/doctors/patients endpoint\n');

    // You need to replace this with a valid doctor JWT token
    // To get a token, log in as a doctor through the frontend
    const doctorToken = process.env.DOCTOR_TOKEN || 'YOUR_DOCTOR_JWT_TOKEN_HERE';

    if (doctorToken === 'YOUR_DOCTOR_JWT_TOKEN_HERE') {
        console.log('❌ Please set DOCTOR_TOKEN environment variable or update the script with a valid token');
        console.log('💡 To get a token:');
        console.log('   1. Log in as a doctor in the frontend');
        console.log('   2. Open browser console');
        console.log('   3. Run: localStorage.getItem("token")');
        console.log('   4. Copy the token and set it as DOCTOR_TOKEN environment variable\n');
        return;
    }

    try {
        console.log('📡 Sending request to:', `${API_BASE}/api/doctors/patients`);
        console.log('🔑 Using token:', doctorToken.substring(0, 20) + '...\n');

        const response = await fetch(`${API_BASE}/api/doctors/patients`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${doctorToken}`,
                'Content-Type': 'application/json'
            }
        });

        console.log('📊 Response Status:', response.status, response.statusText);

        const data = await response.json();

        if (response.ok && data.success) {
            console.log('✅ Success! Fetched patients from MongoDB\n');
            console.log('📋 Patient Count:', data.count);
            console.log('\n👥 Patients:');
            console.log('─'.repeat(80));

            if (data.patients && data.patients.length > 0) {
                data.patients.forEach((patient, index) => {
                    console.log(`\n${index + 1}. ${patient.name}`);
                    console.log(`   ID: ${patient.id}`);
                    console.log(`   Email: ${patient.email}`);
                    console.log(`   Phone: ${patient.phone}`);
                    console.log(`   Age: ${patient.age} | Gender: ${patient.gender} | Blood Type: ${patient.bloodType}`);
                    console.log(`   Last Visit: ${patient.lastVisit}`);
                    console.log(`   Status: ${patient.status}`);
                    console.log(`   Total Sessions: ${patient.totalSessions}`);
                    console.log(`   Session Status: ${patient.sessionStatus}`);
                });
            } else {
                console.log('\n   No patients found for this doctor.');
                console.log('   💡 This doctor has not scanned any patient QR codes yet.');
            }

            console.log('\n' + '─'.repeat(80));
            console.log('\n✅ Test completed successfully!');

        } else {
            console.log('❌ Request failed\n');
            console.log('Error:', data.message || 'Unknown error');
            console.log('Full response:', JSON.stringify(data, null, 2));
        }

    } catch (error) {
        console.error('❌ Test failed with error:', error.message);
        console.error('\nPossible issues:');
        console.error('  - Backend server is not running (check http://localhost:5000)');
        console.error('  - Invalid JWT token');
        console.error('  - MongoDB connection issue');
        console.error('  - Network error\n');
    }
}

// Run the test
testDoctorPatientsEndpoint();
