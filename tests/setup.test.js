import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync, spawn } from 'node:child_process';
import { test } from 'node:test';
import express from 'express';
import mongoose from 'mongoose';
import { app } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { connectDatabase } from '../src/config/database.js';
import { HttpError } from '../src/utils/HttpError.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { authLimiter } from '../src/routes/auth.routes.js';

const validEnv = {
  MONGODB_URI: 'mongodb://127.0.0.1:27029/secure_notes_test?replicaSet=notes-dev9',
  JWT_SECRET: 'test-only-secret-with-at-least-32-characters',
  FRONTEND_ORIGIN: 'http://localhost:5500',
};

async function listen(t, application) {
  const server = application.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('environment defaults are usable and unknown process variables are excluded', () => {
  const env = loadEnv({ ...validEnv, UNRELATED_SECRET: 'do-not-copy' });
  assert.equal(env.PORT, 3000);
  assert.equal(env.BCRYPT_COST, 12);
  assert.equal(env.JWT_EXPIRES_IN, '1h');
  assert.equal(env.NODE_ENV, 'development');
  assert.equal(env.TRUST_PROXY_HOPS, 0);
  assert.equal(loadEnv({ ...validEnv, TRUST_PROXY_HOPS: '1' }).TRUST_PROXY_HOPS, 1);
  assert.equal(env.UNRELATED_SECRET, undefined);
});

test('invalid configuration names its fields without leaking supplied values', () => {
  const secret = 'secret-value';
  assert.throws(() => loadEnv({ ...validEnv, JWT_SECRET: secret }), (error) => {
    assert.match(error.message, /JWT_SECRET/);
    assert.ok(!error.message.includes(secret));
    return true;
  });
  for (const [field, value] of [
    ['PORT', '0'], ['PORT', '65536'], ['PORT', 'abc'],
    ['BCRYPT_COST', '3'], ['BCRYPT_COST', '32'],
    ['MONGODB_URI', 'https://example.com'],
    ['FRONTEND_ORIGIN', 'https://example.com/path'],
    ['FRONTEND_ORIGIN', 'file:///tmp/site'],
    ['JWT_EXPIRES_IN', '0h'], ['NODE_ENV', 'unknown'],
    ['TRUST_PROXY_HOPS', '-1'], ['TRUST_PROXY_HOPS', '1.5'], ['TRUST_PROXY_HOPS', 'true'],
  ]) {
    assert.throws(() => loadEnv({ ...validEnv, [field]: value }), /Invalid environment/);
  }
  assert.throws(() => loadEnv({}), /MONGODB_URI/);
});

test('unimplemented routes use the JSON error shape and security headers', async (t) => {
  const origin = await listen(t, app);
  const response = await fetch(`${origin}/api/unknown`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: { message: 'Route not found' } });
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('malformed and oversized JSON are controlled client errors', async (t) => {
  const origin = await listen(t, app);
  for (const [body, status, message] of [
    ['{', 400, 'Invalid JSON body'],
    [JSON.stringify({ value: 'x'.repeat(102401) }), 413, 'Request body too large'],
  ]) {
    const response = await fetch(`${origin}/api/notes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: { message } });
  }
});

test('Express 5 forwards async errors and internal messages remain private', async (t) => {
  const fixture = express();
  fixture.get('/denied', async () => { throw new HttpError(403, 'Forbidden'); });
  fixture.get('/failed', async () => { throw new Error('private-password-or-database-detail'); });
  fixture.get('/server-error', () => { throw new HttpError(503, 'private-service-detail'); });
  fixture.get('/invalid-status', () => { throw new HttpError(400.5, 'private-internal-detail'); });
  fixture.use(errorHandler);
  const origin = await listen(t, fixture);
  for (const [path, status, message] of [
    ['/denied', 403, 'Forbidden'],
    ['/failed', 500, 'Internal server error'],
    ['/server-error', 503, 'Internal server error'],
    ['/invalid-status', 500, 'Internal server error'],
  ]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: { message } });
  }
});

test('already-started responses delegate errors instead of writing a second response', () => {
  const error = new Error('stream failed');
  let forwarded;
  errorHandler(error, {}, { headersSent: true }, (value) => { forwarded = value; });
  assert.equal(forwarded, error);
});

test('server diagnostics contain categories without raw errors, URLs or credentials', (t) => {
  const logs = t.mock.method(console, 'error', () => {});
  const failure = new Error('private-password-and-database-URI');
  failure.code = 91;
  const req = { method: 'GET', route: { path: '/:id' }, originalUrl: '/private-id?token=private-token', headers: { authorization: 'private-token' } };
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  errorHandler(failure, req, res, () => assert.fail('Unexpected delegation'));
  assert.equal(res.code, 500);
  assert.deepEqual(res.body, { error: { message: 'Internal server error' } });
  assert.deepEqual(logs.mock.calls[0].arguments, ['Request failed', { method: 'GET', route: '/:id', status: 500, type: 'Error', code: 91 }]);
  assert.ok(!JSON.stringify(logs.mock.calls[0].arguments).includes('private-'));
  errorHandler(new HttpError(403, 'Forbidden'), req, res, () => {});
  assert.equal(logs.mock.callCount(), 1);
});

test('configured proxy hops separate clients and ignore forged leftmost addresses', async (t) => {
  const previous = app.get('trust proxy');
  const clientAddresses = Array.from({ length: 11 }, (_, i) => `192.0.2.${i + 1}`);
  t.after(() => {
    app.set('trust proxy', previous);
    for (const key of ['127.0.0.1', ...clientAddresses]) authLimiter.resetKey(key);
  });
  const origin = await listen(t, app);
  const attempt = (forwarded) => fetch(`${origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': forwarded }, body: '{}',
  });
  app.set('trust proxy', 1);
  for (const address of clientAddresses) {
    const response = await attempt(`198.51.100.99, ${address}`);
    assert.equal(response.status, 400);
    await response.text();
  }
  for (let i = 0; i < 9; i++) {
    const response = await attempt(`198.51.100.${i}, ${clientAddresses[0]}`);
    assert.equal(response.status, 400);
    await response.text();
  }
  const blocked = await attempt(`198.51.100.200, ${clientAddresses[0]}`);
  assert.equal(blocked.status, 429);
  await blocked.text();
  app.set('trust proxy', 0);
  authLimiter.resetKey('127.0.0.1');
  for (let i = 0; i < 11; i++) {
    const response = await attempt(clientAddresses[i]);
    assert.equal(response.status, i < 10 ? 400 : 429);
    await response.text();
  }
});

test('startup exits unsuccessfully for invalid configuration without secret output', () => {
  const child = spawnSync(process.execPath, ['src/server.js'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, ...validEnv, NODE_ENV: 'test', JWT_SECRET: 'private-short-secret' },
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /JWT_SECRET/);
  assert.ok(!child.stderr.includes('private-short-secret'));
  assert.ok(!child.stdout.includes('API listening'));
});

test('a malformed MongoDB URI is redacted and leaves no open connection', async () => {
  await assert.rejects(connectDatabase('mongodb://bad-secret@'), /MongoDB connection failed/);
  assert.equal(mongoose.connection.readyState, 0);
});

test('real MongoDB connection and deployment rejection', {
  skip: !process.env.TEST_MONGODB_URI,
}, async (t) => {
  t.after(() => mongoose.disconnect());
  const connection = await connectDatabase(process.env.TEST_MONGODB_URI);
  assert.equal(connection.readyState, 1);
  const info = await connection.db.admin().command({ buildInfo: 1 });
  assert.deepEqual(info.versionArray.slice(0, 2), [9, 0]);
  const topology = await connection.db.admin().command({ hello: 1 });
  assert.ok(topology.setName);
  console.log(`Verified MongoDB ${info.version}, replica set ${topology.setName}`);

  for (const [versionArray, setName, isWritablePrimary] of [
    [[7, 0], 'notes-dev9', true], [[9, 0], undefined, true], [[9, 0], 'notes-dev9', false],
  ]) {
    const restore = t.mock.method(connection.db, 'admin', () => ({
      command: async (command) => command.buildInfo ? { versionArray } : { setName, isWritablePrimary },
    }));
    await assert.rejects(connectDatabase(process.env.TEST_MONGODB_URI), /MongoDB connection failed/);
    assert.equal(mongoose.connection.readyState, 0);
    restore.mock.restore();
    await connectDatabase(process.env.TEST_MONGODB_URI);
  }
});

test('server connects before listening, releases an occupied port and shuts down', {
  skip: !process.env.TEST_MONGODB_URI,
  timeout: 30000,
}, async (t) => {
  const productionUri = new URL(process.env.TEST_MONGODB_URI);
  if (productionUri.hostname !== '127.0.0.1' || productionUri.pathname !== '/secure_notes_models_test') {
    throw new Error('Startup tests require the dedicated local test URI');
  }
  const databaseName = `secure_notes_startup_test_${new mongoose.Types.ObjectId()}`;
  productionUri.pathname = `/${databaseName}`;
  const client = new mongoose.mongo.MongoClient(productionUri.href);
  await client.connect();
  t.after(async () => {
    try {
      assert.equal(productionUri.hostname, '127.0.0.1');
      assert.equal(productionUri.pathname, `/${databaseName}`);
      await client.db(databaseName).dropDatabase();
    } finally { await client.close(); }
  });
  const occupied = express().listen(0);
  await once(occupied, 'listening');
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const port = String(occupied.address().port);
  const rejected = spawnSync(process.execPath, ['src/server.js'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, ...validEnv, NODE_ENV: 'production', MONGODB_URI: productionUri.href, PORT: port },
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  assert.equal(rejected.status, 1, JSON.stringify({
    stdout: rejected.stdout, stderr: rejected.stderr, error: rejected.error?.message,
  }));
  assert.match(rejected.stderr, /HTTP server failed/);
  const actualIndexes = await Promise.all(['users', 'notes', 'posts'].map(async (name) =>
    (await client.db(databaseName).collection(name).indexes()).map(({ name: indexName }) => indexName)));
  assert.deepEqual(actualIndexes, [['_id_', 'email_1', 'interests_1'], ['_id_', 'ownerId_1__id_-1'], ['_id_', 'authorId_1__id_-1']]);

  const reservation = express().listen(0);
  await once(reservation, 'listening');
  const availablePort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const bootstrap = "process.once('message', () => { process.disconnect(); process.emit('SIGTERM'); }); await import('./src/server.js');";
  const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, ...validEnv, NODE_ENV: 'production', MONGODB_URI: productionUri.href, PORT: String(availablePort) },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  let errors = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const deadline = Date.now() + 10000;
  while (!output.includes('API listening') && Date.now() < deadline && child.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(output, /Connected to MongoDB replica set[\s\S]*API listening/);
  const response = await fetch(`http://127.0.0.1:${availablePort}/api/unknown`);
  assert.equal(response.status, 404);
  const exited = once(child, 'exit');
  child.send('stop');
  const [code] = await exited;
  assert.equal(code, 0, errors);
});
