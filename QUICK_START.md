# 🚀 Quick Start Guide

Get your Baileys Elite WhatsApp API running in 5 minutes!

## 1. Start the Server

```powershell
npm start
```

You should see:
```
🚀 Server running on http://localhost:3000
📱 WhatsApp API ready for Postman testing!
```

## 2. Import Postman Collection

1. Open Postman
2. Click **Import** → **Upload Files**
3. Select `Baileys-Elite-API.postman_collection.json`
4. Set environment variable `baseUrl` = `http://localhost:3000`

## 3. Test Connection

In Postman, test these endpoints in order:

### Step 1: Health Check
```
GET {{baseUrl}}/api/health
```

### Step 2: Get Connection Status
```
GET {{baseUrl}}/api/status
```

### Step 3: Get QR Code (if needed)
```
GET {{baseUrl}}/api/qr
```
- Scan the QR code with WhatsApp mobile app

### Step 4: OR Use Pairing Code
```
POST {{baseUrl}}/api/pair
{
  "phoneNumber": "+1234567890",
  "customCode": "BAILEYS1"
}
```
- Enter the returned code in WhatsApp mobile app

## 4. Send Your First Message

Once connected (check status), send a test message:

```
POST {{baseUrl}}/api/send/text
{
  "to": "1234567890",
  "text": "Hello from Baileys Elite API! 🎉",
  "ai": false
}
```

## 5. Try Advanced Features

### Send Message with AI Icon
```
POST {{baseUrl}}/api/send/text
{
  "to": "1234567890", 
  "text": "I'm your AI assistant! 🤖",
  "ai": true
}
```

### Send Interactive Buttons
```
POST {{baseUrl}}/api/send/interactive
{
  "to": "1234567890",
  "text": "Choose an option:",
  "title": "Interactive Menu",
  "footer": "Powered by Baileys Elite",
  "interactiveButtons": [
    {
      "name": "quick_reply",
      "buttonParamsJson": "{\"display_text\": \"Option 1\", \"id\": \"opt1\"}"
    },
    {
      "name": "quick_reply", 
      "buttonParamsJson": "{\"display_text\": \"Option 2\", \"id\": \"opt2\"}"
    }
  ]
}
```

## 🎯 Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| Server won't start | Run `npm install` first |
| QR not showing | Check `/api/status`, restart server if needed |
| Messages not sending | Verify WhatsApp connection with `/api/status` |
| Invalid phone number | Use format: `1234567890` or `+1234567890` |

## 📱 Phone Number Tips

- Use international format: `+1234567890`
- Or just numbers: `1234567890` 
- API auto-converts to WhatsApp format

## 🔄 Reconnection

If WhatsApp disconnects:
1. Check `/api/status`
2. Get new QR: `/api/qr`
3. Re-scan with mobile app

## 📋 Next Steps

Once basic messaging works:
- Explore newsletter features
- Try media uploads
- Test button interactions
- Set up webhooks for incoming messages

## 🆘 Need Help?

1. Check console logs
2. View `api.log` file
3. Test `/api/health` endpoint
4. Restart server: `Ctrl+C` then `npm start`

---

**You're ready to automate WhatsApp! 🎉** 