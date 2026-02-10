const request = require('supertest');
const { expect } = require('chai');
const app = require('../../src/server'); // We need to export app from server.js

describe('API Routes', function () {
    it('GET /api/settings should return provider info', async function () {
        const res = await request(app).get('/api/settings');
        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('visionProvider');
        expect(res.body).to.have.property('localModelAvailable');
    });

    it('GET /api/videos should return a list', async function () {
        const res = await request(app).get('/api/videos');
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('array');
    });
});
