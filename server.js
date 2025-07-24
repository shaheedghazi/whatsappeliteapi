const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const QRCode = require('qrcode');
const qrCodeTerminal = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const pino = require('pino');
require('dotenv').config();

// Import baileys-elite
const makeWASocket = require('baileys-elite').default;
const { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('baileys-elite');

const app = express();
const PORT = process.env.PORT || 3000;

// Winston logger for API logs
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'api.log' })
    ]
});

// Pino logger for baileys-elite (supports trace method)
const baleysLogger = pino({
    level: 'silent' // Set to 'debug' for more verbose logging
});

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// File upload setup
const upload = multer({
    dest: 'uploads/',
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

// Global variables
let sock = null;
let qr = null;
let isConnected = false;
let connectionState = 'disconnected';
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;

// Initialize WhatsApp connection
async function initializeWhatsApp() {
    try {
        // Get latest version info
        const { version, isLatest } = await fetchLatestBaileysVersion();
        logger.info(`Using Baileys version: ${version.join('.')}, Latest: ${isLatest}`);
        
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        
        sock = makeWASocket({
            auth: state,
            version,
            printQRInTerminal: false,
            logger: baleysLogger,
            browser: Browsers.macOS('Desktop'),
            connectTimeoutMs: 60000, // 60 seconds timeout
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 1000,
            markOnlineOnConnect: true,
            syncFullHistory: false, // Disable for faster connection
            fireInitQueries: true,
            generateHighQualityLinkPreview: true,
            // Add mobile configuration for better compatibility
            mobile: false,
            // Add message retry configuration
            msgRetryCounterMap: new Map(),
            getMessage: async (key) => {
                // Return empty message for retry mechanism
                return { conversation: '' };
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr: newQr, receivedPendingNotifications } = update;
            
            if (newQr) {
                qr = newQr;
                logger.info('QR Code received');
                
                // Display QR code in terminal
                console.log('\n📱 Scan this QR code with your WhatsApp mobile app:');
                console.log('═'.repeat(60));
                qrCodeTerminal.generate(newQr, { small: true });
                console.log('═'.repeat(60));
                console.log('💡 Tip: You can also get the QR via API: GET /api/qr');
                console.log('🔗 Or use pairing code: POST /api/pair\n');
            }
            
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                const reason = lastDisconnect?.error?.output?.statusCode;
                
                logger.info(`Connection closed - Reason: ${reason}, Should reconnect: ${shouldReconnect}`);
                
                if (shouldReconnect && reconnectAttempts < maxReconnectAttempts) {
                    reconnectAttempts++;
                    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000); // Exponential backoff
                    
                    console.log(`🔄 Reconnecting to WhatsApp... (Attempt ${reconnectAttempts}/${maxReconnectAttempts})`);
                    console.log(`⏰ Waiting ${delay/1000} seconds before retry...\n`);
                    
                    setTimeout(() => {
                        initializeWhatsApp();
                    }, delay);
                } else if (reconnectAttempts >= maxReconnectAttempts) {
                    console.log('❌ Max reconnection attempts reached. Please restart the server.');
                    logger.error('Max reconnection attempts reached');
                } else {
                    console.log('🚫 Logged out - Please restart server and scan QR again');
                }
                
                isConnected = false;
                connectionState = 'disconnected';
            } else if (connection === 'open') {
                reconnectAttempts = 0; // Reset counter on successful connection
                logger.info('WhatsApp connected successfully');
                console.log('\n✅ WhatsApp connected successfully!');
                console.log('🎉 Ready to send messages via Postman!\n');
                isConnected = true;
                connectionState = 'connected';
                qr = null;
            } else if (connection === 'connecting') {
                console.log('🔄 Connecting to WhatsApp...');
                connectionState = 'connecting';
            }
            
            if (receivedPendingNotifications) {
                console.log('📬 Received pending notifications');
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', (m) => {
            logger.info('New message received:', JSON.stringify(m, null, 2));
        });

        // Track message receipts and delivery
        sock.ev.on('message-receipt.update', (update) => {
            logger.info('Message receipt update:', JSON.stringify(update, null, 2));
            for (const receipt of update) {
                console.log(`📬 Message ${receipt.key.id}: ${receipt.receipt.receiptTimestamp ? 'delivered' : 'pending'}`);
            }
        });

        // Track presence updates
        sock.ev.on('presence.update', (update) => {
            logger.info('Presence update:', JSON.stringify(update, null, 2));
        });

        // Handle authentication failures
        sock.ev.on('CB:xmlstreamend', () => {
            console.log('🔄 Stream ended, reconnecting...');
            if (isConnected) {
                initializeWhatsApp();
            }
        });

        // Handle WebSocket errors
        sock.ws?.on('error', (error) => {
            logger.error('WebSocket error:', error);
            console.log('⚠️ WebSocket error occurred, will attempt to reconnect...');
        });

    } catch (error) {
        logger.error('Failed to initialize WhatsApp:', error);
        console.error('❌ Initialization error:', error.message);
        
        // Retry initialization after delay
        if (reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++;
            setTimeout(() => {
                console.log(`🔄 Retrying initialization... (${reconnectAttempts}/${maxReconnectAttempts})`);
                initializeWhatsApp();
            }, 5000);
        }
    }
}

// Helper function to validate WhatsApp ID
function formatWhatsAppId(id) {
    if (!id) return null;
    
    // Remove any non-digit characters except @ and :
    let cleanId = id.replace(/[^\d@:]/g, '');
    
    // If it doesn't contain @, add @s.whatsapp.net
    if (!cleanId.includes('@')) {
        cleanId = cleanId + '@s.whatsapp.net';
    }
    
    return cleanId;
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        connection: connectionState,
        connected: isConnected
    });
});

// Get connection status
app.get('/api/status', (req, res) => {
    res.json({
        connected: isConnected,
        connectionState: connectionState,
        hasQR: !!qr,
        timestamp: new Date().toISOString()
    });
});

// Get QR Code
app.get('/api/qr', async (req, res) => {
    try {
        if (!qr) {
            return res.status(404).json({ error: 'No QR code available' });
        }
        
        const qrImage = await QRCode.toDataURL(qr);
        res.json({
            qr: qr,
            qrImage: qrImage
        });
    } catch (error) {
        logger.error('QR generation error:', error);
        res.status(500).json({ error: 'Failed to generate QR code' });
    }
});

// Request pairing code
app.post('/api/pair', async (req, res) => {
    try {
        const { phoneNumber, customCode } = req.body;
        
        if (!phoneNumber) {
            return res.status(400).json({ error: 'Phone number is required' });
        }
        
        if (!sock) {
            return res.status(400).json({ error: 'WhatsApp not initialized' });
        }
        
        const code = await sock.requestPairingCode(phoneNumber, customCode || "BAILEYS1");
        
        // Display pairing code in terminal too
        console.log('\n📱 Pairing Code for', phoneNumber);
        console.log('═'.repeat(40));
        console.log(`🔑 Code: ${code?.match(/.{1,4}/g)?.join('-') || code}`);
        console.log('═'.repeat(40));
        console.log('💡 Enter this code in your WhatsApp mobile app\n');
        
        res.json({
            success: true,
            pairingCode: code?.match(/.{1,4}/g)?.join('-') || code,
            phoneNumber: phoneNumber
        });
    } catch (error) {
        logger.error('Pairing error:', error);
        res.status(500).json({ error: 'Failed to request pairing code' });
    }
});

// Logout
app.post('/api/logout', async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }
        isConnected = false;
        connectionState = 'disconnected';
        console.log('👋 Logged out from WhatsApp\n');
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        logger.error('Logout error:', error);
        res.status(500).json({ error: 'Failed to logout' });
    }
});

// Send text message
app.post('/api/send/text', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { to, text, ai = false } = req.body;
        
        if (!to || !text) {
            return res.status(400).json({ error: 'Both "to" and "text" fields are required' });
        }
        
        const formattedId = formatWhatsAppId(to);
        const message = { text, ai };
        
        const result = await sock.sendMessage(formattedId, message);
        
        // Log message sending in terminal
        console.log(`📤 Message sent to ${to}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}" ${ai ? '🤖' : ''}`);
        
        res.json({
            success: true,
            messageId: result.key.id,
            to: formattedId,
            message: text,
            ai: ai,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Send text error:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Send media message
app.post('/api/send/media', upload.single('media'), async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { to, caption, type } = req.body;
        const file = req.file;
        
        if (!to || !file) {
            return res.status(400).json({ error: 'Both "to" and media file are required' });
        }
        
        const formattedId = formatWhatsAppId(to);
        const mediaPath = file.path;
        
        let message = {};
        
        switch (type) {
            case 'image':
                message = {
                    image: { url: mediaPath },
                    caption: caption || ''
                };
                break;
            case 'video':
                message = {
                    video: { url: mediaPath },
                    caption: caption || ''
                };
                break;
            case 'audio':
                message = {
                    audio: { url: mediaPath },
                    mimetype: 'audio/mp4'
                };
                break;
            case 'document':
                message = {
                    document: { url: mediaPath },
                    fileName: file.originalname,
                    caption: caption || ''
                };
                break;
            default:
                return res.status(400).json({ error: 'Invalid media type' });
        }
        
        const result = await sock.sendMessage(formattedId, message);
        
        // Clean up uploaded file
        fs.unlinkSync(mediaPath);
        
        // Log media sending in terminal
        console.log(`📤 ${type.toUpperCase()} sent to ${to}: ${file.originalname}`);
        
        res.json({
            success: true,
            messageId: result.key.id,
            to: formattedId,
            type: type,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Send media error:', error);
        if (req.file) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: 'Failed to send media' });
    }
});

// Send text button message
app.post('/api/send/buttons/text', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { to, text, footer, buttons, headerType = 1, viewOnce = true, quoted = null } = req.body;
        
        if (!to || !buttons) {
            return res.status(400).json({ error: 'Required fields: to, buttons' });
        }
        
        const formattedId = formatWhatsAppId(to);
        
        const buttonMessage = {
            text: text || "Hi it's button message",
            footer: footer || 'Hello World',
            buttons,
            headerType,
            viewOnce
        };
        
        const result = await sock.sendMessage(formattedId, buttonMessage, { quoted });
        
        console.log(`📝 Text button message sent to ${to} with ${buttons.length} buttons`);
        
        res.json({
            success: true,
            messageId: result.key.id,
            to: formattedId,
            type: 'text_buttons',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Send text buttons error:', error);
        res.status(500).json({ error: 'Failed to send text button message' });
    }
});

// Send image button message
app.post('/api/send/buttons/image', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { to, image, caption, footer, buttons, headerType = 1, viewOnce = true, quoted = null } = req.body;
        
        if (!to || !image || !buttons) {
            return res.status(400).json({ error: 'Required fields: to, image, buttons' });
        }
        
        const formattedId = formatWhatsAppId(to);
        
        const buttonMessage = {
            image: { url: image },
            caption: caption || "Hi it's button message with image",
            footer: footer || 'Hello World',
            buttons,
            headerType,
            viewOnce
        };
        
        const result = await sock.sendMessage(formattedId, buttonMessage, { quoted });
        
        console.log(`🖼️ Image button message sent to ${to} with ${buttons.length} buttons`);
        
        res.json({
            success: true,
            messageId: result.key.id,
            to: formattedId,
            type: 'image_buttons',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Send image buttons error:', error);
        res.status(500).json({ error: 'Failed to send image button message' });
    }
});

// Send video button message
app.post('/api/send/buttons/video', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { to, video, caption, footer, buttons, headerType = 1, viewOnce = true, quoted = null } = req.body;
        
        if (!to || !video || !buttons) {
            return res.status(400).json({ error: 'Required fields: to, video, buttons' });
        }
        
        const formattedId = formatWhatsAppId(to);
        
        const buttonMessage = {
            video: { url: video },
            caption: caption || "Hi it's button message with video",
            footer: footer || 'Hello World',
            buttons,
            headerType,
            viewOnce
        };
        
        const result = await sock.sendMessage(formattedId, buttonMessage, { quoted });
        
        console.log(`🎬 Video button message sent to ${to} with ${buttons.length} buttons`);
        
        res.json({
            success: true,
            messageId: result.key.id,
            to: formattedId,
            type: 'video_buttons',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Send video buttons error:', error);
        res.status(500).json({ error: 'Failed to send video button message' });
    }
});

// Send advanced interactive message
app.post('/api/send/interactive/advanced', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { to, text, title, footer, interactiveButtons, quoted = null } = req.body;
        
        if (!to || !interactiveButtons) {
            return res.status(400).json({ error: 'Required fields: to, interactiveButtons' });
        }
        
        const formattedId = formatWhatsAppId(to);
        
        const interactiveMessage = {
            text: text || "Hello World!",
            title: title || "this is the title",
            footer: footer || "this is the footer",
            interactiveButtons
        };
        
        const result = await sock.sendMessage(formattedId, interactiveMessage, { quoted });
        
        console.log(`🔄 Advanced interactive message sent to ${to} with ${interactiveButtons.length} buttons`);
        
        res.json({
            success: true,
            messageId: result.key.id,
            to: formattedId,
            type: 'advanced_interactive',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Send advanced interactive error:', error);
        res.status(500).json({ error: 'Failed to send advanced interactive message: ' + error.message });
    }
});

// Send rich media interactive message with image
app.post('/api/send/interactive/image', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { to, image, caption, title, footer, interactiveButtons, quoted = null } = req.body;
        
        if (!to || !image || !interactiveButtons) {
            return res.status(400).json({ error: 'Required fields: to, image, interactiveButtons' });
        }
        
        const formattedId = formatWhatsAppId(to);
        
        const imageInteractiveMessage = {
            image: { url: image },
            caption: caption || "Check out this amazing photo!",
            title: title || 'Photo Showcase',
            footer: footer || 'Tap a button below',
            interactiveButtons
        };
        
        const result = await sock.sendMessage(formattedId, imageInteractiveMessage, { quoted });
        
        console.log(`🖼️ Rich media interactive image message sent to ${to} with ${interactiveButtons.length} buttons`);
        
        res.json({
            success: true,
            messageId: result.key.id,
            to: formattedId,
            type: 'rich_media_image_interactive',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Send rich media image interactive error:', error);
        res.status(500).json({ error: 'Failed to send rich media image interactive message' });
    }
});

// Send rich media interactive message with video
app.post('/api/send/interactive/video', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { to, video, caption, title, footer, interactiveButtons, quoted = null } = req.body;
        
        if (!to || !video || !interactiveButtons) {
            return res.status(400).json({ error: 'Required fields: to, video, interactiveButtons' });
        }
        
        const formattedId = formatWhatsAppId(to);
        
        const videoInteractiveMessage = {
            video: { url: video },
            caption: caption || "Watch this awesome video!",
            title: title || "Video Showcase",
            footer: footer || "Tap a button below",
            interactiveButtons
        };
        
        const result = await sock.sendMessage(formattedId, videoInteractiveMessage, { quoted });
        
        console.log(`🎬 Rich media interactive video message sent to ${to} with ${interactiveButtons.length} buttons`);
        
        res.json({
            success: true,
            messageId: result.key.id,
            to: formattedId,
            type: 'rich_media_video_interactive',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Send rich media video interactive error:', error);
        res.status(500).json({ error: 'Failed to send rich media video interactive message' });
    }
});

// 🚀 COMPLEX ENDPOINTS

// Bulk message sending
app.post('/api/send/bulk', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { recipients, message, delay = 1000, messageType = 'text' } = req.body;
        
        if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
            return res.status(400).json({ error: 'Recipients array is required' });
        }
        
        if (!message) {
            return res.status(400).json({ error: 'Message content is required' });
        }
        
        const results = [];
        const errors = [];
        
        for (let i = 0; i < recipients.length; i++) {
            try {
                const recipient = recipients[i];
                const formattedId = formatWhatsAppId(recipient);
                
                let messageObj;
                switch (messageType) {
                    case 'text':
                        messageObj = { text: message.text || message, ai: message.ai || false };
                        break;
                    case 'image':
                        messageObj = { 
                            image: { url: message.image },
                            caption: message.caption || ''
                        };
                        break;
                    case 'video':
                        messageObj = { 
                            video: { url: message.video },
                            caption: message.caption || ''
                        };
                        break;
                    default:
                        messageObj = { text: message.text || message };
                }
                
                const result = await sock.sendMessage(formattedId, messageObj);
                results.push({
                    to: formattedId,
                    messageId: result.key.id,
                    status: 'sent'
                });
                
                // Delay between messages to avoid rate limiting
                if (i < recipients.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
                
            } catch (error) {
                errors.push({
                    to: recipients[i],
                    error: error.message
                });
            }
        }
        
        console.log(`📤 Bulk message sent to ${results.length} recipients, ${errors.length} failed`);
        
        res.json({
            success: true,
            sent: results.length,
            failed: errors.length,
            results: results,
            errors: errors,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Bulk send error:', error);
        res.status(500).json({ error: 'Failed to send bulk messages' });
    }
});

// Send contact card
app.post('/api/send/contact', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { to, contact, quoted = null } = req.body;
        
        if (!to || !contact) {
            return res.status(400).json({ error: 'Required fields: to, contact' });
        }
        
        const formattedId = formatWhatsAppId(to);
        
        // Format contact card
        const vcard = `BEGIN:VCARD
VERSION:3.0
FN:${contact.fullName || contact.name}
N:${contact.lastName || ''};${contact.firstName || contact.name};;;
ORG:${contact.organization || ''}
TEL;type=CELL;type=VOICE;waid=${contact.phone}:${contact.phone}
END:VCARD`;
        
        const contactMessage = {
            contacts: {
                displayName: contact.fullName || contact.name,
                contacts: [{ vcard }]
            }
        };
        
        const result = await sock.sendMessage(formattedId, contactMessage, { quoted });
        
        console.log(`👤 Contact card sent to ${to}: ${contact.name}`);
        
        res.json({
            success: true,
            messageId: result.key.id,
            to: formattedId,
            contact: contact.name,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Send contact error:', error);
        res.status(500).json({ error: 'Failed to send contact' });
    }
});

// Send location
app.post('/api/send/location', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { to, latitude, longitude, name, address, quoted = null } = req.body;
        
        if (!to || !latitude || !longitude) {
            return res.status(400).json({ error: 'Required fields: to, latitude, longitude' });
        }
        
        const formattedId = formatWhatsAppId(to);
        
        const locationMessage = {
            location: {
                degreesLatitude: parseFloat(latitude),
                degreesLongitude: parseFloat(longitude),
                name: name || '',
                address: address || ''
            }
        };
        
        const result = await sock.sendMessage(formattedId, locationMessage, { quoted });
        
        console.log(`📍 Location sent to ${to}: ${latitude}, ${longitude}`);
        
        res.json({
            success: true,
            messageId: result.key.id,
            to: formattedId,
            location: { latitude, longitude, name, address },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Send location error:', error);
        res.status(500).json({ error: 'Failed to send location' });
    }
});

// Send message with reaction
app.post('/api/send/reaction', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { to, messageId, reaction } = req.body;
        
        if (!to || !messageId || !reaction) {
            return res.status(400).json({ error: 'Required fields: to, messageId, reaction' });
        }
        
        const formattedId = formatWhatsAppId(to);
        
        const reactionMessage = {
            react: {
                text: reaction,
                key: {
                    remoteJid: formattedId,
                    id: messageId
                }
            }
        };
        
        const result = await sock.sendMessage(formattedId, reactionMessage);
        
        console.log(`👍 Reaction sent to ${to}: ${reaction}`);
        
        res.json({
            success: true,
            messageId: result.key.id,
            to: formattedId,
            reaction: reaction,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Send reaction error:', error);
        res.status(500).json({ error: 'Failed to send reaction' });
    }
});

// Send business card template
app.post('/api/send/business-card', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { to, business, quoted = null } = req.body;
        
        if (!to || !business) {
            return res.status(400).json({ error: 'Required fields: to, business' });
        }
        
        const formattedId = formatWhatsAppId(to);
        
        // Create a rich business card with interactive buttons
        const businessCard = {
            text: `🏢 *${business.name}*\n\n📧 ${business.email}\n📞 ${business.phone}\n🌐 ${business.website}\n📍 ${business.address}\n\n${business.description || 'Welcome to our business!'}`,
            title: business.name,
            footer: 'Contact us for more information',
            interactiveButtons: [
                {
                    name: "cta_call",
                    buttonParamsJson: JSON.stringify({
                        display_text: "📞 Call Us",
                        phone_number: business.phone
                    })
                },
                {
                    name: "cta_url",
                    buttonParamsJson: JSON.stringify({
                        display_text: "🌐 Visit Website",
                        url: business.website
                    })
                },
                {
                    name: "quick_reply",
                    buttonParamsJson: JSON.stringify({
                        display_text: "📧 Get Info",
                        id: "business_info"
                    })
                }
            ]
        };
        
        const result = await sock.sendMessage(formattedId, businessCard, { quoted });
        
        console.log(`🏢 Business card sent to ${to}: ${business.name}`);
        
        res.json({
            success: true,
            messageId: result.key.id,
            to: formattedId,
            business: business.name,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Send business card error:', error);
        res.status(500).json({ error: 'Failed to send business card: ' + error.message });
    }
});

// Send product catalog (Enhanced with proper structure and debugging)
app.post('/api/send/catalog', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        console.log('📥 Catalog request body:', JSON.stringify(req.body, null, 2));
        
        const { to, products, title = "Our Products", footer = "Choose a product to learn more", businessOwnerJid = null, quoted = null } = req.body;
        
        if (!to || !products || !Array.isArray(products)) {
            return res.status(400).json({ error: 'Required fields: to, products (array)' });
        }
        
        // Ensure proper JID format
        const formattedId = formatWhatsAppId(to);
        console.log('📱 Sending to JID:', formattedId);
        
        // Verify number exists on WhatsApp first
        try {
            const numberCheck = await sock.onWhatsApp(formattedId);
            console.log('🔍 Number check result:', numberCheck);
            
            if (!numberCheck[0]?.exists) {
                return res.status(400).json({ 
                    error: 'Number does not exist on WhatsApp',
                    number: formattedId,
                    checked: numberCheck
                });
            }
        } catch (checkError) {
            console.warn('⚠️ Could not verify number existence:', checkError.message);
        }
        
        // If single product with rich media support
        if (products.length === 1) {
            const product = products[0];
            console.log('📦 Processing single product:', product);
            
            try {
                // Build the exact message structure baileys-elite expects
                const catalogMessage = {
                    product: {
                        productImage: product.image ? { url: product.image } : undefined,
                        productImageCount: product.image ? 1 : 0,
                        title: product.name || 'Product',
                        description: product.description || 'Featured product',
                        currencyCode: product.currency || 'USD',
                        priceAmount1000: Math.round(parseFloat(product.price || 0) * 1000), // Ensure it's a number
                        retailerId: product.id || `product_${Date.now()}`,
                        url: product.url || undefined
                    },
                    businessOwnerJid: businessOwnerJid || sock.user?.id?.replace(':37', '') || formattedId,
                    caption: title,
                    footer: footer,
                    media: true
                };
                
                console.log('📤 Sending catalog message:', JSON.stringify(catalogMessage, null, 2));
                
                const result = await sock.sendMessage(formattedId, catalogMessage, { quoted });
                
                console.log('✅ WhatsApp send result:', JSON.stringify(result, null, 2));
                console.log(`🛍️ Rich media product catalog sent to ${to}: ${product.name}`);
                
                res.json({
                    success: true,
                    messageId: result.key.id,
                    to: formattedId,
                    type: 'rich_product_catalog',
                    product: product.name,
                    whatsappResult: result,
                    timestamp: new Date().toISOString()
                });
            } catch (imageError) {
                console.warn(`⚠️ Rich media catalog failed for ${product.name}, falling back to text catalog:`, imageError.message);
                
                // Fallback to simple text message
                const fallbackMessage = {
                    text: `🛍️ *${title}*\n\n📦 *${product.name}*\n💰 ${product.currency || '$'}${product.price}\n📝 ${product.description || 'Featured product'}\n${product.url ? `🌐 ${product.url}` : ''}\n\n${footer}`
                };
                
                console.log('📤 Sending fallback message:', JSON.stringify(fallbackMessage, null, 2));
                
                const result = await sock.sendMessage(formattedId, fallbackMessage, { quoted });
                
                console.log('✅ Fallback send result:', JSON.stringify(result, null, 2));
                console.log(`🛍️ Text-only product catalog sent to ${to}: ${product.name} (image failed)`);
                
                res.json({
                    success: true,
                    messageId: result.key.id,
                    to: formattedId,
                    type: 'text_product_catalog',
                    product: product.name,
                    fallbackReason: imageError.message,
                    whatsappResult: result,
                    timestamp: new Date().toISOString()
                });
            }
        } else {
            // Multiple products - use simple text format
            console.log(`📦 Processing ${products.length} products`);
            
            const textMessage = {
                text: `🛍️ *${title}*\n\n${products.slice(0, 5).map((product, index) => 
                    `${index + 1}. 📦 *${product.name}*\n💰 ${product.currency || '$'}${product.price}\n📝 ${product.description || ''}\n${product.url ? `🌐 ${product.url}` : ''}\n`
                ).join('\n')}${products.length > 5 ? `\n... and ${products.length - 5} more products` : ''}\n\n${footer}`
            };
            
            console.log('📤 Sending multi-product message:', JSON.stringify(textMessage, null, 2));
            
            const result = await sock.sendMessage(formattedId, textMessage, { quoted });
            
            console.log('✅ Multi-product send result:', JSON.stringify(result, null, 2));
            console.log(`🛍️ Multi-product catalog sent to ${to} with ${products.length} products`);
            
            res.json({
                success: true,
                messageId: result.key.id,
                to: formattedId,
                type: 'multi_product_catalog',
                productsCount: products.length,
                whatsappResult: result,
                timestamp: new Date().toISOString()
            });
        }
    } catch (error) {
        console.error('❌ Catalog send error:', error);
        logger.error('Send catalog error:', error);
        res.status(500).json({ 
            error: 'Failed to send catalog: ' + error.message,
            stack: error.stack
        });
    }
});

// Send media album (Multiple images/videos in grouped message)
app.post('/api/send/album', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { to, media, delay = 1500, quoted = null } = req.body;
        
        if (!to || !media || !Array.isArray(media) || media.length === 0) {
            return res.status(400).json({ error: 'Required fields: to, media (array of media objects)' });
        }
        
        if (media.length > 10) {
            return res.status(400).json({ error: 'Maximum 10 media items allowed per album' });
        }
        
        const formattedId = formatWhatsAppId(to);
        
        // Send each media item individually with a small delay to group them
        const results = [];
        
        for (let i = 0; i < media.length; i++) {
            const item = media[i];
            let mediaMessage = {};
            
            if (item.type === 'image' || item.image) {
                mediaMessage = {
                    image: { url: item.image || item.url },
                    caption: item.caption || ''
                };
            } else if (item.type === 'video' || item.video) {
                mediaMessage = {
                    video: { url: item.video || item.url },
                    caption: item.caption || ''
                };
            } else {
                return res.status(400).json({ error: `Invalid media type for item ${i + 1}. Use 'image' or 'video'` });
            }
            
            try {
                const result = await sock.sendMessage(formattedId, mediaMessage, { quoted });
                results.push({
                    index: i + 1,
                    messageId: result.key.id,
                    type: item.type || (item.image ? 'image' : 'video'),
                    status: 'sent'
                });
                
                // Add delay between messages except for the last one
                if (i < media.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            } catch (error) {
                results.push({
                    index: i + 1,
                    error: error.message,
                    status: 'failed'
                });
            }
        }
        
        const successCount = results.filter(r => r.status === 'sent').length;
        const failedCount = results.filter(r => r.status === 'failed').length;
        
        console.log(`🎥 Media album sent to ${to}: ${successCount}/${media.length} items successful`);
        
        res.json({
            success: successCount > 0,
            totalItems: media.length,
            successCount: successCount,
            failedCount: failedCount,
            to: formattedId,
            type: 'media_album',
            results: results,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Send album error:', error);
        res.status(500).json({ error: 'Failed to send media album: ' + error.message });
    }
});

// Send survey/poll
app.post('/api/send/survey', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { to, survey, quoted = null } = req.body;
        
        if (!to || !survey || !survey.question || !survey.options) {
            return res.status(400).json({ error: 'Required fields: to, survey.question, survey.options' });
        }
        
        const formattedId = formatWhatsAppId(to);
        
        // Create interactive buttons for survey options
        const surveyButtons = survey.options.slice(0, 3).map((option, index) => ({
            name: "quick_reply",
            buttonParamsJson: JSON.stringify({
                display_text: option,
                id: `survey_${index}`
            })
        }));
        
        const surveyMessage = {
            text: `📊 *${survey.title || 'Survey'}*\n\n❓ ${survey.question}\n\nPlease select your answer:`,
            title: survey.title || 'Survey',
            footer: survey.footer || 'Thank you for participating!',
            interactiveButtons: surveyButtons
        };
        
        const result = await sock.sendMessage(formattedId, surveyMessage, { quoted });
        
        console.log(`📊 Survey sent to ${to}: ${survey.question}`);
        
        res.json({
            success: true,
            messageId: result.key.id,
            to: formattedId,
            survey: survey.question,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Send survey error:', error);
        res.status(500).json({ error: 'Failed to send survey' });
    }
});

// 📱 NEW ENDPOINTS - WhatsApp Features

// Send sticker
app.post('/api/send/sticker', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { to, sticker, quoted = null } = req.body;
        
        if (!to || !sticker) {
            return res.status(400).json({ error: 'Required fields: to, sticker' });
        }
        
        const formattedId = formatWhatsAppId(to);
        
        const stickerMessage = {
            sticker: { url: sticker }
        };
        
        const result = await sock.sendMessage(formattedId, stickerMessage, { quoted });
        
        console.log(`🎯 Sticker sent to ${to}`);
        
        res.json({
            success: true,
            messageId: result.key.id,
            to: formattedId,
            type: 'sticker',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Send sticker error:', error);
        res.status(500).json({ error: 'Failed to send sticker' });
    }
});

// Send voice note (PTT)
app.post('/api/send/voice', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { to, audio, quoted = null } = req.body;
        
        if (!to || !audio) {
            return res.status(400).json({ error: 'Required fields: to, audio' });
        }
        
        const formattedId = formatWhatsAppId(to);
        
        const voiceMessage = {
            audio: { url: audio },
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true // This makes it a voice note
        };
        
        const result = await sock.sendMessage(formattedId, voiceMessage, { quoted });
        
        console.log(`🎤 Voice note sent to ${to}`);
        
        res.json({
            success: true,
            messageId: result.key.id,
            to: formattedId,
            type: 'voice_note',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Send voice error:', error);
        res.status(500).json({ error: 'Failed to send voice note' });
    }
});

// Send PDF invoice or document attachment
app.post('/api/send/document', upload.single('document'), async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { to, documentUrl, fileName, caption, mimetype, quoted = null } = req.body;
        const file = req.file;
        
        if (!to) {
            return res.status(400).json({ error: 'Required field: to' });
        }
        
        if (!file && !documentUrl) {
            return res.status(400).json({ error: 'Either upload a file or provide documentUrl' });
        }
        
        const formattedId = formatWhatsAppId(to);
        
        let documentMessage = {};
        let actualFileName = '';
        let actualMimetype = '';
        
        if (file) {
            // Handle uploaded file
            const documentPath = file.path;
            actualFileName = fileName || file.originalname || 'document.pdf';
            actualMimetype = mimetype || file.mimetype || 'application/pdf';
            
            documentMessage = {
                document: { url: documentPath },
                mimetype: actualMimetype,
                fileName: actualFileName,
                caption: caption || `📄 ${actualFileName}`
            };
        } else if (documentUrl) {
            // Handle URL-based document
            actualFileName = fileName || 'document.pdf';
            actualMimetype = mimetype || 'application/pdf';
            
            documentMessage = {
                document: { url: documentUrl },
                mimetype: actualMimetype,
                fileName: actualFileName,
                caption: caption || `📄 ${actualFileName}`
            };
        }
        
        const result = await sock.sendMessage(formattedId, documentMessage, { quoted });
        
        // Clean up uploaded file if it exists
        if (file) {
            fs.unlinkSync(file.path);
        }
        
        console.log(`📄 Document sent to ${to}: ${actualFileName} (${actualMimetype})`);
        
        res.json({
            success: true,
            messageId: result.key.id,
            to: formattedId,
            type: 'document',
            fileName: actualFileName,
            mimetype: actualMimetype,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Send document error:', error);
        if (req.file) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: 'Failed to send document: ' + error.message });
    }
});

// Send PDF invoice (specialized endpoint for invoices)
app.post('/api/send/invoice', upload.single('invoice'), async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { to, invoiceUrl, invoiceNumber, customerName, amount, currency = 'USD', quoted = null } = req.body;
        const file = req.file;
        
        if (!to) {
            return res.status(400).json({ error: 'Required field: to' });
        }
        
        if (!file && !invoiceUrl) {
            return res.status(400).json({ error: 'Either upload an invoice file or provide invoiceUrl' });
        }
        
        const formattedId = formatWhatsAppId(to);
        
        // Generate invoice filename and caption
        const invoiceFileName = `Invoice_${invoiceNumber || Date.now()}.pdf`;
        const invoiceCaption = `🧾 **INVOICE**\n\n` +
            `📋 Invoice: #${invoiceNumber || 'N/A'}\n` +
            `👤 Customer: ${customerName || 'N/A'}\n` +
            `💰 Amount: ${currency} ${amount || 'N/A'}\n\n` +
            `📄 Please find your invoice attached below.`;
        
        let documentMessage = {};
        
        if (file) {
            // Handle uploaded invoice file
            const invoicePath = file.path;
            
            documentMessage = {
                document: { url: invoicePath },
                mimetype: 'application/pdf',
                fileName: invoiceFileName,
                caption: invoiceCaption
            };
        } else if (invoiceUrl) {
            // Handle URL-based invoice
            documentMessage = {
                document: { url: invoiceUrl },
                mimetype: 'application/pdf',
                fileName: invoiceFileName,
                caption: invoiceCaption
            };
        }
        
        const result = await sock.sendMessage(formattedId, documentMessage, { quoted });
        
        // Clean up uploaded file if it exists
        if (file) {
            fs.unlinkSync(file.path);
        }
        
        console.log(`🧾 Invoice sent to ${to}: ${invoiceFileName} (${currency} ${amount})`);
        
        res.json({
            success: true,
            messageId: result.key.id,
            to: formattedId,
            type: 'invoice',
            invoiceNumber: invoiceNumber,
            fileName: invoiceFileName,
            amount: amount,
            currency: currency,
            customerName: customerName,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Send invoice error:', error);
        if (req.file) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: 'Failed to send invoice: ' + error.message });
    }
});

// Get current user info (for businessOwnerJid)
app.get('/api/user/info', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const userInfo = {
            jid: sock.user?.id,
            businessJid: sock.user?.id?.replace(':37', ''),
            name: sock.user?.name,
            pushName: sock.user?.pushName,
            connectionState: connectionState,
            isConnected: isConnected
        };
        
        console.log('👤 User info requested:', userInfo);
        
        res.json({
            success: true,
            user: userInfo,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Get user info error:', error);
        res.status(500).json({ error: 'Failed to get user info: ' + error.message });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    logger.error('Unhandled error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Initialize and start server
async function startServer() {
    try {
        console.log('🚀 Starting Baileys Elite WhatsApp API Server...\n');
        
        await initializeWhatsApp();
        
        app.listen(PORT, () => {
            logger.info(`Baileys Elite API server running on port ${PORT}`);
            console.log('═'.repeat(60));
            console.log('🚀 Server running on http://localhost:' + PORT);
            console.log('📱 WhatsApp API ready for Postman testing!');
            console.log('═'.repeat(60));
            console.log('📋 Available endpoints:');
            console.log('');
            console.log('🔗 CONNECTION MANAGEMENT:');
            console.log('   • Health Check: GET /api/health');
            console.log('   • Connection Status: GET /api/status');
            console.log('   • Get QR Code: GET /api/qr');
            console.log('   • Request Pairing Code: POST /api/pair');
            console.log('   • Logout: POST /api/logout');
            console.log('');
            console.log('💬 MESSAGING:');
            console.log('   • Send Text Message: POST /api/send/text');
            console.log('   • Send Media: POST /api/send/media');
            console.log('   • Send Sticker: POST /api/send/sticker');
            console.log('   • Send Voice Note: POST /api/send/voice');
            console.log('   • Send Bulk Messages: POST /api/send/bulk');
            console.log('   • Send Document: POST /api/send/document');
            console.log('   • Send Invoice: POST /api/send/invoice');
            console.log('');
            console.log('🎛️ INTERACTIVE MESSAGES:');
            console.log('   • Send Text Buttons: POST /api/send/buttons/text');
            console.log('   • Send Image Buttons: POST /api/send/buttons/image');
            console.log('   • Send Video Buttons: POST /api/send/buttons/video');
            console.log('   • Send Advanced Interactive: POST /api/send/interactive/advanced');
            console.log('   • Send Rich Media Interactive Image: POST /api/send/interactive/image');
            console.log('   • Send Rich Media Interactive Video: POST /api/send/interactive/video');
            console.log('');
            console.log('📋 SPECIAL CONTENT:');
            console.log('   • Send Contact Card: POST /api/send/contact');
            console.log('   • Send Location: POST /api/send/location');
            console.log('   • Send Reaction: POST /api/send/reaction');
            console.log('   • Send Business Card: POST /api/send/business-card');
            console.log('   • Send Product Catalog: POST /api/send/catalog');
            console.log('   • Send Survey: POST /api/send/survey');
            console.log('   • Send Media Album: POST /api/send/album');
            console.log('');
            console.log('═'.repeat(60));
            console.log(`📊 Total Endpoints: ${24} available for testing`);
            console.log('📖 Import Postman collection: Baileys-Elite-API.postman_collection.json');
            console.log('═'.repeat(60));
            
            if (!isConnected && qr) {
                console.log('⏳ Waiting for WhatsApp connection...');
                console.log('📱 Please scan the QR code above or use pairing code\n');
            }
        });
    } catch (error) {
        logger.error('Failed to start server:', error);
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n👋 Shutting down gracefully...');
    logger.info('Shutting down gracefully...');
    if (sock) {
        await sock.end();
    }
    process.exit(0);
});

startServer(); 