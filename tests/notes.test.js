import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { app } from '../src/app.js';
import { User } from '../src/models/user.model.js';
import { Note } from '../src/models/note.model.js';

test('real notes API ownership, pagination, validation and transaction coordination', {
  skip: !process.env.TEST_MONGODB_URI, timeout: 60000,
}, async (t) => {
  const uri = new URL(process.env.TEST_MONGODB_URI);
  if (uri.hostname !== '127.0.0.1' || uri.pathname !== '/secure_notes_models_test') {
    throw new Error('Notes tests require the dedicated local test database URI');
  }
  uri.pathname = '/secure_notes_notes_test';
  await mongoose.connect(uri.href, { serverSelectionTimeoutMS: 5000, bufferCommands: false });
  const userIds = [];
  t.after(async () => {
    try {
      await Note.deleteMany({ ownerId: { $in: userIds } });
      await User.deleteMany({ _id: { $in: userIds } });
    } finally { await mongoose.disconnect(); }
  });
  await User.syncIndexes();
  await Note.syncIndexes();
  const secret = 'task4-test-only-secret-at-least-32-characters';
  app.locals.config = { JWT_SECRET: secret };
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function fixtureUser(role = 'user') {
    const _id = new mongoose.Types.ObjectId();
    userIds.push(_id);
    const user = await User.create({ _id, name: 'Notes fixture', email: `task4-${_id}@example.com`, passwordHash: 'test-only-unused-verifier', role });
    return { user, token: jwt.sign({}, secret, { algorithm: 'HS256', subject: user.id, expiresIn: '1h' }) };
  }
  async function request(path, { method = 'GET', body, token } = {}) {
    const response = await fetch(`${origin}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  }
  const owner = await fixtureUser();
  const other = await fixtureUser();
  const admin = await fixtureUser('admin');
  const foreign = await Note.create({ ownerId: other.user._id, title: 'Private other note' });
  const adminNote = await Note.create({ ownerId: admin.user._id, title: 'Admin own note' });
  const ownIds = [];

  await t.test('all note operations require login and Admin lists require the current Admin role', async () => {
    for (const [method, path] of [
      ['GET', '/api/notes'], ['POST', '/api/notes'], ['GET', `/api/notes/${foreign.id}`],
      ['PATCH', `/api/notes/${foreign.id}`], ['DELETE', `/api/notes/${foreign.id}`], ['GET', '/api/admin/notes'],
    ]) assert.equal((await request(path, { method })).status, 401);
    assert.equal((await request('/api/admin/notes', { token: owner.token })).status, 403);
  });

  await t.test('creation derives ownership, keeps the note view safe and commits a real parent increment', async () => {
    for (let index = 0; index < 3; index++) {
      const response = await request('/api/notes', { method: 'POST', token: owner.token, body: {
        title: ` Own ${index} `, ownerId: other.user.id, _id: foreign.id, __v: 99,
      } });
      assert.equal(response.status, 201);
      assert.deepEqual(Object.keys(response.body.data).sort(), ['_id', 'ownerId', 'title', 'content', 'createdAt', 'updatedAt'].sort());
      assert.equal(response.body.data.ownerId, owner.user.id);
      assert.equal(response.body.data.title, `Own ${index}`);
      assert.equal(response.body.data.content, '');
      assert.notEqual(response.body.data._id, foreign.id);
      ownIds.push(response.body.data._id);
    }
    assert.equal((await User.findById(owner.user._id).lean()).__v, 3);
    assert.equal(await Note.countDocuments({ ownerId: owner.user._id }), 3);
  });

  await t.test('own/Admin lists use exact metadata, descending IDs, capped limits and owner filters', async () => {
    const first = await request('/api/notes?limit=2', { token: owner.token });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.data.map(({ _id }) => _id), [...ownIds].reverse().slice(0, 2));
    assert.deepEqual({ ...first.body, data: [] }, { data: [], page: 1, limit: 2, total: 3, totalPages: 2 });
    assert.ok(first.body.data.every((note) => note.ownerId === owner.user.id && note.__v === undefined));
    const second = await request('/api/notes?page=2&limit=2', { token: owner.token });
    assert.deepEqual(second.body.data.map(({ _id }) => _id), [ownIds[0]]);
    const beyond = await request('/api/notes?page=9&limit=2', { token: owner.token });
    assert.deepEqual(beyond.body, { data: [], page: 9, limit: 2, total: 3, totalPages: 2 });
    const capped = await request('/api/notes?limit=100000', { token: owner.token });
    assert.equal(capped.body.limit, 100);
    assert.equal(capped.body.data.length, 3);
    const ignoredOwner = await request(`/api/notes?ownerId=${other.user.id}`, { token: owner.token });
    assert.equal(ignoredOwner.body.total, 3);
    assert.ok(ignoredOwner.body.data.every((note) => note.ownerId === owner.user.id));
    assert.equal((await request('/api/notes', { token: admin.token })).body.total, 1);
    const all = await request('/api/admin/notes?limit=2', { token: admin.token });
    assert.deepEqual({ ...all.body, data: [] }, { data: [], page: 1, limit: 2, total: 5, totalPages: 3 });
    assert.equal(all.body.data.length, 2);
    const filtered = await request(`/api/admin/notes?ownerId=${owner.user.id}&limit=2`, { token: admin.token });
    assert.equal(filtered.body.total, 3);
    assert.ok(filtered.body.data.every((note) => note.ownerId === owner.user.id));
    const empty = await request(`/api/admin/notes?ownerId=${new mongoose.Types.ObjectId()}`, { token: admin.token });
    assert.deepEqual(empty.body, { data: [], page: 1, limit: 20, total: 0, totalPages: 0 });
  });

  await t.test('query arrays/objects, malformed IDs and invalid bodies fail before database writes', async () => {
    for (const query of ['page=0', 'page=abc', 'page=2junk', 'page=1%0A', 'page=1&page=2', 'page[]=1', 'page[value]=1', 'limit[]=2', 'limit=0', 'limit=1.5', 'page=9007199254740991&limit=100']) {
      for (const [path, token] of [['/api/notes', owner.token], ['/api/admin/notes', admin.token]]) {
        assert.equal((await request(`${path}?${query}`, { token })).status, 400);
      }
    }
    for (const query of ['ownerId=', 'ownerId=bad', `ownerId=${owner.user.id}%0A`, `ownerId=${owner.user.id}&ownerId=${other.user.id}`, `ownerId[]=${owner.user.id}`, `ownerId[value]=${owner.user.id}`]) {
      assert.equal((await request(`/api/admin/notes?${query}`, { token: admin.token })).status, 400);
    }
    for (const id of ['bad', 'x'.repeat(24), '1'.repeat(12), `${owner.user.id}%0A`]) {
      for (const method of ['GET', 'PATCH', 'DELETE']) {
        assert.equal((await request(`/api/notes/${id}`, { token: owner.token, method, ...(method === 'PATCH' ? { body: { title: 'Valid' } } : {}) })).status, 400);
      }
    }
    for (const body of [{}, { title: ' ' }, { title: 7 }, { title: 'ok', content: null }, { title: '😀'.repeat(101) }]) {
      assert.equal((await request('/api/notes', { method: 'POST', token: owner.token, body })).status, 400);
    }
    for (const body of [{}, { ownerId: other.user.id }, { content: 7 }]) {
      assert.equal((await request(`/api/notes/${ownIds[0]}`, { method: 'PATCH', token: owner.token, body })).status, 400);
    }
    assert.equal(await Note.countDocuments({ ownerId: owner.user._id }), 3);
  });

  await t.test('foreign notes stay private; Admin can read but only the owner can change/delete', async () => {
    const missing = new mongoose.Types.ObjectId();
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const options = { token: other.token, method, ...(method === 'PATCH' ? { body: { title: 'Attack' } } : {}) };
      const denied = await request(`/api/notes/${ownIds[0]}`, options);
      const absent = await request(`/api/notes/${missing}`, options);
      assert.equal(denied.status, 404);
      assert.deepEqual(denied, absent);
    }
    assert.equal((await request(`/api/notes/${foreign.id}`, { token: admin.token })).status, 200);
    for (const method of ['PATCH', 'DELETE']) {
      assert.equal((await request(`/api/notes/${foreign.id}`, { token: admin.token, method, ...(method === 'PATCH' ? { body: { title: 'Admin attack' } } : {}) })).status, 404);
    }
    const changed = await request(`/api/notes/${ownIds[0]}`, { method: 'PATCH', token: owner.token, body: {
      title: ' Updated ', content: '  keep whitespace  ', ownerId: other.user.id, __v: 99,
    } });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.data.title, 'Updated');
    assert.equal(changed.body.data.content, '  keep whitespace  ');
    assert.equal(changed.body.data.ownerId, owner.user.id);
    assert.equal(changed.body.data.__v, undefined);
    assert.equal((await Note.findById(ownIds[0]).lean()).ownerId.toString(), owner.user.id);
    assert.equal((await request(`/api/notes/${adminNote.id}`, { method: 'PATCH', token: admin.token, body: { content: '' } })).status, 200);
    const removed = await request(`/api/notes/${ownIds[0]}`, { method: 'DELETE', token: owner.token });
    assert.deepEqual(removed, { status: 204, body: null });
    assert.equal((await request(`/api/notes/${ownIds[0]}`, { token: owner.token })).status, 404);
    assert.equal(await Note.countDocuments({ _id: foreign._id }), 1);
  });

  await t.test('failed child insertion rolls back both the actual child write and parent version', async () => {
    const before = await User.findById(owner.user._id).lean();
    const count = await Note.countDocuments({ ownerId: owner.user._id });
    const original = Note.create;
    const failure = t.mock.method(Note, 'create', async function (...args) {
      await original.apply(this, args);
      throw new Error('private-insert-detail');
    });
    try {
      const response = await request('/api/notes', { method: 'POST', token: owner.token, body: { title: 'Rolled back' } });
      assert.equal(response.status, 500);
      assert.deepEqual(response.body, { error: { message: 'Internal server error' } });
    } finally { failure.mock.restore(); }
    assert.equal((await User.findById(owner.user._id).lean()).__v, before.__v);
    assert.equal(await Note.countDocuments({ ownerId: owner.user._id }), count);
  });

  await t.test('a real stale-snapshot write conflict retries creation and commits exactly one child', async () => {
    const before = await User.findById(owner.user._id).lean();
    const count = await Note.countDocuments({ ownerId: owner.user._id });
    const original = User.updateOne;
    let attempts = 0;
    const conflict = t.mock.method(User, 'updateOne', async function (filter, update, options) {
      attempts++;
      if (attempts === 1) {
        await User.findById(filter._id).session(options.session);
        await original.call(this, filter, { $inc: { __v: 1 } });
      }
      return original.call(this, filter, update, options);
    });
    try {
      const response = await request('/api/notes', { method: 'POST', token: owner.token, body: { title: 'Retried once' } });
      assert.equal(response.status, 201);
    } finally { conflict.mock.restore(); }
    assert.ok(attempts >= 2);
    assert.equal((await User.findById(owner.user._id).lean()).__v, before.__v + 2);
    assert.equal(await Note.countDocuments({ ownerId: owner.user._id }), count + 1);
  });

  await t.test('deletion winning after authentication prevents an orphan note', async () => {
    const target = await fixtureUser();
    let reached;
    const waiting = new Promise((resolve) => { reached = resolve; });
    let resume;
    const released = new Promise((resolve) => { resume = resolve; });
    const original = User.updateOne;
    const gate = t.mock.method(User, 'updateOne', async function (...args) {
      reached();
      await released;
      return original.apply(this, args);
    });
    const creation = request('/api/notes', { method: 'POST', token: target.token, body: { title: 'Must not orphan' } });
    try {
      await waiting;
      await mongoose.connection.transaction(async (session) => {
        await User.deleteOne({ _id: target.user._id }, { session });
        await Note.deleteMany({ ownerId: target.user._id }, { session });
      });
    } finally { resume(); gate.mock.restore(); }
    assert.equal((await creation).status, 401);
    assert.equal(await Note.countDocuments({ ownerId: target.user._id }), 0);
  });

  await t.test('creation winning makes a competing deletion retry and include the new child', async () => {
    const target = await fixtureUser();
    let inserted;
    const waiting = new Promise((resolve) => { inserted = resolve; });
    let resume;
    const released = new Promise((resolve) => { resume = resolve; });
    const original = Note.create;
    const gate = t.mock.method(Note, 'create', async function (...args) {
      const result = await original.apply(this, args);
      inserted();
      await released;
      return result;
    });
    const creation = request('/api/notes', { method: 'POST', token: target.token, body: { title: 'Created before deletion' } });
    let retry;
    const retried = new Promise((resolve) => { retry = resolve; });
    let attempts = 0;
    let deletion;
    try {
      await waiting;
      deletion = mongoose.connection.transaction(async (session) => {
        if (++attempts >= 2) retry();
        await User.deleteOne({ _id: target.user._id }, { session });
        await Note.deleteMany({ ownerId: target.user._id }, { session });
      });
      await retried;
    } finally { resume(); gate.mock.restore(); }
    const [response] = await Promise.all([creation, deletion]);
    assert.equal(response.status, 201);
    assert.ok(attempts >= 2);
    assert.equal(await User.countDocuments({ _id: target.user._id }), 0);
    assert.equal(await Note.countDocuments({ ownerId: target.user._id }), 0);
  });

  for (const model of [User, Note]) assert.deepEqual(await model.diffIndexes(), { toDrop: [], toCreate: [] });
  console.log('Notes verified: ownership, pagination, Admin reads, rollback, real retry and both creation/deletion orders; no new indexes');
});
