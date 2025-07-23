# 🚀 Baileys Elite WhatsApp API Server

A complete REST API server for WhatsApp Web automation using [baileys-elite](https://www.npmjs.com/package/baileys-elite). This server exposes messaging and interactive features through REST endpoints that can be easily tested with Postman.

## ✨ Features

- 🔐 **Authentication**: QR Code and Pairing Code support
- 💬 **Messaging**: Text messages with AI icons
- 📱 **Interactive Messages**: Buttons, quick replies, URL buttons
- 📸 **Media Support**: Images, videos, audio, documents
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
| POST | `/api/send/buttons/text` | Send text button message |
| POST | `/api/send/buttons/image` | Send image button message |
| POST | `/api/send/buttons/video` | Send video button message |
| POST | `/api/send/interactive/advanced` | Send advanced interactive message |
| POST | `/api/send/interactive/image` | Send rich media interactive (image) |
| POST | `/api/send/interactive/video` | Send rich media interactive (video) |

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

### 📝 Send Text Button Message
```json
POST /api/send/buttons/text
{
  "to": "1234567890",
  "text": "Hi it's button message",
  "footer": "Hello World",
  "buttons": [
    {
      "buttonId": "id1",
      "buttonText": {
        "displayText": "Button 1"
      },
      "type": 1
    },
    {
      "buttonId": "id2",
      "buttonText": {
        "displayText": "Button 2"
      },
      "type": 1
    }
  ],
  "headerType": 1,
  "viewOnce": true,
  "quoted": null
}
```

### 🖼️ Send Image Button Message
```json
POST /api/send/buttons/image
{
  "to": "1234567890",
  "image": "https://example.com/abcd.jpg",
  "caption": "Hi it's button message with image",
  "footer": "Hello World",
  "buttons": [
    {
      "buttonId": "id1",
      "buttonText": {
        "displayText": "Button 1"
      },
      "type": 1
    },
    {
      "buttonId": "id2",
      "buttonText": {
        "displayText": "Button 2"
      },
      "type": 1
    }
  ],
  "headerType": 1,
  "viewOnce": true,
  "quoted": null
}
```

### 🎬 Send Video Button Message
```json
POST /api/send/buttons/video
{
  "to": "1234567890",
  "video": "https://example.com/abcd.mp4",
  "caption": "Hi it's button message with video",
  "footer": "Hello World",
  "buttons": [
    {
      "buttonId": "id1",
      "buttonText": {
        "displayText": "Button 1"
      },
      "type": 1
    },
    {
      "buttonId": "id2",
      "buttonText": {
        "displayText": "Button 2"
      },
      "type": 1
    }
  ],
  "headerType": 1,
  "viewOnce": true,
  "quoted": null
}
```

### 🔄 Send Advanced Interactive Message
```json
POST /api/send/interactive/advanced
{
  "to": "1234567890",
  "text": "Hello World!",
  "title": "this is the title",
  "footer": "this is the footer",
  "interactiveButtons": [
    {
      "name": "quick_reply",
      "buttonParamsJson": "{\"display_text\": \"Quick Reply\", \"id\": \"ID\"}"
    },
    {
      "name": "cta_url",
      "buttonParamsJson": "{\"display_text\": \"Tap Here!\", \"url\": \"https://www.example.com/\"}"
    },
    {
      "name": "cta_copy",
      "buttonParamsJson": "{\"display_text\": \"Copy Code\", \"id\": \"12345\", \"copy_code\": \"12345\"}"
    }
  ],
  "quoted": null
}
```

### 🖼️ Send Rich Media Interactive Message (Image)
```json
POST /api/send/interactive/image
{
  "to": "1234567890",
  "image": "https://example.com/abcd.jpg",
  "caption": "Check out this amazing photo!",
  "title": "Photo Showcase",
  "footer": "Tap a button below",
  "interactiveButtons": [
    {
      "name": "quick_reply",
      "buttonParamsJson": "{\"display_text\": \"Quick Reply\", \"id\": \"ID\"}"
    },
    {
      "name": "cta_url",
      "buttonParamsJson": "{\"display_text\": \"Visit Website\", \"url\": \"https://www.example.com/\"}"
    }
  ],
  "quoted": null
}
```

### 🎬 Send Rich Media Interactive Message (Video)
```json
POST /api/send/interactive/video
{
  "to": "1234567890",
  "video": "https://example.com/abcd.mp4",
  "caption": "Watch this awesome video!",
  "title": "Video Showcase",
  "footer": "Tap a button below",
  "interactiveButtons": [
    {
      "name": "quick_reply",
      "buttonParamsJson": "{\"display_text\": \"Quick Reply\", \"id\": \"ID\"}"
    },
    {
      "name": "cta_url",
      "buttonParamsJson": "{\"display_text\": \"Visit Website\", \"url\": \"https://www.example.com/\"}"
    }
  ],
  "quoted": null
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

## 🚀 Quick Start

1. **Clone and install**
```powershell
npm install
npm start
```

2. **Import Postman collection** (`Baileys-Elite-API.postman_collection.json`)

3. **Test connection** with `GET /api/health`

4. **Get QR code** with `GET /api/qr` and scan with WhatsApp

5. **Send your first message** with `POST /api/send/text`

## 🏗️ Architecture

- **Express.js**: REST API framework
- **baileys-elite**: WhatsApp Web automation
- **Winston**: Logging system
- **Multer**: File upload handling
- **Helmet**: Security middleware

## 📦 Package Features

- Lightweight and fast
- Auto-reconnection to WhatsApp
- File upload support
- Rate limiting protection
- Comprehensive error handling
- Cross-platform compatibility

## 🔧 Configuration

Environment variables (optional):
- `PORT`: Server port (default: 3000)

## 🤝 Contributing

Feel free to submit issues and pull requests to improve this API server.

## 📄 License

MIT License - feel free to use this project for personal or commercial purposes.

## 🙏 Acknowledgments

- [baileys-elite](https://www.npmjs.com/package/baileys-elite) - The awesome WhatsApp Web API library
- [WhiskeySockets](https://github.com/WhiskeySockets) - Original Baileys maintainers

---

**Happy WhatsApp Automation! 🎉** 