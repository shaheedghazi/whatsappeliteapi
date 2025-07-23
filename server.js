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
const { useMultiFileAuthState, DisconnectReason, Browsers } = require('baileys-elite');

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

// Initialize WhatsApp connection
async function initializeWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false, // We'll handle QR display ourselves
            logger: baleysLogger,
            browser: Browsers.macOS('Desktop')
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr: newQr } = update;
            
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
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                logger.info('Connection closed due to', lastDisconnect?.error, ', reconnecting', shouldReconnect);
                
                if (shouldReconnect) {
                    console.log('🔄 Reconnecting to WhatsApp...\n');
                    initializeWhatsApp();
                }
                isConnected = false;
                connectionState = 'disconnected';
            } else if (connection === 'open') {
                logger.info('WhatsApp connected successfully');
                console.log('\n✅ WhatsApp connected successfully!');
                console.log('🎉 Ready to send messages via Postman!\n');
                isConnected = true;
                connectionState = 'connected';
                qr = null;
            }
            
            connectionState = connection || 'unknown';
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', (m) => {
            logger.info('New message received:', JSON.stringify(m, null, 2));
        });

    } catch (error) {
        logger.error('Failed to initialize WhatsApp:', error);
        throw error;
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