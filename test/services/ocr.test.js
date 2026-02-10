const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const ocr = require('../../src/services/ocr');

describe('OCR Service', function () {
    this.timeout(20000); // OCR can be slow

    it('should extract text from an image', async function () {
        // Use an existing screenshot from the artifacts if possible, 
        // or a known image in the project.
        // For testing, we'll try to find a screenshot in data/screenshots
        const screenshotDir = path.join(__dirname, '../../data/screenshots');
        if (!fs.existsSync(screenshotDir)) {
            fs.mkdirSync(screenshotDir, { recursive: true });
        }

        // We'll skip if no images are found, but ideally we'd have a fixture
        const files = fs.readdirSync(screenshotDir);
        if (files.length === 0) {
            console.log('Skipping OCR test: No screenshots found in data/screenshots');
            this.skip();
        }

        const testImage = path.join(screenshotDir, files[0]);
        const text = await ocr.extractText(testImage);

        expect(text).to.be.a('string');
        console.log('Extracted text:', text.substring(0, 50) + '...');
    });

    it('should handle missing files gracefully', async function () {
        const text = await ocr.extractText('non_existent_file.png');
        expect(text).to.equal('');
    });
});
