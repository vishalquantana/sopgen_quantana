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

    const result = await model.generateContent([prompt, audioPart]);
    let text = result.response.text().trim();

    // Parse JSON, stripping any markdown fences if present
    text = text.replace(/^```json\s*/, '').replace(/```\s*$/, '');

    try {
        return JSON.parse(text);
    } catch (e) {
        console.warn('Initial JSON parse failed, attempting cleanup...', e.message);
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) {
            text = text.substring(firstBrace, lastBrace + 1);
        }

        // Final attempt
        try {
            return JSON.parse(text);
        } catch (e2) {
            console.error('Final JSON parse failed. Raw response snippet:', text.slice(0, 500));
            // Return a fallback segment if parsing fails but we want to continue
            return { segments: [{ title: 'Main Lesson', description: 'Overview', startTime: 0, endTime: durationSeconds }] };
        }
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

    const prompt = `You are creating a step-by-step SOP (Standard Operating Procedure) document for a tutorial segment titled "${segmentTitle}".

I'm providing you with ${frames.length} screenshots from the video at different timestamps, plus the transcript of this segment.
I've also run OCR on each frame to extract visible text, which is shown alongside the frame descriptions.

FRAMES:
${frameDescriptions}

TRANSCRIPT SLICE:
${transcriptSlice}

YOUR TASK:
Create clear, actionable SOP steps. For each step:
1. Identify which screenshot best represents this step (by frame number)
2. Write a clear instruction for what the user should do
3. If there's any specific text, code, prompt, URL, command, or value the user needs to type/enter, include it in "codeOrPrompt"

RULES:
- Steps should be in logical order
- Each step should be ONE clear action
- Be specific and precise ("Click the blue 'Submit' button in the top right" not "Click submit")
- Include ALL relevant code, prompts, or text that needs to be typed
- Skip any steps that are just waiting or filler
- Reference what's visible on screen in each step
- Use the OCR text to identify exact button labels, field names, URLs, and code snippets

Respond in this exact JSON format:
{
  "steps": [
    {
      "frameIndex": 0,
      "instruction": "Clear instruction text",
      "codeOrPrompt": "any code or text to type, or null if not applicable"
    }
  ]
}

Return ONLY valid JSON, no markdown fences.`;

    const contentParts = [prompt, ...imageParts.map(ip => ip.part)];
    const result = await model.generateContent(contentParts);
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
    return parsed.steps.map(step => ({
        ...step,
        timestamp: frames[step.frameIndex]?.timestamp || frames[0]?.timestamp || 0,
        screenshotPath: frames[step.frameIndex]?.path || frames[0]?.path,
    }));
}

module.exports = {
    transcribeAndSegment,
    generateSopSteps,
};
