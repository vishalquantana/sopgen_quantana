const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Upload a file to Gemini's Files API and wait for it to be ready.
 */
async function uploadToGemini(filePath, mimeType) {
    const fileManager = genAI.getFileManager
        ? genAI.getFileManager()
        : null;

    // Use the inline data approach for files under 20MB
    const stats = fs.statSync(filePath);
    const fileSizeInMB = stats.size / (1024 * 1024);

    if (fileSizeInMB < 20 || !fileManager) {
        // Return inline data
        const data = fs.readFileSync(filePath);
        return {
            inlineData: {
                data: data.toString('base64'),
                mimeType,
            },
        };
    }

    // For larger files, use Files API
    const uploadResult = await fileManager.uploadFile(filePath, {
        mimeType,
        displayName: path.basename(filePath),
    });

    // Wait for file processing
    let file = uploadResult.file;
    while (file.state === 'PROCESSING') {
        await new Promise(r => setTimeout(r, 3000));
        file = await fileManager.getFile(file.name);
    }

    if (file.state === 'FAILED') {
        throw new Error('File processing failed on Gemini');
    }

    return { fileData: { fileUri: file.uri, mimeType } };
}

/**
 * Helper to retry an async function with exponential backoff
 */
async function withRetry(fn, maxRetries = 3, initialDelay = 2000) {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            const isRateLimit = err.message?.toLowerCase().includes('429') || err.message?.toLowerCase().includes('quota');
            const isNetwork = err.message?.toLowerCase().includes('fetch') || err.message?.toLowerCase().includes('network');

            if (isRateLimit || isNetwork) {
                const delay = initialDelay * Math.pow(2, i);
                console.warn(`[Gemini] Attempt ${i + 1} failed. Retrying in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw err; // Permanent error
        }
    }
    throw lastError;
}

/**
 * Phase 1: Transcribe audio and segment into topics.
 * Uses audio-only for cost efficiency.
 */
async function transcribeAndSegment(audioPath, durationSeconds) {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const audioPart = await uploadToGemini(audioPath, 'audio/mp3');

    const prompt = `You are analyzing a recording of a workshop or tutorial.

TASK: Identify the distinct topics or lessons being demonstrated.
For each topic, provide:
- A clear, descriptive title
- A one-sentence description
- The start timestamp (in seconds)
- The end timestamp (in seconds)

The total video duration is ${Math.round(durationSeconds)} seconds.

GUIDELINES:
- Each segment should be a self-contained tutorial topic
- Ideally 3-8 minutes per segment for a long video
- Skip any non-tutorial segments (intro, small talk)

Respond ONLY with this exact JSON structure:
{
  "segments": [
    {
      "title": "...",
      "description": "...",
      "startTime": 0,
      "endTime": 180
    }
  ]
}

IMPORTANT: Return valid JSON only. No markdown fences. Escape all special characters.`;

    const result = await withRetry(() => model.generateContent([prompt, audioPart]));
    let text = result.response.text().trim();

    // Parse JSON, stripping any markdown fences if present
    text = text.replace(/^```json\s*/, '').replace(/```\s*$/, '');

    // Final attempt: Character-by-character cleanup for common formatting issues
    try {
        // Fix common unescaped newlines in strings
        const partiallyFixed = text.replace(/"description":\s*"(.*?)"/gs, (match, p1) => {
            return `"description": "${p1.replace(/\n/g, ' ').replace(/"/g, '\\"')}"`;
        });
        return JSON.parse(partiallyFixed);
    } catch (e3) {
        console.error('Final JSON parse failed. Attempting partial recovery...', e3.message);

        // Strategy: Recover segments that actually parsed before the error
        const segments = [];
        const segmentMatches = text.match(/{[\s\n]*"title":.*?"endTime":\s*\d+[\s\n]*}/gs);
        if (segmentMatches) {
            for (const s of segmentMatches) {
                try {
                    segments.push(JSON.parse(s));
                } catch { }
            }
        }

        if (segments.length > 0) {
            console.log(`[Gemini] Recovered ${segments.length} segments from malformed JSON.`);
            return { segments };
        }

        // Ultimate fallback
        return { segments: [{ title: 'Main Lesson', description: 'Overview', startTime: 0, endTime: durationSeconds }] };
    }
}

/**
 * Phase 2: For each segment, generate detailed SOP steps.
 * Sends individually extracted frames + transcript slice to Gemini.
 */
async function generateSopSteps(frames, transcriptSlice, segmentTitle, ocrTexts) {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    // Build image parts
    const imageParts = [];
    for (const frame of frames) {
        const data = fs.readFileSync(frame.path);
        imageParts.push({
            timestamp: frame.timestamp,
            part: {
                inlineData: {
                    data: data.toString('base64'),
                    mimeType: 'image/png',
                },
            },
        });
    }

    const frameDescriptions = frames
        .map((f, i) => {
            let desc = `Frame ${i + 1} is at timestamp ${f.timestamp}s`;
            if (ocrTexts?.[i]) {
                desc += `\n  OCR text visible on screen: "${ocrTexts[i].slice(0, 300)}"`;
            }
            return desc;
        })
        .join('\n');

    const prompt = `You are a World-Class Technical Trainer and SOP Architect. Your goal is to create a high-quality, professional Standard Operating Procedure (SOP) for a tutorial titled "${segmentTitle}".
 
I'm providing you with ${frames.length} screenshots from the video at different timestamps, plus the transcript of this segment.
I've also run OCR on each frame to extract visible text, which is shown alongside the frame descriptions.

FRAMES:
${frameDescriptions}

TRANSCRIPT SLICE:
${transcriptSlice}

YOUR GOAL:
1. Identify the ESSENTIAL steps required to reproduce the actions in this clip.
2. CRITICAL: Avoid redundancy. Do NOT create steps for frames that show the same information (e.g., intro slides, static transitions, or repetitive talking heads). 
3. One frame should ideally represent one significant action. If multiple frames show the progress of the SAME action, pick the BEST single frame that captures the transition or the result.
4. If a frame has no educational value (just a person's face, a generic logo, or a redundant slide), SKIP it entirely.

STYLE GUIDELINES:
- Use ACTION VERBS at the start of instructions (e.g., Click, Enter, Navigate, Select, Open).
- Avoid passive phrases like "Observe", "Watch", or "Notice" unless it's a critical observation for the process.
- Be concise but precise. Reference specific UI elements or text visible on screen.

OUPUT FORMAT (JSON):
Assign a "tutorialScore" (0-100) based on how well this clip functions as a tutorial (100 = clear demo, 0 = pure talk).

Return JSON only:
{
  "tutorialScore": 85,
  "steps": [
    {
      "frameIndex": 0,
      "instruction": "Click the 'Settings' icon in the top right corner.",
      "codeOrPrompt": "any code or text to type, or null if not applicable"
    }
  ]
}

RULES:
- Return ONLY valid JSON.
- No markdown fences.
- If no tutorial steps are found in this clip, return an empty "steps" array.`;

    const contentParts = [prompt, ...imageParts.map(ip => ip.part)];
    const result = await withRetry(() => model.generateContent(contentParts));
    let text = result.response.text().trim();

    // Parse JSON, stripping any markdown fences if present
    text = text.replace(/^```json\s*/, '').replace(/```\s*$/, '');

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        console.warn('Initial SOP JSON parse failed, attempting cleanup...', e.message);
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) {
            text = text.substring(firstBrace, lastBrace + 1);
        }
        try {
            parsed = JSON.parse(text);
        } catch (e2) {
            console.error('Final SOP JSON parse failed. Raw response length:', text.length);
            throw e2;
        }
    }

    // Attach timestamps to steps
    const steps = parsed.steps.map(step => ({
        ...step,
        timestamp: frames[step.frameIndex]?.timestamp || frames[0]?.timestamp || 0,
        screenshotPath: frames[step.frameIndex]?.path || frames[0]?.path,
    }));

    return { steps, tutorialScore: parsed.tutorialScore || 0 };
}

/**
 * Segment an existing transcript into topics.
 */
async function segmentTranscript(transcript, durationSeconds) {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const prompt = `You are an expert at topic segmentation.
I have a transcript from a workshop/tutorial video (total duration: ${Math.round(durationSeconds)} seconds).

TRANSCRIPT:
${transcript.slice(0, 30000)}

TASK: Identify the distinct topics or lessons being demonstrated.
For each topic, provide:
- A clear, descriptive title
- A one-sentence description
- The approximate start timestamp (in seconds)
- The approximate end timestamp (in seconds)

Respond ONLY with this exact JSON structure:
{
  "segments": [
    {
      "title": "...",
      "description": "...",
      "startTime": 0,
      "endTime": 180
    }
  ]
}

IMPORTANT: Return valid JSON only. No markdown fences.`;

    const result = await withRetry(() => model.generateContent(prompt));
    let text = result.response.text().trim();
    text = text.replace(/^```json\s*/, '').replace(/```\s*$/, '');

    try {
        return JSON.parse(text);
    } catch (e) {
        console.error('Segmenting JSON parse failed:', e.message);
        return { segments: [{ title: 'Main Lesson', description: 'Overview', startTime: 0, endTime: durationSeconds }] };
    }
}

module.exports = {
    transcribeAndSegment,
    generateSopSteps,
    segmentTranscript,
};
