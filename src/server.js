require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve data files (clips, screenshots, thumbnails)
app.use('/data', express.static(path.join(__dirname, '..', 'data'), {
    setHeaders: (res, filePath) => {
        // Set appropriate content types
        if (filePath.endsWith('.mp4')) res.setHeader('Content-Type', 'video/mp4');
        if (filePath.endsWith('.png')) res.setHeader('Content-Type', 'image/png');
        if (filePath.endsWith('.jpg')) res.setHeader('Content-Type', 'image/jpeg');
    },
}));

// API Routes
const videoRoutes = require('./routes/videos');
app.use('/api/videos', videoRoutes);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Settings / Provider status
app.get('/api/settings', async (req, res) => {
    const localVision = require('./services/local-vision');
    const localAvailable = await localVision.isAvailable();
    const visionProvider = process.env.VISION_PROVIDER || (localAvailable ? 'local' : 'gemini');
    res.json({
        visionProvider,
        localModelAvailable: localAvailable,
        llamaServerUrl: process.env.LLAMA_SERVER_URL || 'http://localhost:8080',
        geminiConfigured: !!process.env.GEMINI_API_KEY,
    });
});

// Start server if not required as a module
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`\n  ✦ SOPGen running at http://localhost:${PORT}\n`);
    });
}

module.exports = app;
