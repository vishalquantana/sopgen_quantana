const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PYTHON_ENV_BIN = path.join(process.cwd(), 'python_env', 'bin', 'parakeet-mlx');

// Store active processes to allow killing them
const activeProcesses = new Map();

/**
 * Transcribe audio using local Parakeet-MLX CLI.
 * Returns the full transcript as text.
 */
async function transcribeLocal(audioPath, videoId, onProgress) {
    const audioDir = path.dirname(audioPath);
    const audioName = path.basename(audioPath, path.extname(audioPath));
    const outputDir = audioDir;
    // Parakeet saves as [audioName].srt
    const srtPath = path.join(outputDir, `${audioName}.srt`);
    const txtPath = path.join(outputDir, `${audioName}.txt`);

    // CACHE: If transcript already exists (either .srt or .txt), use it
    if (fs.existsSync(txtPath)) {
        console.log(`[Parakeet] Found existing TXT transcript for ${videoId}, using cache.`);
        if (onProgress) onProgress("Using cached transcript.");
        return fs.readFileSync(txtPath, 'utf8').trim();
    }

    if (fs.existsSync(srtPath)) {
        console.log(`[Parakeet] Found existing SRT transcript for ${videoId}, converting and using cache.`);
        const transcript = parseSrtToText(fs.readFileSync(srtPath, 'utf8'));
        fs.writeFileSync(txtPath, transcript);
        return transcript;
    }

    return new Promise((resolve, reject) => {
        console.log(`[Parakeet] Transcribing ${audioPath} with MLX-optimized Parakeet...`);

        // Kill any existing process for this video
        if (activeProcesses.has(videoId)) {
            try {
                activeProcesses.get(videoId).kill();
            } catch (e) { }
        }

        // We run via the venv's parakeet-mlx binary directly (no need for 'source activate' in spawn)
        const parakeet = spawn(PYTHON_ENV_BIN, [
            '--verbose',
            '--output-format', 'srt',
            '--output-dir', outputDir,
            '--highlight-words',
            audioPath
        ]);

        activeProcesses.set(videoId, parakeet);

        let errorOutput = '';

        // Parakeet output usually shows progress or logs to stdout/stderr
        parakeet.stdout.on('data', (data) => {
            const out = data.toString();
            // Look for time markers like [00:00:00,960 --> 00:00:04,160]
            const match = out.match(/\[(\d{2}):(\d{2}):(\d{2}),\d+ --> (\d{2}):(\d{2}):(\d{2}),\d+\]/);
            if (match && onProgress) {
                const hours = parseInt(match[4]);
                const mins = hours > 0 ? (hours * 60 + parseInt(match[5])) : match[5];
                const secs = match[6];
                onProgress(`Transcribing: reached ${mins}:${secs}`);
            }
            console.log(`[Parakeet STDOUT] ${out}`);
        });

        parakeet.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        parakeet.on('close', (code) => {
            activeProcesses.delete(videoId);
            if (code !== 0 && code !== null) {
                console.error(`[Parakeet] Failed with code ${code}: ${errorOutput}`);
                return reject(new Error(`Parakeet failed: ${errorOutput}`));
            }

            try {
                if (fs.existsSync(srtPath)) {
                    const srtContent = fs.readFileSync(srtPath, 'utf8');
                    const transcript = parseSrtToText(srtContent);
                    // Save as .txt for future cached access
                    fs.writeFileSync(txtPath, transcript);
                    resolve(transcript);
                } else {
                    reject(new Error(`Parakeet output file not found: ${srtPath}`));
                }
            } catch (err) {
                reject(err);
            }
        });
    });
}

/**
 * Poor man's SRT to plain text converter with timestamps kept in [MM:SS] format for pipeline compatibility.
 */
function parseSrtToText(srt) {
    const lines = srt.split(/\r?\n/);
    let result = '';
    let currentText = '';
    let currentTimestamp = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        // Sequence number (skip)
        if (/^\d+$/.test(line)) continue;

        // Timestamp line: 00:00:10,500 --> 00:00:13,000
        const tsMatch = line.match(/^(\d{2}):(\d{2}):(\d{2}),\d+ -->/);
        if (tsMatch) {
            const mins = parseInt(tsMatch[2]) + (parseInt(tsMatch[1]) * 60);
            const secs = tsMatch[3];
            currentTimestamp = `[${mins}:${secs}]`;
            continue;
        }

        // Text line
        if (currentTimestamp) {
            result += `${currentTimestamp} ${line}\n`;
            currentTimestamp = '';
        }
    }
    return result;
}

/**
 * Kill an active transcription process
 */
function killTranscription(videoId) {
    if (activeProcesses.has(videoId)) {
        console.log(`[Parakeet] Killing transcription for ${videoId}`);
        activeProcesses.get(videoId).kill();
        activeProcesses.delete(videoId);
    }
}

/**
 * Check if Parakeet is available in our local venv.
 */
async function isAvailable() {
    return fs.existsSync(PYTHON_ENV_BIN);
}

module.exports = {
    transcribeLocal,
    killTranscription,
    isAvailable
};
