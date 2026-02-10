const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const WHISPER_BIN = process.env.WHISPER_BIN || '/opt/homebrew/bin/whisper';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'base';

// Store active processes to allow killing them
const activeProcesses = new Map();

/**
 * Transcribe audio using local Whisper CLI.
 * Returns the full transcript as text.
 */
async function transcribeLocal(audioPath, videoId, onProgress) {
    const audioDir = path.dirname(audioPath);
    const audioName = path.basename(audioPath, path.extname(audioPath));
    const outputDir = audioDir;
    const txtPath = path.join(outputDir, `${audioName}.txt`);

    // CACHE: If transcript already exists, use it
    if (fs.existsSync(txtPath)) {
        console.log(`[Whisper] Found existing transcript for ${videoId}, using cache.`);
        if (onProgress) onProgress("Using cached transcript.");
        return fs.readFileSync(txtPath, 'utf8').trim();
    }

    return new Promise((resolve, reject) => {
        console.log(`[Whisper] Transcribing ${audioPath} with model ${WHISPER_MODEL}...`);

        // Kill any existing process for this video
        if (activeProcesses.has(videoId)) {
            try {
                activeProcesses.get(videoId).kill();
            } catch (e) { }
        }

        const whisper = spawn(WHISPER_BIN, [
            audioPath,
            '--model', WHISPER_MODEL,
            '--output_format', 'txt',
            '--output_dir', outputDir,
            '--verbose', 'True' // Enable verbose to see timestamps
        ]);

        activeProcesses.set(videoId, whisper);

        let errorOutput = '';

        // Parse stdout for timestamps [00:00.000 --> 00:05.000]
        whisper.stdout.on('data', (data) => {
            const out = data.toString();
            // Look for time markers like [01:23.456 --> 01:28.123]
            const match = out.match(/\[(\d+):(\d+).(\d+) --> (\d+):(\d+).(\d+)\]/);
            if (match && onProgress) {
                const mins = match[4];
                const secs = match[5];
                onProgress(`Transcribing: reached ${mins}:${secs}`);
            }
        });

        whisper.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        whisper.on('close', (code) => {
            activeProcesses.delete(videoId);
            if (code !== 0 && code !== null) {
                console.error(`[Whisper] Failed with code ${code}: ${errorOutput}`);
                return reject(new Error(`Whisper failed: ${errorOutput}`));
            }

            try {
                if (fs.existsSync(txtPath)) {
                    const transcript = fs.readFileSync(txtPath, 'utf8');
                    resolve(transcript.trim());
                } else {
                    reject(new Error(`Whisper output file not found: ${txtPath}`));
                }
            } catch (err) {
                reject(err);
            }
        });
    });
}

/**
 * Kill an active transcription process
 */
function killTranscription(videoId) {
    if (activeProcesses.has(videoId)) {
        console.log(`[Whisper] Killing transcription for ${videoId}`);
        activeProcesses.get(videoId).kill();
        activeProcesses.delete(videoId);
    }
}

/**
 * Check if Whisper is available on the system.
 */
async function isAvailable() {
    return new Promise((resolve) => {
        const check = spawn(WHISPER_BIN, ['--version']);
        check.on('error', () => resolve(false));
        check.on('close', (code) => resolve(code === 0 || code === 2));
    });
}

module.exports = {
    transcribeLocal,
    killTranscription,
    isAvailable
};
