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

    let lastOcrText = '';

    for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const ocrText = (ocrTexts?.[i] || '').trim();

        // DE-DUPLICATION: Skip if OCR text is nearly identical to previous frame
        if (ocrText && ocrText === lastOcrText) {
            console.log(`[LocalVision] Skipping frame ${i} (Duplicate OCR text)`);
            continue;
        }
        lastOcrText = ocrText;

        const prompt = `You are a World-Class Technical Trainer. Create a professional SOP step for a tutorial titled "${segmentTitle}".
 
Screenshot timestamp: ${Math.round(frame.timestamp)}s.
OCR Text visible: "${ocrText.slice(0, 500)}"

TASK:
1. Write ONE clear, action-oriented instruction (e.g., Click, Enter, Navigate). 
2. Use specific labels from the OCR text.
3. If this frame is NOT a tutorial step (e.g. just a talking head, intro slide, or redundant), set score to 0.
4. If it IS a valid step, set a score (0-100).

Respond in JSON (no fences):
{"instruction": "...", "codeOrPrompt": "...", "score": 80}`;

        try {
            const response = await describeImage(frame.path, prompt);
            const cleaned = response.replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();

            try {
                const parsed = JSON.parse(cleaned);

                // Skip fluff frames
                if (parsed.score < 20) {
                    console.log(`[LocalVision] Skipping frame ${i} (Low educational score: ${parsed.score})`);
                    continue;
                }

                steps.push({
                    frameIndex: i,
                    instruction: parsed.instruction || 'Follow the step shown.',
                    codeOrPrompt: parsed.codeOrPrompt || null,
                    timestamp: frame.timestamp,
                    screenshotPath: frame.path,
                });
                totalScore += (parsed.score || 50);
            } catch {
                // Fallback for non-JSON response
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
