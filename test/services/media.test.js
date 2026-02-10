const { expect } = require('chai');
const path = require('path');
const fs = require('fs');
const media = require('../../src/services/media');

describe('Media Service', function () {
    this.timeout(30000);

    const testVideo = path.join(__dirname, '../../data/uploads/test_video.mp4');

    before(function () {
        // Check if there's any uploaded video to test with
        const uploadDir = path.join(__dirname, '../../data/uploads');
        const files = fs.readdirSync(uploadDir).filter(f => f.endsWith('.mp4'));
        if (files.length === 0) {
            console.log('Skipping Media tests: No videos found in data/uploads');
            this.skip();
        }
    });

    it('should get video duration', async function () {
        const uploadDir = path.join(__dirname, '../../data/uploads');
        const testFile = path.join(uploadDir, fs.readdirSync(uploadDir).filter(f => f.endsWith('.mp4'))[0]);

        const duration = await media.getVideoDuration(testFile);
        expect(duration).to.be.a('number');
        expect(duration).to.be.greaterThan(0);
    });

    it('should extract a frame', async function () {
        const uploadDir = path.join(__dirname, '../../data/uploads');
        const testFile = path.join(uploadDir, fs.readdirSync(uploadDir).filter(f => f.endsWith('.mp4'))[0]);
        const output = path.join(__dirname, '../../data/screenshots/test_frame.png');

        const result = await media.extractFrame(testFile, 1, output);
        expect(result).to.equal(output);
        expect(fs.existsSync(output)).to.be.true;
    });
});
