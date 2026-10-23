import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import express from 'express';
import mongoose from 'mongoose';
import { app } from '../src/app.js';
import { User } from '../src/models/user.model.js';
import { authenticate } from '../src/middleware/authenticate.js';
import { requireRole } from '../src/middleware/requireRole.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { authLimiter } from '../src/routes/auth.routes.js';
import { registerSchema, loginSchema, profileSchema } from '../src/utils/userSchemas.js';

const config = {
  JWT_SECRET: 'task3-test-only-secret-at-least-32-characters',
  JWT_EXPIRES_IN: '1h', BCRYPT_COST: 4,
};
const credentials = { name: ' Ada ', email: ' ADA@Example.com ', password: ' secret pass ' };

async function listen(t, application) {
  const server = application.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('auth validation strips protected keys and enforces byte and normalized-interest limits', () => {
  const parsed = registerSchema.parse({ ...credentials, role: 'admin', passwordHash: 'injected', interests: Array(21).fill(' SAME ') });
  assert.equal(parsed.name, 'Ada');
  assert.equal(parsed.email, 'ada@example.com');
  assert.equal(parsed.password, credentials.password);
  assert.equal(parsed.role, undefined);
  assert.equal(parsed.passwordHash, undefined);
  assert.deepEqual(registerSchema.parse(credentials).interests, []);
  for (const password of ['x'.repeat(72), 'ক'.repeat(24)]) {
    assert.equal(loginSchema.safeParse({ email: 'ada@example.com', password }).success, true);
  }
  for (const changes of [
    { name: ' ' }, { name: 5 }, { name: '😀'.repeat(51) }, { email: 'bad' },
    { email: { $ne: null } }, { password: 'short' }, { password: 12345678 },
    { password: 'x'.repeat(73) }, { password: 'ক'.repeat(24) + 'x' },
    { interests: 'music' }, { interests: [null] }, { interests: ['music', 7] },
    { interests: Array.from({ length: 21 }, (_, index) => `tag-${index}`) },
  ]) assert.equal(registerSchema.safeParse({ ...credentials, ...changes }).success, false);
  for (const body of [{}, { role: 'admin' }, { password: 'new-secret' }, { name: null }, { interests: null }]) {
    assert.equal(profileSchema.safeParse(body).success, false);
  }
  assert.deepEqual(profileSchema.parse({ name: ' New ', role: 'admin' }), { name: 'New' });
});

test('real authentication, profile permissions, duplicate races and limiter', {
  skip: !process.env.TEST_MONGODB_URI, timeout: 60000,
}, async (t) => {
  const uri = new URL(process.env.TEST_MONGODB_URI);
  if (uri.hostname !== '127.0.0.1' || uri.pathname !== '/secure_notes_models_test') {
    throw new Error('Auth tests require the dedicated local test database URI');
  }
  uri.pathname = '/secure_notes_auth_test';
  await mongoose.connect(uri.href, { serverSelectionTimeoutMS: 5000, bufferCommands: false });
  const emails = new Set();
  t.after(async () => {
    try { await User.deleteMany({ email: { $in: [...emails] } }); }
    finally { await mongoose.disconnect(); }
  });
  await User.syncIndexes();
  app.locals.config = config;
  const origin = await listen(t, app);
  async function request(path, { method = 'GET', body, token } = {}) {
    const response = await fetch(`${origin}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  let sequence = 0;
  const newEmail = () => {
    const email = `task3-${new mongoose.Types.ObjectId()}-${sequence++}@example.com`;
    emails.add(email);
    return email;
  };
  const resetLimit = () => authLimiter.resetKey('127.0.0.1');
  const email = newEmail();
  let userId;
  let token;

  await t.test('register hashes only the validated password and ignores role escalation', async () => {
    resetLimit();
    const response = await request('/api/auth/register', {
      method: 'POST', body: { ...credentials, email: ` ${email.toUpperCase()} `, role: 'admin', interests: [' Music ', 'music', ''] },
    });
    assert.equal(response.status, 201);
    assert.deepEqual(Object.keys(response.body.data).sort(), ['_id', 'name', 'email', 'role', 'interests', 'createdAt', 'updatedAt'].sort());
    assert.equal(response.body.data.role, 'user');
    assert.deepEqual(response.body.data.interests, ['music']);
    userId = response.body.data._id;
    const saved = await User.findById(userId).select('+passwordHash').lean();
    assert.notEqual(saved.passwordHash, credentials.password);
    assert.equal(bcrypt.getRounds(saved.passwordHash), config.BCRYPT_COST);
    assert.equal(await bcrypt.compare(credentials.password, saved.passwordHash), true);
    assert.equal(await bcrypt.compare(credentials.password.trim(), saved.passwordHash), false);
    const duplicate = await request('/api/auth/register', { method: 'POST', body: { ...credentials, email } });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(duplicate.body, { error: { message: 'Email already registered' } });
    assert.ok(!JSON.stringify(response.body).includes('passwordHash'));
  });

  await t.test('login is uniform for incorrect credentials and issues short HS256 identity tokens', async () => {
    resetLimit();
    const wrong = await request('/api/auth/login', { method: 'POST', body: { email, password: 'wrong-password' } });
    const unknown = await request('/api/auth/login', { method: 'POST', body: { email: newEmail(), password: 'wrong-password' } });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
    assert.deepEqual(wrong.body, { error: { message: 'Invalid credentials' } });
    const response = await request('/api/auth/login', { method: 'POST', body: { email: ` ${email.toUpperCase()} `, password: credentials.password } });
    assert.equal(response.status, 200);
    token = response.body.token;
    const decoded = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'], complete: true });
    assert.equal(decoded.header.alg, 'HS256');
    assert.deepEqual(Object.keys(decoded.payload).sort(), ['exp', 'iat', 'sub']);
    assert.equal(decoded.payload.sub, userId);
    assert.equal(decoded.payload.exp - decoded.payload.iat, 3600);
    assert.ok(!JSON.stringify(response.body).includes('passwordHash'));
  });

  await t.test('profile is private, updates only name/interests and preserves credentials and role', async () => {
    assert.equal((await request('/api/me')).status, 401);
    const response = await request('/api/me', { token });
    assert.equal(response.status, 200);
    assert.equal(response.body.data._id, userId);
    assert.equal(response.body.data.__v, undefined);
    const before = await User.findById(userId).select('+passwordHash').lean();
    const changed = await request('/api/me', { method: 'PATCH', token, body: {
      name: ' Grace ', interests: [' CODE ', 'code', ''], role: 'admin', email: 'attacker@example.com', passwordHash: 'attack',
    } });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.data.name, 'Grace');
    assert.deepEqual(changed.body.data.interests, ['code']);
    assert.equal(changed.body.data.role, 'user');
    assert.equal(changed.body.data.email, email);
    const after = await User.findById(userId).select('+passwordHash').lean();
    assert.equal(after.passwordHash, before.passwordHash);
    assert.ok(after.updatedAt >= before.updatedAt);
    for (const body of [{}, { role: 'admin' }, { name: 7 }, { interests: ['music', {}] }]) {
      assert.equal((await request('/api/me', { method: 'PATCH', token, body })).status, 400);
    }
  });

  await t.test('invalid signatures, algorithms, expiry, activation and subjects receive 401', async () => {
    const sign = (payload, options = {}) => jwt.sign(payload, config.JWT_SECRET, { algorithm: 'HS256', ...options });
    for (const badToken of [
      'invalid', jwt.sign({ sub: userId }, 'wrong-secret', { expiresIn: '1h' }),
      sign({ sub: userId }, { expiresIn: -1 }), sign({ sub: userId }, { expiresIn: '1h', notBefore: '1h' }),
      sign({ sub: userId }, { algorithm: 'HS384', expiresIn: '1h' }),
      sign({ sub: userId }, { algorithm: 'none', expiresIn: '1h' }),
      sign({ sub: 'not-an-id' }, { expiresIn: '1h' }), sign({ sub: userId }),
      sign({ sub: `${userId}\n` }, { expiresIn: '1h' }),
      sign({ sub: [userId] }, { expiresIn: '1h' }),
    ]) {
      const response = await request('/api/me', { token: badToken });
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, { error: { message: 'Missing or invalid token' } });
    }
    for (const authorization of ['Basic x', 'Bearer', `Bearer ${token} extra`]) {
      const response = await fetch(`${origin}/api/me`, { headers: { authorization } });
      assert.equal(response.status, 401);
    }
  });

  await t.test('middleware reloads roles; database failures stay 500; deleted accounts lose access', async () => {
    const fixture = express();
    fixture.locals.config = config;
    fixture.get('/admin', authenticate, requireRole('admin'), (_req, res) => res.json({ allowed: true }));
    fixture.use(errorHandler);
    const roleOrigin = await listen(t, fixture);
    const check = () => fetch(`${roleOrigin}/admin`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await check()).status, 403);
    await User.updateOne({ _id: userId }, { $set: { role: 'admin' } });
    assert.equal((await check()).status, 200);
    await User.updateOne({ _id: userId }, { $set: { role: 'user' } });
    assert.equal((await check()).status, 403);
    const failure = t.mock.method(User, 'findById', () => { throw new Error('private-database-detail'); });
    try {
      const response = await request('/api/me', { token });
      assert.equal(response.status, 500);
      assert.deepEqual(response.body, { error: { message: 'Internal server error' } });
    } finally { failure.mock.restore(); }
    const removedDuringUpdate = t.mock.method(User, 'findOneAndUpdate', () => ({ lean: async () => null }));
    try {
      assert.equal((await request('/api/me', { token, method: 'PATCH', body: { name: 'Gone' } })).status, 401);
    } finally { removedDuringUpdate.mock.restore(); }
    await User.deleteOne({ _id: userId });
    assert.equal((await request('/api/me', { token })).status, 401);
  });

  await t.test('72-byte passwords round-trip and 73-byte candidates never reach bcrypt', async () => {
    for (const password of ['x'.repeat(72), 'ক'.repeat(24)]) {
      resetLimit();
      const boundaryEmail = newEmail();
      assert.equal((await request('/api/auth/register', { method: 'POST', body: { ...credentials, email: boundaryEmail, password } })).status, 201);
      assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: boundaryEmail, password } })).status, 200);
    }
    resetLimit();
    const hashing = t.mock.method(bcrypt, 'hash', () => { throw new Error('Must not hash invalid inputs'); });
    const comparing = t.mock.method(bcrypt, 'compare', () => { throw new Error('Must not compare invalid inputs'); });
    try {
      for (const password of ['x'.repeat(73), 'ক'.repeat(24) + 'x']) {
        for (const path of ['/api/auth/register', '/api/auth/login']) {
          const response = await request(path, { method: 'POST', body: { ...credentials, email: newEmail(), password } });
          assert.equal(response.status, 400);
        }
      }
      assert.equal(hashing.mock.callCount(), 0);
      assert.equal(comparing.mock.callCount(), 0);
    } finally { hashing.mock.restore(); comparing.mock.restore(); }
  });

  await t.test('concurrent normalized-email registration creates exactly one account', async () => {
    resetLimit();
    const duplicateEmail = newEmail();
    const results = await Promise.all([duplicateEmail, ` ${duplicateEmail.toUpperCase()} `].map((email) =>
      request('/api/auth/register', { method: 'POST', body: { ...credentials, email } })));
    assert.deepEqual(results.map(({ status }) => status).sort(), [201, 409]);
    assert.equal(await User.countDocuments({ email: duplicateEmail }), 1);
  });

  await t.test('operational register/login failures use private 500 responses', async () => {
    resetLimit();
    for (const [method, path] of [['create', 'register'], ['findOne', 'login']]) {
      const failure = t.mock.method(User, method, () => { throw new Error('private-db-password'); });
      try {
        const response = await request(`/api/auth/${path}`, { method: 'POST', body: { ...credentials, email: newEmail() } });
        assert.equal(response.status, 500);
        assert.deepEqual(response.body, { error: { message: 'Internal server error' } });
      } finally { failure.mock.restore(); }
    }
  });

  await t.test('both authentication routes share ten attempts per IP and return structured 429', async () => {
    resetLimit();
    for (let index = 0; index < 10; index++) {
      const path = index % 2 ? '/api/auth/login' : '/api/auth/register';
      assert.equal((await request(path, { method: 'POST', body: {} })).status, 400);
    }
    const blocked = await request('/api/auth/login', { method: 'POST', body: {} });
    assert.equal(blocked.status, 429);
    assert.deepEqual(blocked.body, { error: { message: 'Too many authentication attempts; try again later' } });
    assert.ok(blocked.headers.get('retry-after'));
    assert.ok(blocked.headers.get('ratelimit'));
    resetLimit();
  });
  assert.deepEqual(await User.diffIndexes(), { toDrop: [], toCreate: [] });
  console.log('Auth verified on isolated local MongoDB: hashes, safe views, JWT, current roles, deletion, duplicate race, rate limit; no new indexes');
});
