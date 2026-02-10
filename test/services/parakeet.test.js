const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const path = require('path');

describe('Parakeet Service', () => {
    let transcribeLocal;
    let spawnStub;

    beforeEach(() => {
        spawnStub = sinon.stub();
        // Setup a mock object for the child process
        const mockProcess = {
            stdout: { on: sinon.stub() },
            stderr: { on: sinon.stub() },
            on: sinon.stub(),
            kill: sinon.stub()
        };
        spawnStub.returns(mockProcess);

        // Use proxyquire to inject the stubbed spawn
        const parakeet = proxyquire('../../src/services/parakeet', {
            'child_process': { spawn: spawnStub },
            'fs': {
                existsSync: sinon.stub().returns(false),
                readFileSync: sinon.stub().returns(''),
                writeFileSync: sinon.stub()
            }
        });
        transcribeLocal = parakeet.transcribeLocal;
    });

    it('should call parakeet-mlx with correct arguments', async () => {
        const audioPath = '/path/to/audio.mp3';
        const videoId = 'test-video-id';

        // Trigger transcription (it returns a promise that won't resolve until 'close' is called)
        const transcriptionPromise = transcribeLocal(audioPath, videoId);

        // Verify spawn call
        expect(spawnStub.calledOnce).to.be.true;
        const args = spawnStub.firstCall.args[1];

        // Assertions for argument construction
        expect(args).to.include('--highlight-words');
        expect(args).to.not.include('True'); // This was the bug
        expect(args[args.length - 1]).to.equal(audioPath); // audioPath should be the last (positional) argument
        expect(args).to.include('--output-format');
        expect(args).to.include('srt');
    });
});
