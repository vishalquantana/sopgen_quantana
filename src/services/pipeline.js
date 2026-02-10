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
 * Check if the video processing has been paused or stopped by user
 */
function isAborted(videoId) {
    const current = stmts.getVideo.get(videoId);
    return current.status === 'paused' || current.status === 'error';
}

/**
 * Generate SOP for a single clip
 */
async function generateSopForClip(videoId, seg, videoFilePath, duration, transcript, visionProvider) {
    const clipId = seg.id;

    // Check if SOP steps already exist
    const existingSteps = stmts.getSopStepsByClip.all(clipId);
    if (existingSteps.length > 0) {
        return;
    }

    logProgress(videoId, `Generating SOP for clip "${seg.title}"...`);

    const startTime = Math.max(0, seg.startTime);
    const endTime = Math.min(duration, seg.endTime);
    const clipDuration = endTime - startTime;
    const numFrames = Math.min(Math.max(5, Math.ceil(clipDuration / 10)), 15);
    const interval = clipDuration / numFrames;

    const frames = [];
    for (let j = 0; j < numFrames; j++) {
        if (isAborted(videoId)) return;
        const ts = startTime + (j * interval) + (interval / 2);
        const frameName = `${clipId}_frame_${j}`;
        try {
            const framePath = await media.extractFrame(videoFilePath, ts, frameName);
            frames.push({ timestamp: ts, path: framePath });
        } catch (err) {
            console.error(`[Pipeline] Failed to extract frame at ${ts}s:`, err.message);
        }
    }

    if (frames.length === 0) {
        logProgress(videoId, `No frames extracted for clip "${seg.title}", skipping SOP.`);
        return;
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
        let result;
        if (visionProvider === 'local') {
            result = await localVision.generateSopStepsLocal(frames, transcriptSlice, seg.title, ocrTexts);
        } else {
            result = await gemini.generateSopSteps(frames, transcriptSlice, seg.title, ocrTexts);
        }

        const { steps, tutorialScore } = result;

        // Store steps
        for (let s = 0; s < steps.length; s++) {
            const step = steps[s];
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

        // Store score
        if (tutorialScore !== undefined) {
            stmts.updateClipScore.run({ id: clipId, score: tutorialScore });
        }

        logProgress(videoId, `Generated ${steps.length} SOP steps for clip "${seg.title}" (Tutorial Score: ${tutorialScore || 'N/A'}%)`);
    } catch (err) {
        logProgress(videoId, `Error generating SOP for clip "${seg.title}": ${err.message}`);
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
        if (isAborted(videoId)) {
            logProgress(videoId, "Pipeline aborted before start.");
            return;
        }

        // === PHASE 1: Extract audio and transcribe ===
        const duration = await media.getVideoDuration(video.file_path);

        // Estimate finish time: 60s base + 0.6s per sec of duration
        const estimateMs = 60000 + (duration * 600);
        const estimatedFinishAt = new Date(Date.now() + estimateMs).toISOString();
        stmts.updateVideoEstimate.run({ id: videoId, estimateAt: estimatedFinishAt });
        // logProgress(videoId, `Estimated completion time: ${Math.ceil(estimateMs / 60000)} minutes`);

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
            // We still need segments to know what to process
            // If we have clips in DB, we'll use them. If not, we'd need to re-segment.
        } else {
            if (isAborted(videoId)) return;
            stmts.updateVideoStatus.run({ id: videoId, status: 'transcribing' });
            logProgress(videoId, "Phase 1: Extracting audio...");
            const audioPath = await media.extractAudio(video.file_path, videoId);

            if (isAborted(videoId)) return;
            logProgress(videoId, "Phase 1: Transcribing with Gemini...");
            const result = await gemini.transcribeAndSegment(audioPath, duration);
            transcript = result.transcript;
            segments = result.segments;

            stmts.updateVideoTranscript.run({ id: videoId, transcript: transcript || '' });
            logProgress(videoId, `Phase 1 complete. Found ${segments.length} segments.`);
        }

        // === PHASE 2: Generate clips AND SOPs per-clip ===
        const existingClips = stmts.getClipsByVideo.all(videoId);

        if (segments.length === 0 && existingClips.length > 0) {
            logProgress(videoId, `Found ${existingClips.length} existing clips, resuming...`);
            segments = existingClips.map(c => ({
                title: c.title,
                description: c.description,
                startTime: c.start_time,
                endTime: c.end_time,
                id: c.id
            }));
        }

        if (segments.length > 0) {
            stmts.updateVideoStatus.run({ id: videoId, status: 'processing' });

            for (let i = 0; i < segments.length; i++) {
                if (isAborted(videoId)) {
                    logProgress(videoId, "Aborted during clip processing.");
                    return;
                }

                const seg = segments[i];
                const existing = existingClips.find(c => c.clip_index === i + 1);
                const clipId = existing ? existing.id : uuid();
                seg.id = clipId;

                if (!existing) {
                    stmts.insertClip.run({
                        id: clipId,
                        videoId,
                        clipIndex: i + 1,
                        title: seg.title,
                        description: seg.description,
                        startTime: Math.max(0, seg.startTime),
                        endTime: Math.min(duration, seg.endTime),
                    });
                }

                // Skip clip generation if already done
                if (!existing || existing.status !== 'complete') {
                    logProgress(videoId, `Generating clip ${i + 1}/${segments.length}: ${seg.title}`);
                    try {
                        const clipPath = await media.generateClip(video.file_path, seg.startTime, seg.endTime, clipId);
                        const clipThumbPath = await media.generateThumbnail(clipPath, `clip_${clipId}`);

                        stmts.updateClipFile.run({
                            id: clipId,
                            filePath: path.relative(DATA_DIR, clipPath),
                            thumbnailPath: path.relative(DATA_DIR, clipThumbPath),
                        });
                    } catch (err) {
                        logProgress(videoId, `Error generating clip ${i + 1}: ${err.message}`);
                        stmts.updateClipStatus.run({ id: clipId, status: 'error' });
                        // Continue to next clip
                    }
                }

                // Immediately Generate SOP for this clip
                if (!isAborted(videoId)) {
                    try {
                        await generateSopForClip(videoId, seg, video.file_path, duration, transcript, visionProvider);
                    } catch (err) {
                        logProgress(videoId, `Error in SOP phase for clip ${i + 1}: ${err.message}`);
                    }
                }
            }
        }

        // === COMPLETE ===
        if (!isAborted(videoId)) {
            stmts.updateVideoStatus.run({ id: videoId, status: 'complete' });
            logProgress(videoId, "Processing complete! 🎉");
        }
    } catch (err) {
        if (!isAborted(videoId)) {
            logProgress(videoId, `FATAL ERROR: ${err.message}`);
            stmts.updateVideoError.run({ id: videoId, errorMessage: err.message });
            logProgress(videoId, `Regenerating tutorial scores for ${clips.length} clips...`);

            for (const clip of clips) {
                if (isAborted(videoId)) return;

                logProgress(videoId, `Scoring clip: ${clip.title}`);

                // We reuse the generateSopForClip logic but we'll modify it slightly 
                // Or just re-run it — since it skips steps if they exist, it's safe.
                // HOWEVER, our current generateSopForClip returns early if steps exist.
                // Let's make a dedicated scoring function if we want to be efficient.

                const startTime = Math.max(0, clip.start_time);
                const endTime = Math.min(video.duration_seconds, clip.end_time);
                const clipDuration = endTime - startTime;
                const numFrames = 5; // Fewer frames for just scoring
                const interval = clipDuration / numFrames;

                const frames = [];
                for (let j = 0; j < numFrames; j++) {
                    const ts = startTime + (j * interval) + (interval / 2);
                    const frameName = `score_${clip.id}_${j}`;
                    try {
                        const framePath = await media.extractFrame(video.file_path, ts, frameName);
                        frames.push({ timestamp: ts, path: framePath });
                    } catch (e) { }
                }

                if (frames.length === 0) continue;

                try {
                    // Transcript slice
                    const transcriptSlice = (video.transcript || '').split('\n')
                        .filter(line => {
                            const match = line.match(/\[(\d+):(\d+)\]/);
                            if (!match) return false;
                            const timeSec = parseInt(match[1]) * 60 + parseInt(match[2]);
                            return timeSec >= startTime && timeSec <= endTime;
                        })
                        .join('\n');

                    let result;
                    if (visionProvider === 'local') {
                        result = await localVision.generateSopStepsLocal(frames, transcriptSlice, clip.title);
                    } else {
                        result = await gemini.generateSopSteps(frames, transcriptSlice, clip.title);
                    }

                    if (result.tutorialScore !== undefined) {
                        stmts.updateClipScore.run({ id: clip.id, score: result.tutorialScore });
                        logProgress(videoId, `Score for "${clip.title}": ${result.tutorialScore}%`);
                    }
                } catch (err) {
                    logProgress(videoId, `Failed to score "${clip.title}": ${err.message}`);
                }
            }
            logProgress(videoId, "Score regeneration complete.");
        }

        module.exports = {
            processVideo,
            regenerateScores,
        };
