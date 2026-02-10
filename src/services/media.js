const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { DATA_DIR } = require('../db');

/**
 * Get video duration in seconds
 */
function getVideoDuration(videoPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) return reject(err);
            resolve(metadata.format.duration || 0);
        });
    });
}

/**
 * Generate a thumbnail from the video (frame at 10% of duration)
 */
function generateThumbnail(videoPath, outputName) {
    const outputPath = path.join(DATA_DIR, 'thumbnails', `${outputName}.jpg`);
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) return reject(err);
            const duration = metadata.format.duration || 10;
            const timestamp = Math.min(duration * 0.1, 5);

            ffmpeg(videoPath)
                .seekInput(timestamp)
                .frames(1)
                .size('640x360')
                .output(outputPath)
                .on('end', () => resolve(outputPath))
                .on('error', reject)
                .run();
        });
    });
}

/**
 * Extract audio from video as mp3 for transcription (cost-efficient)
 */
function extractAudio(videoPath, outputName) {
    const outputPath = path.join(DATA_DIR, 'audio', `${outputName}.mp3`);
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .noVideo()
            .audioCodec('libmp3lame')
            .audioBitrate('64k')        // low bitrate, speech is fine at 64k
            .audioChannels(1)           // mono
            .audioFrequency(16000)      // 16kHz, optimal for speech
            .output(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .run();
    });
}

/**
 * Extract a single frame at a specific timestamp as a PNG screenshot
 */
function extractFrame(videoPath, timestampSeconds, outputName) {
    const outputPath = outputName.includes(path.sep)
        ? outputName
        : path.join(DATA_DIR, 'screenshots', `${outputName}.png`);

    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .screenshots({
                timestamps: [timestampSeconds],
                filename: path.basename(outputPath),
                folder: path.dirname(outputPath),
                size: '1280x720'
            })
            .on('end', () => resolve(outputPath))
            .on('error', reject);
    });
}

/**
 * Generate a trimmed clip from the source video
 */
function generateClip(videoPath, startTime, endTime, outputName) {
    const outputPath = path.join(DATA_DIR, 'clips', `${outputName}.mp4`);
    const duration = endTime - startTime;
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .seekInput(startTime)
            .duration(duration)
            .videoCodec('libx264')
            .audioCodec('aac')
            .outputOptions(['-movflags', '+faststart', '-preset', 'fast'])
            .output(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', reject)
            .run();
    });
}

module.exports = {
    getVideoDuration,
    generateThumbnail,
    extractAudio,
    extractFrame,
    generateClip,
};
