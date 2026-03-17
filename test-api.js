import fetch from 'node-fetch';

async function testSessionHistoryAPI() {
    try {
        console.log('🧪 Testing Session History API Endpoint\n');

        // First, login as a doctor to get a token
        console.log('1️⃣ Logging in as doctor...');
        const loginResponse = await fetch('http://localhost:5000/api/doctor-auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                email: 'yash14@gmail.com',
                password: 'yash14' // Try common password
            })
        });

        if (!loginResponse.ok) {
            console.log('❌ Login failed. Trying alternative credentials...');

            // Try another login
            const altLoginResponse = await fetch('http://localhost:5000/api/doctor-auth/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    email: 'yash14@gmail.com',
                    password: 'password123'
                })
            });

            if (!altLoginResponse.ok) {
                const errorText = await altLoginResponse.text();
                console.log('❌ Alternative login also failed:', errorText);
                console.log('\n💡 Please provide the correct password for yash14@gmail.com');
                return;
            }

            const altLoginData = await altLoginResponse.json();
            console.log('✅ Logged in successfully with alternative credentials\n');
            await testWithToken(altLoginData.token);
            return;
        }

        const loginData = await loginResponse.json();
        console.log('✅ Logged in successfully\n');

        await testWithToken(loginData.token);

    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

async function testWithToken(token) {
    console.log('2️⃣ Fetching all sessions for this doctor...');

    const sessionsResponse = await fetch('http://localhost:5000/api/sessions/all-sessions', {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    });

    if (!sessionsResponse.ok) {
        const errorText = await sessionsResponse.text();
        console.log('❌ Failed to fetch sessions:', errorText);
        return;
    }

    const sessionsData = await sessionsResponse.json();

    console.log('✅ Sessions fetched successfully!\n');
    console.log(`📊 Total Sessions: ${sessionsData.count}\n`);

    if (sessionsData.count === 0) {
        console.log('⚠️  No sessions found for this doctor.');
        console.log('💡 This doctor may not have any sessions yet.\n');
    } else {
        console.log('📋 Session Details:\n');
        sessionsData.sessions.forEach((session, index) => {
            console.log(`${index + 1}. ${session.patientName} (${session.patientId})`);
            console.log(`   Date: ${session.date} at ${session.time}`);
            console.log(`   Type: ${session.type}`);
            console.log(`   Status: ${session.status}`);
            console.log(`   Duration: ${session.duration}`);
            console.log(`   Diagnosis: ${session.diagnosis}`);
            console.log(`   Payment: ${session.paymentStatus}`);
            console.log('');
        });
    }

    console.log('\n✅ API Endpoint is working correctly!');
    console.log('✅ Session History page should display this data.');
}

testSessionHistoryAPI();
