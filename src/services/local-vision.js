const fs = require('fs');

/**
 * Local Vision Provider using Qwen3-VL via llama.cpp server.
 * 
 * Prerequisites:
 * 1. Download Qwen3-VL-8B-Instruct GGUF from:
 *    https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF
 * 2. Start llama-server:
 *    llama-server \
 *      -m path/to/Qwen3VL-8B-Instruct-Q4_K_M.gguf \
 *      --mmproj path/to/mmproj-Qwen3VL-8B-Instruct-F16.gguf
 * 3. Server runs on http://localhost:8080 with OpenAI-compatible API
 */

const LLAMA_SERVER_URL = process.env.LLAMA_SERVER_URL || 'http://localhost:8080';

/**
 * Check if the local llama.cpp server is running
 */
async function isAvailable() {
    try {
        const res = await fetch(`${LLAMA_SERVER_URL}/health`, { signal: AbortSignal.timeout(2000) });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Describe an image using Qwen3-VL via llama-server.
 * Uses the OpenAI-compatible /v1/chat/completions endpoint with image_url.
 */
async function describeImage(imagePath, prompt) {
    const imageData = fs.readFileSync(imagePath);
    const base64 = imageData.toString('base64');
    const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

    const response = await fetch(`${LLAMA_SERVER_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'qwen3-vl',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
                        { type: 'text', text: prompt || 'Describe what is shown in this screenshot in detail. Focus on UI elements, text content, buttons, and any instructions visible.' },
                    ],
                },
            ],
            max_tokens: 1024,
            temperature: 0.7,
            top_p: 0.8,
            top_k: 20,
        }),
    });

    if (!response.ok) {
        throw new Error(`Llama server error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
}

/**
 * Generate SOP steps from frames using Qwen3-VL locally.
 * Processes each frame individually to avoid overwhelming the model.
 */
async function generateSopStepsLocal(frames, transcriptSlice, segmentTitle, ocrTexts) {
    const steps = [];
    let totalScore = 0;

    for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const ocrText = ocrTexts?.[i] || '';

        const prompt = `You are creating step ${i + 1} of an SOP (Standard Operating Procedure) for a tutorial titled "${segmentTitle}".

This screenshot is from timestamp ${Math.round(frame.timestamp)}s.

Based on this screenshot:
1. Write a clear instruction for what the user should do.
2. If there's any code/text to type, include it.
3. Score this frame's "educational value" (is it a tutorial step or just fluff?). 
   Respond with a "score" from 0 to 100.

Respond in JSON (no fences):
{"instruction": "...", "codeOrPrompt": "...", "score": 80}`;

        try {
            const response = await describeImage(frame.path, prompt);
            const cleaned = response.replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();

            try {
                const parsed = JSON.parse(cleaned);
                steps.push({
                    frameIndex: i,
                    instruction: parsed.instruction || 'Follow the step shown.',
                    codeOrPrompt: parsed.codeOrPrompt || null,
                    timestamp: frame.timestamp,
                    screenshotPath: frame.path,
                });
                totalScore += (parsed.score || 50);
            } catch {
                steps.push({
                    frameIndex: i,
                    instruction: response.slice(0, 500),
                    codeOrPrompt: null,
                    timestamp: frame.timestamp,
                    screenshotPath: frame.path,
                });
                totalScore += 30;
            }
        } catch (err) {
            console.error(`[LocalVision] Error processing frame ${i}:`, err.message);
            steps.push({
                frameIndex: i,
                instruction: `Step at ${Math.round(frame.timestamp)}s`,
                codeOrPrompt: null,
                timestamp: frame.timestamp,
                screenshotPath: frame.path,
            });
        }
    }

    const tutorialScore = Math.round(totalScore / (frames.length || 1));
    return { steps, tutorialScore };
}

module.exports = { isAvailable, describeImage, generateSopStepsLocal };
