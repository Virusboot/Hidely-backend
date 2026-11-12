const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Stub external SDKs (like resend if omitted from local node_modules) before app imports
const origModuleLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'resend') {
    return {
      Resend: class MockResend {
        constructor() {}
        get emails() {
          return {
            send: async () => ({ data: { id: 'mock-email-id' }, error: null }),
          };
        }
      },
    };
  }
  return origModuleLoad.apply(this, arguments);
};

// Isolate environment BEFORE loading app/config modules so dotenv does not override with local secrets
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'hidely-security-test-secret-0123456789';
process.env.DATABASE_URL = '';
process.env.ALLOW_DEV_OTP = '';
process.env.GOOGLE_MAPS_API_KEY = '';
process.env.RESEND_API_KEY = '';

const db = require('../src/config/db');
const upload = require('../src/middleware/upload');

// Stateful in-memory PostgreSQL mock
const state = {
  users: [],
  otps: [],
  posts: [],
  comments: [],
  bookmarks: [],
  follows: [],
  blocks: [],
  pointTransactions: [],
  notifications: [],
  reports: [],
  nextIds: { users: 1, otps: 1, posts: 1, reports: 1 },
  failLegacyTokenVersionCol: false,
};

function resetState() {
  state.users = [];
  state.otps = [];
  state.posts = [];
  state.comments = [];
  state.bookmarks = [];
  state.follows = [];
  state.blocks = [];
  state.pointTransactions = [];
  state.notifications = [];
  state.reports = [];
  state.nextIds = { users: 1, otps: 1, posts: 1, reports: 1 };
  state.failLegacyTokenVersionCol = false;
}

async function mockQuery(sqlRaw, params = []) {
  const sql = String(sqlRaw).replace(/\s+/g, ' ').trim();

  // Transaction & DDL no-ops
  if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql) || /^ALTER TABLE|^CREATE TABLE|^CREATE INDEX/i.test(sql)) {
    return { rows: [], rowCount: 0 };
  }

  // Optional simulation of missing token_version column
  if (state.failLegacyTokenVersionCol && sql.includes('token_version') && /^SELECT/i.test(sql)) {
    const err = new Error('column "token_version" does not exist');
    err.code = '42703';
    throw err;
  }

  // authMiddleware & adminMiddleware user lookup
  if (sql.startsWith('SELECT id, COALESCE(token_version, 0) AS token_version FROM users WHERE id = $1') ||
      sql === 'SELECT id FROM users WHERE id = $1') {
    const u = state.users.find((x) => Number(x.id) === Number(params[0]));
    return { rows: u ? [{ id: u.id, token_version: u.token_version || 0 }] : [] };
  }

  if (sql.startsWith('SELECT id, email, username, is_admin, COALESCE(token_version, 0) AS token_version FROM users WHERE id = $1') ||
      sql === 'SELECT id, email, username, is_admin FROM users WHERE id = $1') {
    const u = state.users.find((x) => Number(x.id) === Number(params[0]));
    return { rows: u ? [{ ...u, token_version: u.token_version || 0 }] : [] };
  }

  // authController checks
  if (sql === 'SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1') {
    const u = state.users.find((x) => x.email.toLowerCase() === String(params[0]).toLowerCase());
    return { rows: u ? [{ id: u.id }] : [] };
  }

  if (sql === 'SELECT id FROM users WHERE LOWER(username) = $1 LIMIT 1') {
    const u = state.users.find((x) => x.username.toLowerCase() === String(params[0]).toLowerCase());
    return { rows: u ? [{ id: u.id }] : [] };
  }

  if (sql === 'SELECT * FROM users WHERE email = $1') {
    const u = state.users.find((x) => x.email.toLowerCase() === String(params[0]).toLowerCase());
    return { rows: u ? [{ ...u }] : [] };
  }

  if (sql === 'SELECT * FROM users WHERE id = $1') {
    const u = state.users.find((x) => Number(x.id) === Number(params[0]));
    return { rows: u ? [{ ...u }] : [] };
  }

  if (sql === 'SELECT id FROM users WHERE email = $1') {
    const u = state.users.find((x) => x.email.toLowerCase() === String(params[0]).toLowerCase());
    return { rows: u ? [{ id: u.id }] : [] };
  }

  // Admin login
  if (sql === 'SELECT * FROM users WHERE (email = $1 OR username = $1) AND is_admin = true') {
    const target = String(params[0]).toLowerCase();
    const u = state.users.find(
      (x) => x.is_admin === true && (x.email.toLowerCase() === target || x.username.toLowerCase() === target)
    );
    return { rows: u ? [{ ...u }] : [] };
  }

  // OTP CRUD
  if (sql === 'DELETE FROM otps WHERE email = $1') {
    const em = String(params[0]).toLowerCase();
    state.otps = state.otps.filter((o) => o.email.toLowerCase() !== em);
    return { rows: [], rowCount: 1 };
  }

  if (sql.startsWith('INSERT INTO otps (email, otp_code, expires_at)')) {
    const row = {
      id: state.nextIds.otps++,
      email: String(params[0]).toLowerCase(),
      otp_code: String(params[1]),
      expires_at: new Date(params[2]),
      attempts: 0,
      verified_at: null,
      created_at: new Date(),
    };
    state.otps.push(row);
    return { rows: [row] };
  }

  if (sql.startsWith('SELECT * FROM otps WHERE email = $1 AND expires_at > NOW()')) {
    const em = String(params[0]).toLowerCase();
    const now = Date.now();
    const matches = state.otps
      .filter((o) => o.email.toLowerCase() === em && o.expires_at.getTime() > now)
      .sort((a, b) => b.created_at - a.created_at);
    return { rows: matches.length ? [{ ...matches[0] }] : [] };
  }

  if (sql.startsWith('SELECT id FROM otps WHERE email = $1 AND verified_at IS NOT NULL')) {
    const em = String(params[0]).toLowerCase();
    const cutoff = Date.now() - 30 * 60 * 1000;
    const matches = state.otps.filter(
      (o) => o.email.toLowerCase() === em && o.verified_at && o.verified_at.getTime() > cutoff
    );
    return { rows: matches.length ? [{ id: matches[0].id }] : [] };
  }

  if (sql.startsWith('UPDATE otps SET attempts = COALESCE(attempts, 0) + 1 WHERE id = $1')) {
    const otpRow = state.otps.find((o) => o.id === Number(params[0]));
    if (otpRow) otpRow.attempts = (otpRow.attempts || 0) + 1;
    return { rows: [], rowCount: otpRow ? 1 : 0 };
  }

  if (sql.startsWith('UPDATE otps SET verified_at = CURRENT_TIMESTAMP WHERE id = $1')) {
    const otpRow = state.otps.find((o) => o.id === Number(params[0]));
    if (otpRow) otpRow.verified_at = new Date();
    return { rows: [], rowCount: otpRow ? 1 : 0 };
  }

  // Register user
  if (sql.startsWith('INSERT INTO users (name, email, password_hash, username, gender, is_verified, token_version, accepted_terms_at, is_adult_confirmed)')) {
    const u = {
      id: state.nextIds.users++,
      name: params[0],
      email: params[1],
      password_hash: params[2],
      username: params[3],
      gender: params[4],
      bio: '',
      profile_picture: '',
      is_verified: true,
      is_admin: false,
      token_version: 0,
      accepted_terms_at: new Date(),
      is_adult_confirmed: true,
      created_at: new Date(),
      updated_at: new Date(),
    };
    state.users.push(u);
    return { rows: [{ ...u }] };
  }

  // Verify OTP user activation
  if (sql.startsWith('UPDATE users SET is_verified = TRUE WHERE email = $1')) {
    const em = String(params[0]).toLowerCase();
    const u = state.users.find((x) => x.email.toLowerCase() === em);
    if (!u) return { rows: [] };
    u.is_verified = true;
    return { rows: [{ ...u }] };
  }

  // Password reset / change bumping token_version
  if (sql.startsWith('UPDATE users SET password_hash = $1, token_version = COALESCE(token_version, 0) + 1') && sql.includes('WHERE email = $2')) {
    const em = String(params[1]).toLowerCase();
    const u = state.users.find((x) => x.email.toLowerCase() === em);
    if (u) {
      u.password_hash = params[0];
      u.token_version = (u.token_version || 0) + 1;
    }
    return { rows: [], rowCount: u ? 1 : 0 };
  }

  if (sql.startsWith('UPDATE users SET password_hash = $1, token_version = COALESCE(token_version, 0) + 1') && sql.includes('WHERE id = $2')) {
    const u = state.users.find((x) => Number(x.id) === Number(params[1]));
    if (!u) return { rows: [] };
    u.password_hash = params[0];
    u.token_version = (u.token_version || 0) + 1;
    return { rows: [{ id: u.id, email: u.email, token_version: u.token_version }] };
  }

  // Delete / web-delete account lookups
  if (sql === 'SELECT id, email, password_hash, profile_picture FROM users WHERE id = $1') {
    const u = state.users.find((x) => Number(x.id) === Number(params[0]));
    return { rows: u ? [{ ...u }] : [] };
  }

  if (sql === 'SELECT id, email, password_hash, profile_picture, COALESCE(is_admin, false) AS is_admin FROM users WHERE LOWER(email) = $1 LIMIT 1') {
    const em = String(params[0]).toLowerCase();
    const u = state.users.find((x) => x.email.toLowerCase() === em);
    return { rows: u ? [{ ...u }] : [] };
  }

  if (sql === 'SELECT image_url FROM posts WHERE user_id = $1') {
    return {
      rows: state.posts
        .filter((p) => Number(p.user_id) === Number(params[0]))
        .map((p) => ({ image_url: p.image_url })),
    };
  }

  if (sql === 'SELECT media_url FROM messages WHERE sender_id = $1') {
    return { rows: [] };
  }

  if (sql === 'DELETE FROM users WHERE id = $1 RETURNING id') {
    const idx = state.users.findIndex((x) => Number(x.id) === Number(params[0]));
    if (idx === -1) return { rows: [] };
    const [removed] = state.users.splice(idx, 1);
    return { rows: [{ id: removed.id }] };
  }

  if (sql === 'DELETE FROM users WHERE id = $1 AND is_admin = false') {
    state.users = state.users.filter((x) => !(Number(x.id) === Number(params[0]) && !x.is_admin));
    return { rows: [] };
  }

  if (sql === 'DELETE FROM posts WHERE id = $1') {
    state.posts = state.posts.filter((p) => Number(p.id) !== Number(params[0]));
    return { rows: [] };
  }

  if (sql.startsWith('DELETE FROM ')) {
    if (sql.startsWith('DELETE FROM posts WHERE user_id = $1')) {
      state.posts = state.posts.filter((p) => Number(p.user_id) !== Number(params[0]));
    }
    return { rows: [], rowCount: 0 };
  }

  // Export data queries
  if (sql.includes('FROM users WHERE id = $1') && sql.includes('allow_tags_from')) {
    const u = state.users.find((x) => Number(x.id) === Number(params[0]));
    if (!u) return { rows: [] };
    return {
      rows: [{
        id: u.id,
        name: u.name,
        email: u.email,
        username: u.username,
        pronouns: '',
        gender: u.gender || '',
        bio: u.bio || '',
        profile_picture: u.profile_picture || '',
        is_verified: u.is_verified,
        points: 120,
        current_level: 2,
        allow_tags_from: 'everyone',
        allow_mentions_from: 'everyone',
        manually_approve_tags: false,
        created_at: u.created_at,
        updated_at: u.updated_at,
      }],
    };
  }

  if (sql.includes('FROM posts WHERE user_id = $1')) {
    return { rows: state.posts.filter((p) => Number(p.user_id) === Number(params[0])) };
  }
  if (sql.includes('FROM post_comments WHERE user_id = $1')) return { rows: state.comments };
  if (sql.includes('FROM post_bookmarks WHERE user_id = $1')) return { rows: state.bookmarks };
  if (sql.includes('FROM user_follows uf')) return { rows: state.follows };
  if (sql.includes('FROM user_blocks ub')) return { rows: state.blocks };
  if (sql.includes('FROM point_transactions WHERE user_id = $1')) return { rows: state.pointTransactions };
  if (sql.includes('FROM notifications WHERE user_id = $1')) return { rows: state.notifications };
  if (sql.includes('FROM content_reports WHERE reporter_id = $1')) {
    return { rows: state.reports.filter((r) => Number(r.reporter_id) === Number(params[0])) };
  }

  // Reports
  if (sql === 'SELECT user_id FROM posts WHERE id = $1 LIMIT 1') {
    const p = state.posts.find((x) => Number(x.id) === Number(params[0]));
    return { rows: p ? [{ user_id: p.user_id }] : [] };
  }

  if (sql.startsWith('SELECT id FROM content_reports WHERE reporter_id = $1')) {
    const cutoff = Date.now() - 15 * 60 * 1000;
    const match = state.reports.find(
      (r) =>
        Number(r.reporter_id) === Number(params[0]) &&
        r.target_type.toLowerCase() === String(params[1]).toLowerCase() &&
        Number(r.target_id || 0) === Number(params[2] || 0) &&
        r.reason === params[3] &&
        r.created_at.getTime() > cutoff
    );
    return { rows: match ? [{ id: match.id }] : [] };
  }

  if (sql.startsWith('INSERT INTO content_reports')) {
    const r = {
      id: state.nextIds.reports++,
      reporter_id: params[0],
      target_type: params[1],
      target_id: params[2],
      reported_user_id: params[3],
      target_name: params[4],
      reason: params[5],
      details: params[6],
      status: 'pending',
      admin_note: '',
      reviewed_by: null,
      reviewed_at: null,
      created_at: new Date(),
    };
    state.reports.push(r);
    return { rows: [{ id: r.id, status: r.status, created_at: r.created_at }] };
  }

  if (sql.includes('FROM content_reports r')) {
    return {
      rows: state.reports.map((r) => ({
        ...r,
        reporter_username: state.users.find((u) => u.id === r.reporter_id)?.username || null,
        reported_username: state.users.find((u) => u.id === r.reported_user_id)?.username || null,
      })),
    };
  }

  if (sql === 'SELECT * FROM content_reports WHERE id = $1') {
    const r = state.reports.find((x) => Number(x.id) === Number(params[0]));
    return { rows: r ? [{ ...r }] : [] };
  }

  if (sql.startsWith('UPDATE content_reports SET status = $1')) {
    const r = state.reports.find((x) => Number(x.id) === Number(params[3]));
    if (!r) return { rows: [] };
    r.status = params[0];
    if (params[1] !== null) r.admin_note = params[1];
    r.reviewed_by = params[2];
    r.reviewed_at = new Date();
    return { rows: [{ ...r }] };
  }

  throw new Error(`Unhandled SQL in security_compliance.test.js mockQuery: ${sql}`);
}

// Install mock db BEFORE loading server.js
db.query = mockQuery;
db.pool.connect = async () => ({
  query: mockQuery,
  release: () => {},
});
db.pool.end = async () => {};

const { app } = require('../src/server');

let ipCounter = 10;
function nextIp() {
  ipCounter += 1;
  return `10.99.0.${ipCounter}`;
}

function invokeApp({ path, method = 'GET', body, token, origin, ip = nextIp(), headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = new PassThrough();
    const normalizedHeaders = {
      'x-forwarded-for': ip,
    };
    for (const [k, v] of Object.entries(headers)) {
      normalizedHeaders[k.toLowerCase()] = v;
    }
    if (body !== undefined) {
      normalizedHeaders['content-type'] = 'application/json';
    }
    if (token) {
      normalizedHeaders['authorization'] = `Bearer ${token}`;
    }
    if (origin) {
      normalizedHeaders['origin'] = origin;
    }

    const payloadBuf = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    if (payloadBuf) {
      normalizedHeaders['content-length'] = String(payloadBuf.length);
    }

    req.method = method;
    req.url = path;
    req.originalUrl = path;
    req.httpVersion = '1.1';
    req.httpVersionMajor = 1;
    req.httpVersionMinor = 1;
    req.headers = normalizedHeaders;
    req.connection = { remoteAddress: ip, encrypted: false };
    req.socket = req.connection;

    const res = new EventEmitter();
    const headerStore = new Map();
    const chunks = [];
    let resolved = false;

    res.statusCode = 200;
    res.statusMessage = 'OK';
    res.headersSent = false;
    res.writableEnded = false;
    res.locals = {};

    res.setHeader = (name, value) => {
      headerStore.set(String(name).toLowerCase(), value);
      return res;
    };
    res.header = res.setHeader;
    res.appendHeader = (name, value) => {
      const k = String(name).toLowerCase();
      const prev = headerStore.get(k);
      if (prev === undefined) {
        headerStore.set(k, value);
      } else {
        const arr = Array.isArray(prev) ? prev.concat(value) : [prev].concat(value);
        headerStore.set(k, arr);
      }
      return res;
    };
    res.getHeader = (name) => headerStore.get(String(name).toLowerCase());
    res.hasHeader = (name) => headerStore.has(String(name).toLowerCase());
    res.removeHeader = (name) => {
      headerStore.delete(String(name).toLowerCase());
    };
    res.getHeaderNames = () => Array.from(headerStore.keys());
    res.getHeaders = () => Object.fromEntries(headerStore.entries());
    res.writeHead = (code, reasonOrHeaders, maybeHeaders) => {
      res.statusCode = code;
      const hdrs = typeof reasonOrHeaders === 'object' ? reasonOrHeaders : maybeHeaders;
      if (hdrs) {
        for (const [k, v] of Object.entries(hdrs)) {
          res.setHeader(k, v);
        }
      }
      res.headersSent = true;
      return res;
    };
    res.flushHeaders = () => {
      res.headersSent = true;
    };
    res._implicitHeader = () => {
      res.headersSent = true;
    };
    res.cork = () => {};
    res.uncork = () => {};

    const finalize = () => {
      if (resolved) return;
      resolved = true;
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (_) {}
      resolve({
        status: res.statusCode,
        headers: {
          get: (name) => {
            const v = headerStore.get(String(name).toLowerCase());
            if (Array.isArray(v)) return v.join(', ');
            return v === undefined ? null : String(v);
          },
        },
        text,
        json,
      });
    };

    res.write = (chunk, encoding, cb) => {
      res.headersSent = true;
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8'));
      }
      if (typeof encoding === 'function') encoding();
      if (typeof cb === 'function') cb();
      return true;
    };

    res.end = (chunk, encoding, cb) => {
      res.headersSent = true;
      if (typeof chunk === 'function') {
        cb = chunk;
        chunk = null;
      } else if (typeof encoding === 'function') {
        cb = encoding;
        encoding = undefined;
      }
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8'));
      }
      res.writableEnded = true;
      res.emit('finish');
      if (typeof cb === 'function') cb();
      finalize();
      return res;
    };

    if (payloadBuf) {
      req.push(payloadBuf);
    }
    req.push(null);

    app.handle(req, res, (err) => {
      if (err) return reject(err);
      if (!res.writableEnded) {
        res.statusCode = 404;
        res.end('');
      }
    });
  });
}

async function api(path, opts = {}) {
  return invokeApp({ path, ...opts });
}

test('1. Security headers & CORS reject insecure origins and unsafe-eval', async () => {
  const resAllowed = await api('/privacy-policy', { origin: 'https://hidely.app' });
  assert.equal(resAllowed.status, 200);
  assert.equal(resAllowed.headers.get('access-control-allow-origin'), 'https://hidely.app');
  assert.equal(resAllowed.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(resAllowed.headers.get('x-powered-by'), null);

  const csp = resAllowed.headers.get('content-security-policy') || '';
  assert.equal(csp.includes("'unsafe-eval'"), false);
  assert.equal(csp.includes("object-src 'none'"), true);
  assert.equal(csp.includes("frame-ancestors 'self'"), true);
  assert.equal((resAllowed.headers.get('permissions-policy') || '').includes('payment=()'), true);

  const resInsecureOrigin = await api('/privacy-policy', { origin: 'http://hidely.kittuvirusstudio.in' });
  assert.equal(resInsecureOrigin.status, 403);

  const resEvilOrigin = await api('/privacy-policy', { origin: 'https://evil-attacker.example' });
  assert.equal(resEvilOrigin.status, 403);
});

test('2. Public Google Play & DPDP legal HTML routes render required compliance disclosures', async () => {
  const delPage = await api('/delete-account');
  assert.equal(delPage.status, 200);
  assert.match(delPage.text, /\/api\/users\/web-delete-account/);
  assert.match(delPage.text, /support@hidely\.app/);
  assert.match(delPage.text, /grievance@hidely\.app/);

  const privPage = await api('/privacy-policy');
  assert.equal(privPage.status, 200);
  assert.match(privPage.text, /Digital Personal Data Protection Act, 2023/);
  assert.match(privPage.text, /grievance@hidely\.app/);
  assert.match(privPage.text, /\/delete-account/);
  assert.match(privPage.text, /\/child-safety/);

  const termsPage = await api('/terms');
  assert.equal(termsPage.status, 200);
  assert.match(termsPage.text, /18 years old/);
  assert.match(termsPage.text, /non-monetary/i);
  assert.match(termsPage.text, /grievance@hidely\.app/);

  const childPage = await api('/child-safety');
  assert.equal(childPage.status, 200);
  assert.match(childPage.text, /CSAE/i);
  assert.match(childPage.text, /24 hours/i);
  assert.match(childPage.text, /grievance@hidely\.app/);
});

test('3. OTP signup never leaks dev_otp, enforces 5-attempt lockout, requires verified email, and never deletes existing accounts', async () => {
  resetState();

  const existingHash = await bcrypt.hash('ExistingPass123!', 10);
  state.users.push({
    id: state.nextIds.users++,
    name: 'Existing Unverified',
    email: 'existing@example.com',
    password_hash: existingHash,
    username: 'existing_user',
    is_verified: false,
    is_admin: false,
    token_version: 0,
    created_at: new Date(),
  });

  // Send OTP -> must NEVER return dev_otp when ALLOW_DEV_OTP != 'true'
  const sendRes = await api('/api/auth/send-email-otp', {
    method: 'POST',
    body: { email: 'newuser@example.com' },
  });
  assert.equal(sendRes.status, 200);
  assert.equal(sendRes.json.dev_otp, undefined);
  assert.equal(state.otps.length, 1);
  const actualOtp = state.otps[0].otp_code;
  assert.match(actualOtp, /^\d{4}$/);

  // Attempting registration BEFORE verifying email OTP must fail closed
  const regBeforeVerify = await api('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'New User',
      email: 'newuser@example.com',
      username: 'new_user_1',
      password: 'StrongPassword123',
      age_confirmed: true,
      terms_accepted: true,
    },
  });
  assert.equal(regBeforeVerify.status, 400);
  assert.match(regBeforeVerify.json.error, /Email verification required/i);

  // Brute force wrong OTP 5 times -> 6th attempt locked out with 429
  const wrongOtp = actualOtp === '1111' ? '2222' : '1111';
  const attackerIp = nextIp();
  for (let i = 0; i < 5; i++) {
    const badRes = await api('/api/auth/verify-email-otp', {
      method: 'POST',
      ip: attackerIp,
      body: { email: 'newuser@example.com', otp: wrongOtp },
    });
    assert.equal(badRes.status, 400);
  }
  const lockedRes = await api('/api/auth/verify-email-otp', {
    method: 'POST',
    ip: attackerIp,
    body: { email: 'newuser@example.com', otp: actualOtp },
  });
  assert.equal(lockedRes.status, 429);

  // Request fresh OTP, verify legitimately
  const resendRes = await api('/api/auth/send-email-otp', {
    method: 'POST',
    body: { email: 'newuser@example.com' },
  });
  assert.equal(resendRes.status, 200);
  const freshOtp = state.otps[0].otp_code;

  const verifyOk = await api('/api/auth/verify-email-otp', {
    method: 'POST',
    body: { email: 'newuser@example.com', otp: freshOtp },
  });
  assert.equal(verifyOk.status, 200);
  assert.ok(state.otps[0].verified_at instanceof Date);

  // Weak password rejected (< 8 chars)
  const weakReg = await api('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'New User',
      email: 'newuser@example.com',
      username: 'new_user_1',
      password: 'short',
      age_confirmed: true,
      terms_accepted: true,
    },
  });
  assert.equal(weakReg.status, 400);

  // Under-18 / terms declined rejected
  const minorReg = await api('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Minor User',
      email: 'newuser@example.com',
      username: 'new_user_1',
      password: 'StrongPassword123',
      age_confirmed: false,
      terms_accepted: true,
    },
  });
  assert.equal(minorReg.status, 400);

  // Complete registration validly
  const okReg = await api('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'New User',
      email: 'newuser@example.com',
      username: 'new_user_1',
      password: 'StrongPassword123',
      age_confirmed: true,
      terms_accepted: true,
    },
  });
  assert.equal(okReg.status, 201);
  assert.ok(okReg.json.token);

  // Attempt to hijack existing unverified email with register -> blocked cleanly, account preserved!
  state.otps.push({
    id: state.nextIds.otps++,
    email: 'existing@example.com',
    otp_code: '9999',
    expires_at: new Date(Date.now() + 60000),
    attempts: 0,
    verified_at: new Date(),
    created_at: new Date(),
  });
  const collisionReg = await api('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Attacker',
      email: 'existing@example.com',
      username: 'hijacker',
      password: 'StrongPassword123',
      age_confirmed: true,
      terms_accepted: true,
    },
  });
  assert.equal(collisionReg.status, 400);
  assert.equal(state.users.some((u) => u.email === 'existing@example.com' && u.name === 'Existing Unverified'), true);
});

test('4. Rate limiter blocks burst registration from the same IP', async () => {
  const ip = nextIp();
  for (let i = 0; i < 5; i++) {
    const res = await api('/api/auth/register', {
      method: 'POST',
      ip,
      body: { name: 'A', email: `a${i}@example.com`, username: `user_${i}`, password: 'StrongPassword123' },
    });
    assert.equal(res.status, 400);
  }
  const blocked = await api('/api/auth/register', {
    method: 'POST',
    ip,
    body: { name: 'A', email: 'a5@example.com', username: 'user_5', password: 'StrongPassword123' },
  });
  assert.equal(blocked.status, 429);
});

test('5. Session revocation via token_version invalidates prior JWTs on changePassword and resetPassword', async () => {
  resetState();
  const hash = await bcrypt.hash('OldPassword123!', 10);
  const user = {
    id: state.nextIds.users++,
    name: 'Session User',
    email: 'session@example.com',
    username: 'session_user',
    password_hash: hash,
    is_verified: true,
    is_admin: false,
    token_version: 0,
    created_at: new Date(),
    updated_at: new Date(),
  };
  state.users.push(user);

  const oldToken = jwt.sign({ id: user.id, email: user.email, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '1d' });
  const legacyNoTvToken = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '1d' });

  // Prior to password change, old token works on /api/users/data-export
  const beforeExport = await api('/api/users/data-export', { token: oldToken });
  assert.equal(beforeExport.status, 200);

  // Change password -> issues rotated token and increments token_version
  const changeRes = await api('/api/auth/change-password', {
    method: 'POST',
    token: oldToken,
    body: { oldPassword: 'OldPassword123!', newPassword: 'NewPassword456!' },
  });
  assert.equal(changeRes.status, 200);
  const rotatedToken = changeRes.json.token;
  assert.ok(rotatedToken && rotatedToken !== oldToken);

  // Old token AND legacy token without tv are now rejected with 401
  const rejectedOld = await api('/api/users/data-export', { token: oldToken });
  assert.equal(rejectedOld.status, 401);

  const rejectedLegacy = await api('/api/users/data-export', { token: legacyNoTvToken });
  assert.equal(rejectedLegacy.status, 401);

  // Rotated token works cleanly
  const okRotated = await api('/api/users/data-export', { token: rotatedToken });
  assert.equal(okRotated.status, 200);

  // Forgot/Reset password also invalidates rotatedToken
  const forgotRes = await api('/api/auth/forgot-password', {
    method: 'POST',
    body: { email: user.email },
  });
  assert.equal(forgotRes.status, 200);
  const resetOtp = state.otps[0].otp_code;

  const resetRes = await api('/api/auth/reset-password', {
    method: 'POST',
    body: { email: user.email, otp: resetOtp, newPassword: 'FinalPassword789!' },
  });
  assert.equal(resetRes.status, 200);

  const rejectedAfterReset = await api('/api/users/data-export', { token: rotatedToken });
  assert.equal(rejectedAfterReset.status, 401);
});

test('6. DPDP Data Export omits password_hash and Account Deletion permanently removes user via app & web endpoints', async () => {
  resetState();
  const hash1 = await bcrypt.hash('DeleteMePass123', 10);
  const hash2 = await bcrypt.hash('WebDeletePass123', 10);

  const user1 = {
    id: state.nextIds.users++,
    name: 'App Delete',
    email: 'appdel@example.com',
    username: 'app_del',
    password_hash: hash1,
    profile_picture: '',
    is_verified: true,
    is_admin: false,
    token_version: 0,
    created_at: new Date(),
    updated_at: new Date(),
  };
  const user2 = {
    id: state.nextIds.users++,
    name: 'Web Delete',
    email: 'webdel@example.com',
    username: 'web_del',
    password_hash: hash2,
    profile_picture: '',
    is_verified: true,
    is_admin: false,
    token_version: 0,
    created_at: new Date(),
    updated_at: new Date(),
  };
  state.users.push(user1, user2);

  const token1 = jwt.sign({ id: user1.id, email: user1.email, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '1d' });

  const exportRes = await api('/api/users/data-export', { token: token1 });
  assert.equal(exportRes.status, 200);
  assert.equal(exportRes.json.success, true);
  assert.equal(exportRes.json.data.profile.email, 'appdel@example.com');
  assert.equal(exportRes.json.data.profile.password_hash, undefined);
  assert.equal(exportRes.text.includes(hash1), false);

  // Wrong password cannot delete account
  const badDel = await api('/api/users/account', {
    method: 'DELETE',
    token: token1,
    body: { password: 'WrongPassword!' },
  });
  assert.equal(badDel.status, 401);

  // Right password deletes user1 cleanly, invalidating token1 immediately
  const okDel = await api('/api/users/account', {
    method: 'DELETE',
    token: token1,
    body: { password: 'DeleteMePass123' },
  });
  assert.equal(okDel.status, 200);
  assert.equal(state.users.some((u) => u.id === user1.id), false);

  const afterDelExport = await api('/api/users/data-export', { token: token1 });
  assert.equal(afterDelExport.status, 401);

  // Web delete requires explicit DELETE confirmation & password
  const webMissingConfirm = await api('/api/users/web-delete-account', {
    method: 'POST',
    body: { email: user2.email, password: 'WebDeletePass123', confirm: 'NOPE' },
  });
  assert.equal(webMissingConfirm.status, 400);

  const webOk = await api('/api/users/web-delete-account', {
    method: 'POST',
    body: { email: user2.email, password: 'WebDeletePass123', confirm: 'DELETE' },
  });
  assert.equal(webOk.status, 200);
  assert.equal(state.users.some((u) => u.id === user2.id), false);
});

test('7. Content reporting, Admin RBAC / int validation, and CSAE moderation workflow work end-to-end', async () => {
  resetState();
  const adminHash = await bcrypt.hash('AdminSecret123!', 10);
  const adminUser = {
    id: state.nextIds.users++,
    name: 'Admin',
    email: 'admin@hidely.app',
    username: 'admin_user',
    password_hash: adminHash,
    is_verified: true,
    is_admin: true,
    token_version: 0,
    created_at: new Date(),
  };
  const regularUser = {
    id: state.nextIds.users++,
    name: 'Reporter',
    email: 'reporter@example.com',
    username: 'reporter_user',
    password_hash: adminHash,
    is_verified: true,
    is_admin: false,
    token_version: 0,
    created_at: new Date(),
  };
  const badActor = {
    id: state.nextIds.users++,
    name: 'Bad Actor',
    email: 'bad@example.com',
    username: 'bad_actor',
    password_hash: adminHash,
    is_verified: true,
    is_admin: false,
    token_version: 0,
    created_at: new Date(),
  };
  state.users.push(adminUser, regularUser, badActor);
  state.posts.push({ id: 42, user_id: badActor.id, caption: 'Offensive', image_url: '' });

  const regularToken = jwt.sign({ id: regularUser.id, email: regularUser.email, tv: 0 }, process.env.JWT_SECRET);

  // Unauthenticated report rejected
  const unauthReport = await api('/api/reports', {
    method: 'POST',
    body: { targetType: 'Post', targetId: 42, reason: 'Child Safety / CSAE' },
  });
  assert.equal(unauthReport.status, 401);

  // Valid report created cleanly
  const createdReport = await api('/api/reports', {
    method: 'POST',
    token: regularToken,
    body: {
      targetType: 'Post',
      targetId: 42,
      targetUsername: 'bad_actor',
      reason: 'Child Safety / CSAE',
      details: 'Urgent moderation needed',
    },
  });
  assert.equal(createdReport.status, 201);
  assert.equal(createdReport.json.success, true);
  assert.equal(state.reports[0].reported_user_id, badActor.id);

  // Duplicate report within 15 minutes returns idempotent 200 duplicate without flooding
  const dupReport = await api('/api/reports', {
    method: 'POST',
    token: regularToken,
    body: {
      targetType: 'Post',
      targetId: 42,
      targetUsername: 'bad_actor',
      reason: 'Child Safety / CSAE',
    },
  });
  assert.equal(dupReport.status, 200);
  assert.equal(dupReport.json.duplicate, true);
  assert.equal(state.reports.length, 1);

  // Non-admin blocked from /api/admin/reports
  const nonAdminQueue = await api('/api/admin/reports', { token: regularToken });
  assert.equal(nonAdminQueue.status, 403);

  // Admin login issues token and fetches reports queue
  const adminLogin = await api('/api/admin/login', {
    method: 'POST',
    body: { email: 'admin@hidely.app', password: 'AdminSecret123!' },
  });
  assert.equal(adminLogin.status, 200);
  const adminToken = adminLogin.json.token;

  const queueRes = await api('/api/admin/reports', { token: adminToken });
  assert.equal(queueRes.status, 200);
  assert.equal(queueRes.json.reports.length, 1);

  // Malformed :id parameter rejected with 400
  const badParamRes = await api('/api/admin/reports/not-an-int', {
    method: 'PATCH',
    token: adminToken,
    body: { action: 'dismiss' },
  });
  assert.equal(badParamRes.status, 400);

  // Admin takes down reported post
  const takedownRes = await api(`/api/admin/reports/${createdReport.json.reportId}`, {
    method: 'PATCH',
    token: adminToken,
    body: { action: 'remove_content', adminNote: 'Removed under zero-tolerance safety policy' },
  });
  assert.equal(takedownRes.status, 200);
  assert.equal(takedownRes.json.report.status, 'action_taken');
  assert.equal(state.posts.some((p) => p.id === 42), false);
});

test('8. Upload fileFilter enforces strict extension AND MIME checks (blocks spoofed files, allows valid mobile media)', async () => {
  const runFilter = (originalname, mimetype) =>
    new Promise((resolve) => {
      upload.fileFilter({}, { originalname, mimetype }, (err, accepted) => {
        resolve({ err, accepted: Boolean(accepted) });
      });
    });

  assert.equal((await runFilter('exploit.html', 'text/html')).accepted, false);
  assert.equal((await runFilter('spoof.jpg', 'text/html')).accepted, false);
  assert.equal((await runFilter('shell.php', 'image/jpeg')).accepted, false);
  assert.equal((await runFilter('payload.exe', 'application/octet-stream')).accepted, false);
  assert.equal((await runFilter('photo.jpg', 'image/jpeg')).accepted, true);
  assert.equal((await runFilter('camera.heic', 'application/octet-stream')).accepted, true);
  assert.equal((await runFilter('clip.mp4', 'video/mp4')).accepted, true);
});

test('9. Map proxy gracefully falls back when Google key is unset and validates photo_reference & coords', async () => {
  const nearby = await api('/api/map/places/nearby?location=28.6139,77.2090');
  assert.equal(nearby.status, 200);
  assert.equal(nearby.json.status, 'ZERO_RESULTS');

  const dirs = await api('/api/map/directions?origin=28.61,77.20&destination=28.70,77.10');
  assert.equal(dirs.status, 200);
  assert.equal(dirs.json.status, 'ZERO_RESULTS');

  const badPhoto = await api('/api/map/photo?photo_reference=bad/../../etc/passwd');
  assert.equal(badPhoto.status, 400);

  const missingKeyPhoto = await api('/api/map/photo?photo_reference=ValidLookingPhotoRef12345');
  assert.equal(missingKeyPhoto.status, 404);

  const nullIsland = await api('/api/map/reverse-geocode?lat=0&lng=0');
  assert.equal(nullIsland.status, 400);
});
