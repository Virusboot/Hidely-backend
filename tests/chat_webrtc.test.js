const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-for-webrtc-suite-32bytes';

const chatController = require('../src/controllers/chatController');

test('getIceServers always returns STUN servers and never leaks TURN_SECRET', async () => {
  const originalUrl = process.env.TURN_URL;
  const originalSecret = process.env.TURN_SECRET;
  process.env.TURN_URL = 'turn:turn.example.com:3478';
  process.env.TURN_SECRET = 'super-secret-turn-hmac-key-never-expose';

  let statusCode = 200;
  let body = null;
  const req = { user: { id: 42 } };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };

  try {
    await chatController.getIceServers(req, res);
  } finally {
    if (originalUrl === undefined) delete process.env.TURN_URL;
    else process.env.TURN_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.TURN_SECRET;
    else process.env.TURN_SECRET = originalSecret;
  }

  assert.equal(statusCode, 200);
  assert.equal(body.success, true);
  assert.ok(Array.isArray(body.iceServers));
  assert.ok(body.iceServers.some((s) => String(s.urls).startsWith('stun:')));

  const turnEntry = body.iceServers.find((s) => s.urls === 'turn:turn.example.com:3478');
  assert.ok(turnEntry, 'Expected Coturn TURN entry when TURN_URL and TURN_SECRET are configured');
  assert.ok(String(turnEntry.username).endsWith(':42'));
  assert.ok(String(turnEntry.credential).length > 10);
  assert.notEqual(turnEntry.credential, 'super-secret-turn-hmac-key-never-expose');
  assert.equal(JSON.stringify(body).includes('super-secret-turn-hmac-key-never-expose'), false);
});

