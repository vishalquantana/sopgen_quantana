const { v4: uuid } = require('uuid');
const path = require('path');
const { stmts, DATA_DIR } = require('../db');
const media = require('./media');
const gemini = require('./gemini');
const ocr = require('./ocr');
const localVision = require('./local-vision');

/**
 * Get the configured vision provider.
 * Returns 'local' if llama.cpp server is running, otherwise 'gemini'.
 * Can be overridden by VISION_PROVIDER env var.
 */
async function getVisionProvider() {
    const override = process.env.VISION_PROVIDER;
    if (override === 'local') return 'local';
    if (override === 'gemini') return 'gemini';

    // Auto-detect: prefer local if available
    const localAvailable = await localVision.isAvailable();
    if (localAvailable) {
        console.log('[Pipeline] Using LOCAL vision provider (Qwen3-VL via llama.cpp)');
        return 'local';
    }

    console.log('[Pipeline] Using GEMINI vision provider (cloud API)');
    return 'gemini';
}

/**
 * Full processing pipeline for a video.
 * Runs asynchronously — updates DB status at each phase.
 */
/**
 * Helper to log progress to DB and console
 */
function logProgress(videoId, message) {
    const ts = new Date().toLocaleTimeString();
    const formatted = `[${ts}] ${message}`;
    console.log(`[Pipeline][${videoId}] ${message}`);
    try {
        stmts.addPipelineLog.run({ id: videoId, message: formatted });
    } catch (e) {
        console.error('Failed to log progress to DB:', e.message);
    }
}

/**
 * Full processing pipeline for a video.
 * Runs asynchronously — updates DB status at each phase.
 */
async function processVideo(videoId) {
    const video = stmts.getVideo.get(videoId);
    if (!video) throw new Error('Video not found');

    const visionProvider = await getVisionProvider();
    logProgress(videoId, `Starting pipeline (Provider: ${visionProvider})`);

    try {
        // === PHASE 1: Extract audio and transcribe ===
        const duration = await media.getVideoDuration(video.file_path);

        // Estimate finish time: 60s base + 0.6s per sec of duration
        const estimateMs = 60000 + (duration * 600);
        const estimatedFinishAt = new Date(Date.now() + estimateMs).toISOString();
        stmts.updateVideoEstimate.run({ id: videoId, estimateAt: estimatedFinishAt });
        logProgress(videoId, `Estimated completion time: ${Math.ceil(estimateMs / 60000)} minutes`);

        // Update meta if needed
        if (video.title === 'Untitled' || !video.thumbnail_path) {
            const thumbnailPath = await media.generateThumbnail(video.file_path, videoId);
            stmts.updateVideoMeta.run({
                id: videoId,
                title: video.title === 'Untitled' ? path.basename(video.file_path, path.extname(video.file_path)) : video.title,
                durationSeconds: duration,
                thumbnailPath: path.relative(DATA_DIR, thumbnailPath),
            });
        }

        let transcript = video.transcript;
        let segments = [];

        if (transcript) {
            logProgress(videoId, "Found existing transcript, skipping Phase 1.");
            // We need segments even if we have a transcript. 
            // In a real resumable system we might store segments in DB. 
            // For now, if we have transcript but no clips, we might need to re-segment or check clips table.
        } else {
            stmts.updateVideoStatus.run({ id: videoId, status: 'transcribing' });
            logProgress(videoId, "Phase 1: Extracting audio...");
            const audioPath = await media.extractAudio(video.file_path, videoId);

            logProgress(videoId, "Phase 1: Transcribing with Gemini...");
            const result = await gemini.transcribeAndSegment(audioPath, duration);
            transcript = result.transcript;
            segments = result.segments;

            stmts.updateVideoTranscript.run({ id: videoId, transcript: transcript || '' });
            logProgress(videoId, `Phase 1 complete. Found ${segments.length} segments.`);
        }

        // === PHASE 2: Generate clips ===
        // If we don't have segments in memory (skipped phase 1), segments will be empty.
        // We should check the clips table to see what's already done.
        const existingClips = stmts.getClipsByVideo.all(videoId);

        // If we skipped Phase 1 but have no clips, we actually DO need to re-segment to know what clips to make.
        // For simplicity in this iteration: if clips exist, we skip Phase 2 for THOSE clips.

        if (segments.length === 0 && existingClips.length > 0) {
            logProgress(videoId, `Found ${existingClips.length} existing clips, resuming from there.`);
            // Mock segments from existing clips for Phase 3
            segments = existingClips.map(c => ({
                title: c.title,
                description: c.description,
                startTime: c.start_time,
                endTime: c.end_time,
                id: c.id
            }));
        } else if (segments.length > 0) {
            for (let i = 0; i < segments.length; i++) {
                // Cancellation check
                const current = stmts.getVideo.get(videoId);
                if (current.status === 'error') {
                    console.log(`[Pipeline][${videoId}] Cancellation detected in Phase 2. Aborting.`);
                    return;
                }

                const seg = segments[i];

                // Check if this clip index already exists
                const existing = existingClips.find(c => c.clip_index === i + 1);
                if (existing && existing.status === 'complete') {
                    logProgress(videoId, `Clip ${i + 1} already exists and is complete, skipping.`);
                    seg.id = existing.id;
                    continue;
                }

                const clipId = existing ? existing.id : uuid();
                seg.id = clipId;

                const startTime = Math.max(0, seg.startTime);
                const endTime = Math.min(duration, seg.endTime);

                if (!existing) {
                    stmts.insertClip.run({
                        id: clipId,
                        videoId,
                        clipIndex: i + 1,
                        title: seg.title,
                        description: seg.description,
                        startTime,
                        endTime,
                    });
                }

                logProgress(videoId, `Generating clip ${i + 1}/${segments.length}: ${seg.title}`);

                try {
                    const clipPath = await media.generateClip(video.file_path, startTime, endTime, clipId);
                    const clipThumbPath = await media.generateThumbnail(clipPath, `clip_${clipId}`);

                    stmts.updateClipFile.run({
                        id: clipId,
                        filePath: path.relative(DATA_DIR, clipPath),
                        thumbnailPath: path.relative(DATA_DIR, clipThumbPath),
                    });
                } catch (err) {
                    logProgress(videoId, `Error matching clip ${i + 1}: ${err.message}`);
                    stmts.updateClipStatus.run({ id: clipId, status: 'error' });
                }
            }
        }

        // === PHASE 3: Generate SOPs for each clip ===
        stmts.updateVideoStatus.run({ id: videoId, status: 'generating_sops' });

        for (let i = 0; i < segments.length; i++) {
            // Cancellation check
            const current = stmts.getVideo.get(videoId);
            if (current.status === 'error') {
                console.log(`[Pipeline][${videoId}] Cancellation detected in Phase 3. Aborting.`);
                return;
            }

            const seg = segments[i];
            const clipId = seg.id;

            // Check if SOP steps already exist
            const existingSteps = stmts.getSopStepsByClip.all(clipId);
            if (existingSteps.length > 0) {
                logProgress(videoId, `SOP for clip ${i + 1} already exists, skipping.`);
                continue;
            }

            logProgress(videoId, `Phase 3: Generating SOP ${i + 1}/${segments.length} ("${seg.title}")`);

            const startTime = Math.max(0, seg.startTime);
            const endTime = Math.min(duration, seg.endTime);
            const clipDuration = endTime - startTime;
            const numFrames = Math.min(Math.max(5, Math.ceil(clipDuration / 10)), 15);
            const interval = clipDuration / numFrames;

            const frames = [];
            for (let j = 0; j < numFrames; j++) {
                const ts = startTime + (j * interval) + (interval / 2);
                const frameName = `${clipId}_frame_${j}`;
                try {
                    const framePath = await media.extractFrame(video.file_path, ts, frameName);
                    frames.push({ timestamp: ts, path: framePath });
                } catch (err) {
                    console.error(`[Pipeline] Failed to extract frame at ${ts}s:`, err.message);
                }
            }

            if (frames.length === 0) {
                logProgress(videoId, `No frames for clip ${i + 1}, skipping SOP.`);
                continue;
            }

            logProgress(videoId, `Running OCR on ${frames.length} frames...`);
            const ocrResults = await ocr.extractTextBatch(frames.map(f => f.path));
            const ocrTexts = ocrResults.map(r => r.text);

            const transcriptSlice = (transcript || '').split('\n')
                .filter(line => {
                    const match = line.match(/\[(\d+):(\d+)\]/);
                    if (!match) return false;
                    const timeSec = parseInt(match[1]) * 60 + parseInt(match[2]);
                    return timeSec >= startTime && timeSec <= endTime;
                })
                .join('\n') || `Transcript for segment: ${seg.title}`;

            try {
                let sopSteps;
                if (visionProvider === 'local') {
                    sopSteps = await localVision.generateSopStepsLocal(frames, transcriptSlice, seg.title, ocrTexts);
                } else {
                    sopSteps = await gemini.generateSopSteps(frames, transcriptSlice, seg.title, ocrTexts);
                }

                for (let s = 0; s < sopSteps.length; s++) {
                    const step = sopSteps[s];
                    stmts.insertSopStep.run({
                        id: uuid(),
                        clipId: clipId,
                        stepNumber: s + 1,
                        timestamp: step.timestamp,
                        screenshotPath: step.screenshotPath ? path.relative(DATA_DIR, step.screenshotPath) : null,
                        instruction: step.instruction,
                        codeOrPrompt: step.codeOrPrompt || null,
                    });
                }
                logProgress(videoId, `Generated ${sopSteps.length} SOP steps for clip ${i + 1}`);
            } catch (err) {
                logProgress(videoId, `Error generating SOP for clip ${i + 1}: ${err.message}`);
            }
        }

        // === COMPLETE ===
        stmts.updateVideoStatus.run({ id: videoId, status: 'complete' });
        logProgress(videoId, "Processing complete! 🎉");
    } catch (err) {
        logProgress(videoId, `FATAL ERROR: ${err.message}`);
        stmts.updateVideoError.run({ id: videoId, errorMessage: err.message });
        throw err;
    }
}

module.exports = { processVideo };
