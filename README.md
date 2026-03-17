# Flutter App Backend API

A secure, production-ready Node.js backend with MongoDB, JWT authentication, and Firebase Cloud Messaging (FCM) integration for Flutter applications.

## 🚀 Features

- **Secure Authentication**: JWT-based user authentication with bcrypt password hashing
- **MongoDB Integration**: Mongoose ODM with proper connection handling
- **Push Notifications**: Firebase Cloud Messaging (FCM) integration
- **Security**: Helmet.js, CORS, rate limiting, input validation
- **Production Ready**: Error handling, logging, compression, graceful shutdown
- **RESTful API**: Clean, documented endpoints with consistent response format

## 📋 Prerequisites

- Node.js 18+ 
- MongoDB Atlas account (or local MongoDB)
- Firebase project with Admin SDK
- npm or yarn package manager

## 🛠️ Installation

1. **Clone and navigate to the backend directory:**
   ```bash
   cd app-backend
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up environment variables:**
   ```bash
   cp env.example.bak .env
   ```
   
   Edit `.env` with your configuration:
   ```env
   # MongoDB Configuration
   MONGO_URI=mongodb+srv://username:password@cluster.mongodb.net/database
   
   # JWT Configuration
   JWT_SECRET=your-super-secret-jwt-key-here
   JWT_EXPIRES_IN=7d
   
   # Server Configuration
   PORT=5000
   NODE_ENV=development
   
   # Firebase Admin SDK (for FCM)
   FIREBASE_PROJECT_ID=your-firebase-project-id
   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYour Private Key Here\n-----END PRIVATE KEY-----\n"
   FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
   # ... other Firebase config
   ```

4. **Start the server:**
   ```bash
   # Development mode with auto-reload
   npm run dev
   
   # Production mode
   npm start
   ```

## 🔧 Configuration

### MongoDB Atlas Setup
1. Create a MongoDB Atlas account
2. Create a new cluster
3. Get your connection string
4. Add your IP to the whitelist
5. Create a database user with read/write permissions

### Firebase Setup
1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Create a new project or select existing
3. Go to Project Settings > Service Accounts
4. Generate new private key
5. Download the JSON file and copy values to `.env`

## 📚 API Documentation

### Base URL
```
http://localhost:5000/api
```

### Authentication Endpoints

#### Register User
```http
POST /auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "SecurePass123",
  "name": "John Doe"
}
```

**Response:**
```json
{
  "success": true,
  "message": "User registered successfully",
  "data": {
    "user": {
      "id": "user_id",
      "email": "user@example.com",
      "name": "John Doe",
      "createdAt": "2024-01-01T00:00:00.000Z"
    },
    "token": "jwt_token_here"
  }
}
```

#### Login User
```http
POST /auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "SecurePass123"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "user": {
      "id": "user_id",
      "email": "user@example.com",
      "name": "John Doe",
      "profilePicture": null,
      "lastLogin": "2024-01-01T00:00:00.000Z",
      "createdAt": "2024-01-01T00:00:00.000Z"
    },
    "token": "jwt_token_here"
  }
}
```

#### Get Current User Profile
```http
GET /auth/me
Authorization: Bearer jwt_token_here
```

#### Logout User
```http
POST /auth/logout
Authorization: Bearer jwt_token_here
```

### User Management Endpoints

#### Update Profile
```http
PUT /user/profile
Authorization: Bearer jwt_token_here
Content-Type: application/json

{
  "name": "John Smith",
  "profilePicture": "https://example.com/avatar.jpg"
}
```

#### Update FCM Token
```http
PUT /user/fcm-token
Authorization: Bearer jwt_token_here
Content-Type: application/json

{
  "fcmToken": "firebase_fcm_token_here"
}
```

#### Get User Profile (Public)
```http
GET /user/:userId
```

#### Delete Account
```http
DELETE /user/account
Authorization: Bearer jwt_token_here
```

### Notification Endpoints

#### Send Notification to User
```http
POST /notifications/send
Authorization: Bearer jwt_token_here
Content-Type: application/json

{
  "userId": "target_user_id",
  "title": "Hello!",
  "body": "This is a test notification",
  "data": {
    "type": "message",
    "senderId": "current_user_id"
  }
}
```

#### Send Bulk Notifications
```http
POST /notifications/send-bulk
Authorization: Bearer jwt_token_here
Content-Type: application/json

{
  "userIds": ["user1_id", "user2_id", "user3_id"],
  "title": "Group Notification",
  "body": "This is a group message",
  "data": {
    "type": "announcement"
  }
}
```

#### Send to All Users
```http
POST /notifications/send-all
Authorization: Bearer jwt_token_here
Content-Type: application/json

{
  "title": "App Update",
  "body": "New version available!",
  "data": {
    "type": "update",
    "version": "2.0.0"
  }
}
```

## 🔐 Authentication

All protected endpoints require a JWT token in the Authorization header:

```
Authorization: Bearer your_jwt_token_here
```

## 📱 Flutter Integration

### HTTP Service Class
```dart
import 'dart:convert';
import 'package:http/http.dart' as http;

class ApiService {
  static const String baseUrl = 'http://localhost:5000/api';
  static String? authToken;

  // Headers
  static Map<String, String> get _headers => {
    'Content-Type': 'application/json',
    if (authToken != null) 'Authorization': 'Bearer $authToken',
  };

  // Register
  static Future<Map<String, dynamic>> register({
    required String email,
    required String password,
    required String name,
  }) async {
    try {
      final response = await http.post(
        Uri.parse('$baseUrl/auth/register'),
        headers: _headers,
        body: jsonEncode({
          'email': email,
          'password': password,
          'name': name,
        }),
      );

      final data = jsonDecode(response.body);
      
      if (response.statusCode == 201 && data['success']) {
        authToken = data['data']['token'];
        return data['data'];
      } else {
        throw Exception(data['message'] ?? 'Registration failed');
      }
    } catch (e) {
      throw Exception('Network error: $e');
    }
  }

  // Login
  static Future<Map<String, dynamic>> login({
    required String email,
    required String password,
  }) async {
    try {
      final response = await http.post(
        Uri.parse('$baseUrl/auth/login'),
        headers: _headers,
        body: jsonEncode({
          'email': email,
          'password': password,
        }),
      );

      final data = jsonDecode(response.body);
      
      if (response.statusCode == 200 && data['success']) {
        authToken = data['data']['token'];
        return data['data'];
      } else {
        throw Exception(data['message'] ?? 'Login failed');
      }
    } catch (e) {
      throw Exception('Network error: $e');
    }
  }

  // Get Profile
  static Future<Map<String, dynamic>> getProfile() async {
    try {
      final response = await http.get(
        Uri.parse('$baseUrl/auth/me'),
        headers: _headers,
      );

      final data = jsonDecode(response.body);
      
      if (response.statusCode == 200 && data['success']) {
        return data['data']['user'];
      } else {
        throw Exception(data['message'] ?? 'Failed to get profile');
      }
    } catch (e) {
      throw Exception('Network error: $e');
    }
  }

  // Update FCM Token
  static Future<void> updateFCMToken(String fcmToken) async {
    try {
      final response = await http.put(
        Uri.parse('$baseUrl/user/fcm-token'),
        headers: _headers,
        body: jsonEncode({
          'fcmToken': fcmToken,
        }),
      );

      final data = jsonDecode(response.body);
      
      if (response.statusCode != 200 || !data['success']) {
        throw Exception(data['message'] ?? 'Failed to update FCM token');
      }
    } catch (e) {
      throw Exception('Network error: $e');
    }
  }

  // Logout
  static void logout() {
    authToken = null;
  }
}
```

### Usage Example
```dart
import 'package:flutter/material.dart';
import 'api_service.dart';

class LoginScreen extends StatefulWidget {
  @override
  _LoginScreenState createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _isLoading = false;

  Future<void> _login() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() => _isLoading = true);

    try {
      final userData = await ApiService.login(
        email: _emailController.text,
        password: _passwordController.text,
      );
      
      // Navigate to home screen
      Navigator.pushReplacementNamed(context, '/home');
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.toString())),
      );
    } finally {
      setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('Login')),
      body: Padding(
        padding: EdgeInsets.all(16.0),
        child: Form(
          key: _formKey,
          child: Column(
            children: [
              TextFormField(
                controller: _emailController,
                decoration: InputDecoration(labelText: 'Email'),
                validator: (value) =>
                    value?.isEmpty ?? true ? 'Email is required' : null,
              ),
              SizedBox(height: 16),
              TextFormField(
                controller: _passwordController,
                decoration: InputDecoration(labelText: 'Password'),
                obscureText: true,
                validator: (value) =>
                    value?.isEmpty ?? true ? 'Password is required' : null,
              ),
              SizedBox(height: 24),
              ElevatedButton(
                onPressed: _isLoading ? null : _login,
                child: _isLoading
                    ? CircularProgressIndicator()
                    : Text('Login'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
```

## 🚀 Deployment

### Environment Variables
- Set `NODE_ENV=production`
- Use strong `JWT_SECRET`
- Configure production MongoDB URI
- Set up Firebase Admin SDK credentials

### PM2 (Recommended)
```bash
npm install -g pm2
pm2 start server.js --name "flutter-backend"
pm2 save
pm2 startup
```

### Docker
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 5000
CMD ["npm", "start"]
```

## 🔒 Security Features

- **Password Hashing**: bcrypt with salt rounds
- **JWT Tokens**: Secure, time-limited authentication
- **Input Validation**: Express-validator with sanitization
- **Rate Limiting**: Protection against brute force attacks
- **CORS**: Configurable cross-origin resource sharing
- **Helmet.js**: Security headers and CSP
- **MongoDB Injection Protection**: Mongoose ODM

## 📊 Monitoring & Logging

- **Morgan**: HTTP request logging
- **Error Handling**: Global error handler with stack traces
- **Health Check**: `/health` endpoint for monitoring
- **Process Management**: Graceful shutdown handling

## 🧪 Testing

```bash
# Run tests
npm test

# Run tests in watch mode
npm run test:watch
```

## 📝 License

MIT License - see LICENSE file for details

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## 📞 Support

For support and questions:
- Create an issue in the repository
- Check the API documentation
- Review the error logs

---

**Happy Coding! 🚀**
