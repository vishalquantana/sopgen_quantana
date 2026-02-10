const { v4: uuid } = require('uuid');
const path = require('path');
const { stmts, DATA_DIR } = require('../db');
const media = require('./media');
const gemini = require('./gemini');
const ocr = require('./ocr');
const localVision = require('./local-vision');
const whisper = require('./whisper');
const parakeet = require('./parakeet');

/**
 * Get the configured vision provider.
 * Returns 'local' if llama.cpp server is running, otherwise 'gemini'.
 * Can be overridden by VISION_PROVIDER env var.
 */
async function getVisionProvider() {
    const override = process.env.VISION_PROVIDER;
    if (override === 'local') return 'local';
    if (override === 'gemini') return 'gemini';

    const localAvailable = await localVision.isAvailable();
    if (localAvailable) return 'local';
    return 'gemini';
}

/**
 * Get the configured transcription provider.
 */
async function getTranscriptionProvider() {
    const override = process.env.TRANSCRIPTION_PROVIDER;
    if (override === 'local') return 'local';
    if (override === 'gemini') return 'gemini';

    const parakeetAvailable = await parakeet.isAvailable();
    if (parakeetAvailable) return 'local';

    const whisperAvailable = await whisper.isAvailable();
    if (whisperAvailable) return 'local';

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

    const framePromises = [];
    for (let j = 0; j < numFrames; j++) {
        const ts = startTime + (j * interval) + (interval / 2);
        const frameName = `${clipId}_frame_${j}`;

        framePromises.push((async () => {
            if (isAborted(videoId)) return null;
            try {
                const framePath = await media.extractFrame(videoFilePath, ts, frameName);
                return { timestamp: ts, path: framePath };
            } catch (err) {
                console.error(`[Pipeline] Failed to extract frame at ${ts}s:`, err.message);
                return null;
            }
        })());
    }

    const frames = (await Promise.all(framePromises)).filter(f => f !== null);

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
            const transProvider = await getTranscriptionProvider();
            logProgress(videoId, `Phase 1: Starting transcription (Provider: ${transProvider})...`);

            stmts.updateVideoStatus.run({ id: videoId, status: 'transcribing' });
            logProgress(videoId, "Phase 1: Extracting audio...");
            const audioPath = await media.extractAudio(video.file_path, videoId);

            if (isAborted(videoId)) {
                whisper.killTranscription(videoId);
                return;
            }

            if (transProvider === 'local') {
                const parakeetAvailable = await parakeet.isAvailable();
                if (parakeetAvailable) {
                    logProgress(videoId, "Phase 1: Transcribing locally with MLX-optimized Parakeet...");
                    try {
                        transcript = await parakeet.transcribeLocal(audioPath, videoId, (msg) => {
                            logProgress(videoId, msg);
                        });
                    } catch (err) {
                        parakeet.killTranscription(videoId);
                        throw err;
                    }
                } else {
                    logProgress(videoId, "Phase 1: Transcribing locally with Whisper...");
                    try {
                        transcript = await whisper.transcribeLocal(audioPath, videoId, (msg) => {
                            logProgress(videoId, msg);
                        });
                    } catch (err) {
                        whisper.killTranscription(videoId);
                        throw err;
                    }
                }

                logProgress(videoId, "Phase 1: Segmenting transcript with Gemini...");
                const result = await gemini.segmentTranscript(transcript, duration);
                segments = result.segments;
            } else {
                logProgress(videoId, "Phase 1: Transcribing with Gemini...");
                const result = await gemini.transcribeAndSegment(audioPath, duration);
                transcript = result.transcript;
                segments = result.segments;
            }

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

            // Parallel clip processing with concurrency limit
            const CONCURRENCY_LIMIT = 5;
            const chunks = [];
            for (let i = 0; i < segments.length; i += CONCURRENCY_LIMIT) {
                chunks.push(segments.slice(i, i + CONCURRENCY_LIMIT));
            }

            for (const chunk of chunks) {
                if (isAborted(videoId)) {
                    logProgress(videoId, "Aborted during clip processing.");
                    return;
                }

                await Promise.all(chunk.map(async (seg) => {
                    const segmentIndex = segments.indexOf(seg);
                    const existing = existingClips.find(c => c.clip_index === segmentIndex + 1);
                    const clipId = existing ? existing.id : uuid();
                    seg.id = clipId;

                    if (!existing) {
                        stmts.insertClip.run({
                            id: clipId,
                            videoId,
                            clipIndex: segmentIndex + 1,
                            title: seg.title,
                            description: seg.description,
                            startTime: Math.max(0, seg.startTime),
                            endTime: Math.min(duration, seg.endTime),
                        });
                    }

                    // Skip clip generation if already done
                    if (!existing || existing.status !== 'complete') {
                        logProgress(videoId, `Generating clip ${segmentIndex + 1}/${segments.length}: ${seg.title}`);
                        try {
                            const clipPath = await media.generateClip(video.file_path, seg.startTime, seg.endTime, clipId);
                            const clipThumbPath = await media.generateThumbnail(clipPath, `clip_${clipId}`);

                            stmts.updateClipFile.run({
                                id: clipId,
                                filePath: path.relative(DATA_DIR, clipPath),
                                thumbnailPath: path.relative(DATA_DIR, clipThumbPath),
                            });
                        } catch (err) {
                            logProgress(videoId, `Error generating clip ${segmentIndex + 1}: ${err.message}`);
                            stmts.updateClipStatus.run({ id: clipId, status: 'error' });
                        }
                    }

                    // Immediately Generate SOP for this clip
                    if (!isAborted(videoId)) {
                        try {
                            await generateSopForClip(videoId, seg, video.file_path, duration, transcript, visionProvider);
                        } catch (err) {
                            logProgress(videoId, `Error in SOP phase for clip ${segmentIndex + 1}: ${err.message}`);
                        }
                    }
                }));
            }
            // === COMPLETE ===
            if (!isAborted(videoId)) {
                stmts.updateVideoStatus.run({ id: videoId, status: 'complete' });
                logProgress(videoId, "Processing complete! 🎉");
            }
        }
    } catch (err) {
        whisper.killTranscription(videoId);
        parakeet.killTranscription(videoId);
        if (!isAborted(videoId)) {
            logProgress(videoId, `FATAL ERROR: ${err.message}`);
            stmts.updateVideoError.run({ id: videoId, errorMessage: err.message });
        }
        throw err;
    }
}

/**
 * Regenerate tutorial scores only for a video's clips
 */
async function regenerateScores(videoId) {
    const video = stmts.getVideo.get(videoId);
    if (!video) throw new Error('Video not found');

    const visionProvider = await getVisionProvider();
    const clips = stmts.getClipsByVideo.all(videoId);

    stmts.updateVideoStatus.run({ id: videoId, status: 'scoring' });
    logProgress(videoId, `Regenerating tutorial scores for ${clips.length} clips...`);

    for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        if (isAborted(videoId)) {
            logProgress(videoId, "Score regeneration aborted.");
            return;
        }

        logProgress(videoId, `Scoring clip ${i + 1}/${clips.length}: ${clip.title} [PROGRESS: ${i + 1}/${clips.length}]`);

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
            } catch (e) {
                console.error(`[Pipeline] Failed to extract frame for scoring at ${ts}s:`, e.message);
            }
        }

        if (frames.length === 0) {
            logProgress(videoId, `No frames extracted for scoring clip "${clip.title}", skipping.`);
            continue;
        }

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

            // Recovery: If SOP steps are missing, re-populate them
            const existingSteps = stmts.getSopStepsByClip.all(clip.id);
            if (existingSteps.length === 0 && result.steps && result.steps.length > 0) {
                logProgress(videoId, `Restoring ${result.steps.length} SOP steps for "${clip.title}"...`);
                for (let i = 0; i < result.steps.length; i++) {
                    const step = result.steps[i];
                    stmts.insertSopStep.run({
                        id: uuid(),
                        clipId: clip.id,
                        stepNumber: i + 1,
                        timestamp: step.timestamp || null,
                        screenshot_path: frames[i]?.path ? path.relative(DATA_DIR, frames[i].path) : null,
                        instruction: step.instruction,
                        codeOrPrompt: step.codeOrPrompt || step.code || step.prompt || null
                    });
                }
            }
        } catch (err) {
            logProgress(videoId, `Failed to recover "${clip.title}": ${err.message}`);
        }
    }
    stmts.updateVideoStatus.run({ id: videoId, status: 'complete' });
    logProgress(videoId, "Score regeneration complete.");
}

function logProgress(videoId, message) {
    const timestamp = new Date().toLocaleTimeString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(`[Video:${videoId}] ${message}`);
    stmts.addPipelineLog.run({ id: videoId, message: logMessage });
}

module.exports = {
    processVideo,
    regenerateScores,
};
