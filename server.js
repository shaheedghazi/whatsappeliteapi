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
            title: title || 'this is the title',
            footer: footer || 'this is the footer',
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
        res.status(500).json({ error: 'Failed to send advanced interactive message' });
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
        
        const interactiveMessage = {
            image: { url: image },
            caption: caption || "Check out this amazing photo!",
            title: title || 'Photo Showcase',
            footer: footer || 'Tap a button below',
            interactiveButtons
        };
        
        const result = await sock.sendMessage(formattedId, interactiveMessage, { quoted });
        
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
        
        const interactiveMessage = {
            video: { url: video },
            caption: caption || "Watch this awesome video!",
            title: title || 'Video Showcase',
            footer: footer || 'Tap a button below',
            interactiveButtons
        };
        
        const result = await sock.sendMessage(formattedId, interactiveMessage, { quoted });
        
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
        res.status(500).json({ error: 'Failed to send business card' });
    }
});

// Send product catalog
app.post('/api/send/catalog', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { to, products, title = "Our Products", footer = "Choose a product to learn more", quoted = null } = req.body;
        
        if (!to || !products || !Array.isArray(products)) {
            return res.status(400).json({ error: 'Required fields: to, products (array)' });
        }
        
        const formattedId = formatWhatsAppId(to);
        
        // Create interactive buttons for each product
        const productButtons = products.slice(0, 3).map((product, index) => ({
            name: "quick_reply",
            buttonParamsJson: JSON.stringify({
                display_text: `${product.name} - $${product.price}`,
                id: `product_${index}`
            })
        }));
        
        // Add a "View All" button if there are more than 3 products
        if (products.length > 3) {
            productButtons.push({
                name: "quick_reply",
                buttonParamsJson: JSON.stringify({
                    display_text: `View All ${products.length} Products`,
                    id: "view_all_products"
                })
            });
        }
        
        const catalogMessage = {
            text: `🛍️ *${title}*\n\n${products.slice(0, 3).map(product => 
                `📦 *${product.name}*\n💰 $${product.price}\n📝 ${product.description}\n`
            ).join('\n')}`,
            title: title,
            footer: footer,
            interactiveButtons: productButtons
        };
        
        const result = await sock.sendMessage(formattedId, catalogMessage, { quoted });
        
        console.log(`🛍️ Product catalog sent to ${to} with ${products.length} products`);
        
        res.json({
            success: true,
            messageId: result.key.id,
            to: formattedId,
            productsCount: products.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Send catalog error:', error);
        res.status(500).json({ error: 'Failed to send catalog' });
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
            console.log('   • Health Check: GET /api/health');
            console.log('   • Connection Status: GET /api/status');
            console.log('   • Get QR Code: GET /api/qr');
            console.log('   • Request Pairing Code: POST /api/pair');
            console.log('   • Send Text Message: POST /api/send/text');
            console.log('   • Send Media: POST /api/send/media');
            console.log('   • Send Text Buttons: POST /api/send/buttons/text');
            console.log('   • Send Image Buttons: POST /api/send/buttons/image');
            console.log('   • Send Video Buttons: POST /api/send/buttons/video');
            console.log('   • Send Advanced Interactive: POST /api/send/interactive/advanced');
            console.log('   • Send Rich Media Interactive Image: POST /api/send/interactive/image');
            console.log('   • Send Rich Media Interactive Video: POST /api/send/interactive/video');
            console.log('   • Send Bulk Messages: POST /api/send/bulk');
            console.log('   • Send Contact Card: POST /api/send/contact');
            console.log('   • Send Location: POST /api/send/location');
            console.log('   • Send Reaction: POST /api/send/reaction');
            console.log('   • Send Business Card: POST /api/send/business-card');
            console.log('   • Send Product Catalog: POST /api/send/catalog');
            console.log('   • Send Survey: POST /api/send/survey');
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