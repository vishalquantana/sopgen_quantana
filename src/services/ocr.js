const Tesseract = require('tesseract.js');

/**
 * Extract text from an image using Tesseract.js OCR.
 * Returns the extracted text string, or empty string if OCR fails.
 */
async function extractText(imagePath) {
    try {
        const result = await Tesseract.recognize(imagePath, 'eng', {
            logger: () => { },  // suppress progress logs
        });
        return result.data.text.trim();
    } catch (err) {
        console.warn(`[OCR] Failed to extract text from ${imagePath}:`, err.message);
        return '';
    }
}

/**
 * Extract text from multiple images in batch.
 * Returns array of { path, text } objects.
 */
async function extractTextBatch(imagePaths) {
    const results = [];
    for (const imgPath of imagePaths) {
        const text = await extractText(imgPath);
        results.push({ path: imgPath, text });
    }
    return results;
}

module.exports = { extractText, extractTextBatch };
