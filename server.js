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

// Send button message
app.post('/api/send/buttons', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { to, text, footer, buttons, headerType = 1, viewOnce = true, image, video } = req.body;
        
        if (!to || !text || !buttons) {
            return res.status(400).json({ error: 'Required fields: to, text, buttons' });
        }
        
        const formattedId = formatWhatsAppId(to);
        
        let message = {
            text,
            footer: footer || '',
            buttons,
            headerType,
            viewOnce
        };
        
        if (image) {
            message.image = { url: image };
            message.caption = text;
            delete message.text;
        }
        
        if (video) {
            message.video = { url: video };
            message.caption = text;
            delete message.text;
        }
        
        const result = await sock.sendMessage(formattedId, message);
        
        // Log button message sending in terminal
        console.log(`📤 Button message sent to ${to} with ${buttons.length} buttons`);
        
        res.json({
            success: true,
            messageId: result.key.id,
            to: formattedId,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Send buttons error:', error);
        res.status(500).json({ error: 'Failed to send button message' });
    }
});

// Send interactive message
app.post('/api/send/interactive', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { to, text, title, footer, interactiveButtons, image, video, caption } = req.body;
        
        if (!to || !text || !interactiveButtons) {
            return res.status(400).json({ error: 'Required fields: to, text, interactiveButtons' });
        }
        
        const formattedId = formatWhatsAppId(to);
        
        let message = {
            text,
            title: title || '',
            footer: footer || '',
            interactiveButtons
        };
        
        if (image) {
            message.image = { url: image };
            message.caption = caption || text;
            delete message.text;
        }
        
        if (video) {
            message.video = { url: video };
            message.caption = caption || text;
            delete message.text;
        }
        
        const result = await sock.sendMessage(formattedId, message);
        
        // Log interactive message sending in terminal
        console.log(`📤 Interactive message sent to ${to} with ${interactiveButtons.length} buttons`);
        
        res.json({
            success: true,
            messageId: result.key.id,
            to: formattedId,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Send interactive error:', error);
        res.status(500).json({ error: 'Failed to send interactive message' });
    }
});

// Newsletter Management Routes

// Get newsletter metadata
app.get('/api/newsletter/:type/:identifier', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { type, identifier } = req.params;
        
        if (!['invite', 'jid'].includes(type)) {
            return res.status(400).json({ error: 'Type must be either "invite" or "jid"' });
        }
        
        const metadata = await sock.newsletterMetadata(type, identifier);
        
        res.json({
            success: true,
            metadata,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Newsletter metadata error:', error);
        res.status(500).json({ error: 'Failed to get newsletter metadata' });
    }
});

// Create newsletter
app.post('/api/newsletter/create', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { name, description } = req.body;
        
        if (!name || !description) {
            return res.status(400).json({ error: 'Both name and description are required' });
        }
        
        const metadata = await sock.newsletterCreate(name, description);
        
        console.log(`📰 Newsletter created: "${name}"`);
        
        res.json({
            success: true,
            metadata,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Newsletter create error:', error);
        res.status(500).json({ error: 'Failed to create newsletter' });
    }
});

// Update newsletter description
app.put('/api/newsletter/:jid/description', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { jid } = req.params;
        const { description } = req.body;
        
        if (!description) {
            return res.status(400).json({ error: 'Description is required' });
        }
        
        await sock.newsletterUpdateDescription(jid, description);
        
        res.json({
            success: true,
            message: 'Newsletter description updated',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Newsletter update description error:', error);
        res.status(500).json({ error: 'Failed to update newsletter description' });
    }
});

// Update newsletter name
app.put('/api/newsletter/:jid/name', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { jid } = req.params;
        const { name } = req.body;
        
        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }
        
        await sock.newsletterUpdateName(jid, name);
        
        res.json({
            success: true,
            message: 'Newsletter name updated',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Newsletter update name error:', error);
        res.status(500).json({ error: 'Failed to update newsletter name' });
    }
});

// Follow newsletter
app.post('/api/newsletter/:jid/follow', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { jid } = req.params;
        
        await sock.newsletterFollow(jid);
        
        res.json({
            success: true,
            message: 'Newsletter followed',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Newsletter follow error:', error);
        res.status(500).json({ error: 'Failed to follow newsletter' });
    }
});

// Unfollow newsletter
app.post('/api/newsletter/:jid/unfollow', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { jid } = req.params;
        
        await sock.newsletterUnfollow(jid);
        
        res.json({
            success: true,
            message: 'Newsletter unfollowed',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Newsletter unfollow error:', error);
        res.status(500).json({ error: 'Failed to unfollow newsletter' });
    }
});

// Mute newsletter
app.post('/api/newsletter/:jid/mute', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { jid } = req.params;
        
        await sock.newsletterMute(jid);
        
        res.json({
            success: true,
            message: 'Newsletter muted',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Newsletter mute error:', error);
        res.status(500).json({ error: 'Failed to mute newsletter' });
    }
});

// Unmute newsletter
app.post('/api/newsletter/:jid/unmute', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { jid } = req.params;
        
        await sock.newsletterUnmute(jid);
        
        res.json({
            success: true,
            message: 'Newsletter unmuted',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Newsletter unmute error:', error);
        res.status(500).json({ error: 'Failed to unmute newsletter' });
    }
});

// React to newsletter message
app.post('/api/newsletter/:jid/react', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { jid } = req.params;
        const { messageId, reaction } = req.body;
        
        if (!messageId || !reaction) {
            return res.status(400).json({ error: 'Both messageId and reaction are required' });
        }
        
        await sock.newsletterReactMessage(jid, messageId, reaction);
        
        res.json({
            success: true,
            message: 'Reaction sent',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Newsletter react error:', error);
        res.status(500).json({ error: 'Failed to react to newsletter message' });
    }
});

// Delete newsletter
app.delete('/api/newsletter/:jid', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(400).json({ error: 'WhatsApp not connected' });
        }
        
        const { jid } = req.params;
        
        await sock.newsletterDelete(jid);
        
        res.json({
            success: true,
            message: 'Newsletter deleted',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Newsletter delete error:', error);
        res.status(500).json({ error: 'Failed to delete newsletter' });
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
            console.log('   • Send Buttons: POST /api/send/buttons');
            console.log('   • Send Interactive: POST /api/send/interactive');
            console.log('   • Newsletter Management: /api/newsletter/*');
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