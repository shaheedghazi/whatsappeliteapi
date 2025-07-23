# 🚀 Baileys Elite WhatsApp API Server

A complete REST API server for WhatsApp Web automation using [baileys-elite](https://www.npmjs.com/package/baileys-elite). This server exposes all baileys-elite functionality through REST endpoints that can be easily tested with Postman.

## ✨ Features

- 🔐 **Authentication**: QR Code and Pairing Code support
- 💬 **Messaging**: Text messages with AI icons
- 📱 **Interactive Messages**: Buttons, quick replies, URL buttons
- 📸 **Media Support**: Images, videos, audio, documents
- 📰 **Newsletter Management**: Create, manage, and interact with newsletters
- 🛡️ **Security**: Rate limiting, CORS, and proper error handling
- 📋 **Logging**: Comprehensive logging with Winston
- 🔄 **Auto-reconnection**: Automatic WhatsApp reconnection

## 🛠️ Installation

### Prerequisites
- Node.js (v16 or higher)
- npm or yarn
- Postman (for testing)

### Setup Steps

1. **Install Dependencies**
```powershell
npm install
```

2. **Start the Server**
```powershell
npm start
```

3. **For Development** (with auto-reload)
```powershell
npm run dev
```

The server will start on `http://localhost:3000` by default.

## 📱 WhatsApp Authentication

### Method 1: QR Code Authentication

1. **Start the server**
2. **Get QR Code**: `GET /api/qr`
3. **Scan the QR code** with your WhatsApp mobile app
4. **Check connection status**: `GET /api/status`

### Method 2: Pairing Code Authentication

1. **Request pairing code**: `POST /api/pair`
   ```json
   {
     "phoneNumber": "+1234567890",
     "customCode": "BAILEYS1"
   }
   ```
2. **Enter the code** in your WhatsApp mobile app
3. **Check connection status**: `GET /api/status`

## 📬 Postman Setup

### Import Collection

1. **Open Postman**
2. **Click Import**
3. **Select the file**: `Baileys-Elite-API.postman_collection.json`
4. **Import the collection**

### Environment Variables

Set up the following environment variable in Postman:
- `baseUrl`: `http://localhost:3000`

## 📋 API Endpoints

### 🔗 Connection Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/status` | Connection status |
| GET | `/api/qr` | Get QR code |
| POST | `/api/pair` | Request pairing code |
| POST | `/api/logout` | Logout |

### 💬 Basic Messaging

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/send/text` | Send text message |
| POST | `/api/send/media` | Send media files |

### 🎛️ Interactive Messages

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/send/buttons` | Send button message |
| POST | `/api/send/interactive` | Send interactive message |

### 📰 Newsletter Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/newsletter/:type/:identifier` | Get newsletter metadata |
| POST | `/api/newsletter/create` | Create newsletter |
| PUT | `/api/newsletter/:jid/description` | Update description |
| PUT | `/api/newsletter/:jid/name` | Update name |
| POST | `/api/newsletter/:jid/follow` | Follow newsletter |
| POST | `/api/newsletter/:jid/unfollow` | Unfollow newsletter |
| POST | `/api/newsletter/:jid/mute` | Mute newsletter |
| POST | `/api/newsletter/:jid/unmute` | Unmute newsletter |
| POST | `/api/newsletter/:jid/react` | React to message |
| DELETE | `/api/newsletter/:jid` | Delete newsletter |

## 📝 Usage Examples

### Send Text Message
```json
POST /api/send/text
{
  "to": "1234567890",
  "text": "Hello from Baileys Elite API!",
  "ai": false
}
```

### Send AI Message
```json
POST /api/send/text
{
  "to": "1234567890",
  "text": "Hello! I'm your AI assistant.",
  "ai": true
}
```

### Send Button Message
```json
POST /api/send/buttons
{
  "to": "1234567890",
  "text": "Choose an option:",
  "footer": "Select below",
  "buttons": [
    {
      "buttonId": "opt1",
      "buttonText": {
        "displayText": "Option 1"
      },
      "type": 1
    },
    {
      "buttonId": "opt2",
      "buttonText": {
        "displayText": "Option 2"
      },
      "type": 1
    }
  ]
}
```

### Send Interactive Message
```json
POST /api/send/interactive
{
  "to": "1234567890",
  "text": "Interactive Message",
  "title": "Choose Action",
  "footer": "Powered by Baileys Elite",
  "interactiveButtons": [
    {
      "name": "quick_reply",
      "buttonParamsJson": "{\"display_text\": \"Quick Reply\", \"id\": \"quick_1\"}"
    },
    {
      "name": "cta_url",
      "buttonParamsJson": "{\"display_text\": \"Visit Website\", \"url\": \"https://example.com\"}"
    },
    {
      "name": "cta_copy",
      "buttonParamsJson": "{\"display_text\": \"Copy Code\", \"id\": \"copy_1\", \"copy_code\": \"PROMO123\"}"
    }
  ]
}
```

### Send Media File
```
POST /api/send/media
Content-Type: multipart/form-data

Form Data:
- to: 1234567890
- type: image (or video, audio, document)
- caption: Check out this image!
- media: [file upload]
```

### Create Newsletter
```json
POST /api/newsletter/create
{
  "name": "My Newsletter",
  "description": "This is my awesome newsletter"
}
```

## 📱 Phone Number Format

Phone numbers can be provided in various formats:
- `1234567890` (will be converted to `1234567890@s.whatsapp.net`)
- `+1234567890`
- `1234567890@s.whatsapp.net`

## 🔒 Security Features

- **Rate Limiting**: 100 requests per 15 minutes per IP
- **CORS**: Cross-origin resource sharing enabled
- **Helmet**: Security headers
- **File Upload Limits**: 100MB maximum file size
- **Input Validation**: All inputs are validated

## 📊 Logging

All API activities are logged to:
- **Console**: Real-time logs
- **File**: `api.log` file

## 🔧 Configuration

Environment variables (optional):
- `PORT`: Server port (default: 3000)

## 📁 File Structure

```
api/
├── server.js                           # Main server file
├── package.json                        # Dependencies
├── Baileys-Elite-API.postman_collection.json # Postman collection
├── README.md                          # This file
├── auth_info_baileys/                 # WhatsApp auth data (auto-created)
├── uploads/                           # Temporary upload folder (auto-created)
└── api.log                           # Log file (auto-created)
```

## 🚨 Troubleshooting

### Common Issues

1. **Connection Failed**
   - Check if WhatsApp Web is accessible
   - Verify internet connection
   - Check server logs

2. **QR Code Not Appearing**
   - Restart the server
   - Check `/api/status` endpoint
   - Clear auth data: delete `auth_info_baileys` folder

3. **Message Sending Failed**
   - Verify WhatsApp connection: `GET /api/status`
   - Check phone number format
   - Ensure recipient has WhatsApp

4. **File Upload Issues**
   - Check file size (max 100MB)
   - Verify file type
   - Ensure proper form-data format

### Error Responses

All errors return JSON format:
```json
{
  "error": "Error description",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## 🔄 Auto-Reconnection

The server automatically handles:
- Connection drops
- Session restoration
- QR code regeneration when needed

## 📝 Response Format

All successful responses include:
```json
{
  "success": true,
  "timestamp": "2024-01-01T00:00:00.000Z",
  // ... additional response data
}
```

## 🎯 Testing with Postman

1. **Import the collection** from `Baileys-Elite-API.postman_collection.json`
2. **Set environment variable** `baseUrl` to `http://localhost:3000`
3. **Start with connection endpoints** to authenticate
4. **Test messaging endpoints** once connected
5. **Explore newsletter features** for advanced functionality

## 🤝 Contributing

Feel free to submit issues and pull requests to improve this API server.

## 📄 License

MIT License - feel free to use this project for personal or commercial purposes.

## 🙏 Acknowledgments

- [baileys-elite](https://www.npmjs.com/package/baileys-elite) - The awesome WhatsApp Web API library
- [WhiskeySockets](https://github.com/WhiskeySockets) - Original Baileys maintainers

---

**Happy WhatsApp Automation! 🎉** 