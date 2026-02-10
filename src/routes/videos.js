const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');
const { stmts, DATA_DIR } = require('../db');
const media = require('../services/media');
const { processVideo } = require('../services/pipeline');

const router = express.Router();

// Configure multer for video uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(DATA_DIR, 'uploads')),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${uuid()}${ext}`);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB max
    fileFilter: (req, file, cb) => {
        const allowed = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.flv', '.wmv'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error(`Unsupported video format: ${ext}`));
        }
    },
});

// ---- POST /api/videos/upload ----
router.post('/upload', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No video file provided' });
        }

        const id = uuid();
        const title = req.body.title || path.basename(req.file.originalname, path.extname(req.file.originalname));

        let duration = 0;
        try {
            duration = await media.getVideoDuration(req.file.path);
        } catch (e) { /* duration will be set during processing */ }

        stmts.insertVideo.run({
            id,
            title,
            sourceType: 'upload',
            sourceUrl: null,
            filePath: req.file.path,
            durationSeconds: duration,
        });

        res.json({ id, title, status: 'uploaded' });
    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---- POST /api/videos/youtube ----
router.post('/youtube', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) {
            return res.status(400).json({ error: 'YouTube URL is required' });
        }

        const id = uuid();
        const outputPath = path.join(DATA_DIR, 'uploads', `${id}.mp4`);

        // Dynamic import for ytdlp-nodejs (ESM module)
        let YtDlp;
        try {
            const ytdlpModule = await import('ytdlp-nodejs');
            YtDlp = ytdlpModule.default || ytdlpModule.YtDlp || ytdlpModule;
        } catch (importErr) {
            console.error('Failed to import ytdlp-nodejs:', importErr);
            return res.status(500).json({ error: 'YouTube download module not available. Make sure yt-dlp is installed.' });
        }

        const ytDlp = new YtDlp();

        // Get video info first
        let title = 'YouTube Video';
        try {
            const info = await ytDlp.getInfoAsync(url);
            title = info.title || title;
            console.log(`[YouTube] Found video: ${title}`);
        } catch (e) {
            console.warn('Could not fetch video info:', e.message);
        }

        // Create DB record immediately so UI can show it
        stmts.insertVideo.run({
            id,
            title,
            sourceType: 'youtube',
            sourceUrl: url,
            filePath: outputPath,
            durationSeconds: 0,
        });
        stmts.updateVideoStatus.run({ id, status: 'processing' });

        res.json({ id, title, status: 'processing' });

        // Download in background using CLI directly for better reliability
        const { spawn } = require('child_process');

        const ytdlp = spawn('yt-dlp', [
            '-o', outputPath,
            '--format', 'best[ext=mp4]/best',
            '--no-playlist',
            '--newline', // Ensure progress comes line by line
            url
        ]);

        let detectedSize = false;

        ytdlp.stdout.on('data', (data) => {
            const line = data.toString().trim();
            console.log(`[YouTube DL] ${line}`);

            // Parse progress: "[download]  10.0% of  100.00MiB at  10.00MiB/s ETA 00:09"
            const progressMatch = line.match(/\[download\]\s+(\d+\.\d+)%\s+of\s+~?(\d+\.\d+)(MiB|GiB|kiB)/i);
            if (progressMatch) {
                const percent = progressMatch[1];
                const sizeValue = progressMatch[2];
                const sizeUnit = progressMatch[3].toLowerCase();

                // Update size in DB once
                if (!detectedSize) {
                    let sizeMb = parseFloat(sizeValue);
                    if (sizeUnit === 'gib') sizeMb *= 1024;
                    if (sizeUnit === 'kib') sizeMb /= 1024;

                    try {
                        stmts.updateVideoSize.run({ id, sizeMb });
                        detectedSize = true;
                    } catch (e) { /* ignore */ }
                }

                // Log progress to pipeline_logs
                try {
                    stmts.addPipelineLog.run({ id, message: `Downloading: ${percent}% of ${sizeValue}${sizeUnit}` });
                } catch (e) { /* ignore */ }
            }
        });

        ytdlp.stderr.on('data', (data) => {
            console.warn(`[YouTube DL Error] ${data.toString().trim()}`);
            try {
                stmts.addPipelineLog.run({ id, message: `Download Warning: ${data.toString().trim()}` });
            } catch (e) { /* ignore */ }
        });

        ytdlp.on('close', async (code) => {
            if (code === 0) {
                try {
                    const duration = await media.getVideoDuration(outputPath);
                    stmts.updateVideoMeta.run({
                        id,
                        title,
                        durationSeconds: duration,
                        thumbnailPath: null,
                    });
                    stmts.updateVideoStatus.run({ id, status: 'uploaded' });
                    stmts.addPipelineLog.run({ id, message: 'Download complete. Starting processing...' });
                    console.log(`[YouTube] Download complete: ${title}`);

                    // Start processing
                    processVideo(id).catch(err => {
                        console.error('[Pipeline] Auto-process error:', err);
                    });
                } catch (err) {
                    console.error('[YouTube] Post-download error:', err);
                    stmts.updateVideoError.run({ id, errorMessage: 'Failed to extract video metadata' });
                }
            } else {
                console.error(`[YouTube] Download failed with code ${code}`);
                stmts.updateVideoError.run({ id, errorMessage: `yt-dlp exited with code ${code}` });
            }
        });
    } catch (err) {
        console.error('YouTube endpoint error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---- POST /api/videos/:id/process ----
router.post('/:id/process', async (req, res) => {
    try {
        const video = stmts.getVideo.get(req.params.id);
        if (!video) return res.status(404).json({ error: 'Video not found' });
        if (video.status !== 'uploaded' && video.status !== 'error') {
            return res.status(400).json({ error: `Video is currently ${video.status}, cannot start processing` });
        }

        res.json({ status: 'processing', message: 'Processing started' });

        // Run pipeline in background
        processVideo(req.params.id).catch(err => {
            console.error('Pipeline error:', err);
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---- POST /api/videos/:id/stop ----
router.post('/:id/stop', async (req, res) => {
    try {
        const video = stmts.getVideo.get(req.params.id);
        if (!video) return res.status(404).json({ error: 'Video not found' });

        if (!['uploaded', 'complete', 'error'].includes(video.status)) {
            stmts.updateVideoStatus.run({ id: req.params.id, status: 'error' });
            stmts.updateVideoError.run({ id: req.params.id, errorMessage: 'Processing stopped by user' });
            stmts.addPipelineLog.run({ id: req.params.id, message: '🛑 Processing manually stopped by user.' });
        }

        res.json({ success: true, message: 'Stop signal sent' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---- GET /api/videos ----
router.get('/', (req, res) => {
    const videos = stmts.listVideos.all();
    res.json(videos);
});

// ---- GET /api/videos/:id ----
router.get('/:id', (req, res) => {
    const video = stmts.getVideo.get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });

    const clips = stmts.getClipsByVideo.all(video.id);
    const clipsWithSops = clips.map(clip => {
        const sopSteps = stmts.getSopStepsByClip.all(clip.id);
        return { ...clip, sopSteps };
    });

    res.json({ ...video, clips: clipsWithSops });
});

// ---- DELETE /api/videos/:id ----
router.delete('/:id', (req, res) => {
    const video = stmts.getVideo.get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });

    // Clean up files
    const clips = stmts.getClipsByVideo.all(video.id);
    for (const clip of clips) {
        const sopSteps = stmts.getSopStepsByClip.all(clip.id);
        for (const step of sopSteps) {
            if (step.screenshot_path) {
                const fp = path.join(DATA_DIR, step.screenshot_path);
                if (fs.existsSync(fp)) fs.unlinkSync(fp);
            }
        }
        if (clip.file_path) {
            const fp = path.join(DATA_DIR, clip.file_path);
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
        }
    }

    // Delete video file
    if (video.file_path && fs.existsSync(video.file_path)) {
        fs.unlinkSync(video.file_path);
    }

    // DB cascade handles clips + sop_steps
    const { db } = require('../db');
    db.prepare('DELETE FROM videos WHERE id = ?').run(req.params.id);

    res.json({ success: true });
});

// ---- GET /api/videos/clips/:clipId/export ----
router.get('/clips/:clipId/export', async (req, res) => {
    try {
        const { clipId } = req.params;
        const AdmZip = require('adm-zip');

        // 1. Get clip and SOP steps
        // We need to find the clip first
        let clip;
        const allVideos = stmts.listVideos.all();
        for (const v of allVideos) {
            const clips = stmts.getClipsByVideo.all(v.id);
            const found = clips.find(c => c.id === clipId);
            if (found) {
                clip = found;
                clip.videoTitle = v.title;
                break;
            }
        }

        if (!clip) return res.status(404).json({ error: 'Clip not found' });

        const steps = stmts.getSopStepsByClip.all(clipId);
        const zip = new AdmZip();

        // Helper for duration formatting in HTML
        const fmtDur = (s) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;

        // YouTube Jump Link Logic for Export
        let youtubeJumpLinkHtml = '';
        if (clip.source_url && (clip.source_url.includes('youtube.com') || clip.source_url.includes('youtu.be'))) {
            const baseUrl = clip.source_url.split('&t=')[0].split('?t=')[0];
            const jumpUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}t=${Math.floor(clip.start_time)}`;
            youtubeJumpLinkHtml = `
            <div style="margin-top: 1rem;">
                <a href="${jumpUrl}" target="_blank" style="display:inline-block; background:#2563eb; color:white; text-decoration:none; padding: 0.6rem 1.2rem; border-radius: 6px; font-weight: 500;">📺 View on YouTube at ${fmtDur(clip.start_time)}</a>
            </div>
          `;
        }

        // 2. Generate HTML
        let stepsHtml = steps.map(step => `
            <div class="step" style="margin-bottom: 3rem; page-break-inside: avoid; border-bottom: 1px solid #eee; padding-bottom: 2rem;">
                <div class="step-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 1rem;">
                    <h2 style="margin:0; color:#2563eb;">Step ${step.step_number}</h2>
                </div>
                <div class="instruction" style="font-size: 1.2rem; line-height: 1.6; margin-bottom: 1.5rem;">
                    ${step.instruction}
                </div>
                ${step.screenshot_path ? `
                    <div class="screenshot" style="margin-bottom: 1rem;">
                        <img src="images/${path.basename(step.screenshot_path)}" style="max-width: 100%; border-radius: 8px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);">
                    </div>
                ` : ''}
                ${step.code_or_prompt ? `
                    <pre style="background: #f8fafc; padding: 1rem; border-radius: 6px; border: 1px solid #e2e8f0; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;">${step.code_or_prompt}</pre>
                ` : ''}
            </div>
        `).join('');

        const html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>SOP: ${clip.title}</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.5; color: #1e293b; max-width: 900px; margin: 0 auto; padding: 2rem; background: #fff; }
                    .header { margin-bottom: 3rem; border-bottom: 2px solid #2563eb; padding-bottom: 1rem; }
                    .header h1 { margin: 0; color: #0f172a; }
                    .header p { color: #64748b; margin: 0.5rem 0 0 0; }
                    @media print {
                        body { padding: 0; }
                        .step { border-bottom: none; }
                    }
                </style>
            </head>
            <body>
                <div class="header">
                    <h1>${clip.title}</h1>
                    <p>Source Video: ${clip.videoTitle}</p>
                    <p>Description: ${clip.description || 'No description provided.'}</p>
                    ${youtubeJumpLinkHtml}
                </div>
                <div class="steps">
                    ${stepsHtml}
                </div>
                <footer style="margin-top: 5rem; text-align: center; color: #94a3b8; font-size: 0.875rem;">
                    Generated by SOPGen | Built by <a href="https://quantana.com.au" style="color: #94a3b8; text-decoration: underline;">Quantana</a>
                </footer>
            </body>
            </html>
        `;

        zip.addFile('index.html', Buffer.from(html, 'utf8'));

        // 3. Add images
        for (const step of steps) {
            if (step.screenshot_path) {
                const imgPath = path.join(DATA_DIR, step.screenshot_path);
                if (fs.existsSync(imgPath)) {
                    zip.addLocalFile(imgPath, 'images');
                }
            }
        }

        // 4. Send ZIP
        const zipBuffer = zip.toBuffer();
        const safeTitle = (clip.title || 'sop').replace(/[^a-z0-9]/gi, '_').toLowerCase();

        res.set('Content-Type', 'application/zip');
        res.set('Content-Disposition', `attachment; filename="${safeTitle}_sop.zip"`);
        res.send(zipBuffer);

    } catch (err) {
        console.error('Export error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
