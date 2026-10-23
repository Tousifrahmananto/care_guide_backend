import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { app } from '../src/app.js';
import { User } from '../src/models/user.model.js';
import { Note } from '../src/models/note.model.js';
import { Post } from '../src/models/post.model.js';
import { adminCreateSchema, adminUpdateSchema } from '../src/utils/userSchemas.js';
import { authLimiter } from '../src/routes/auth.routes.js';

const config = { JWT_SECRET: 'task5-test-only-secret-at-least-32-characters', BCRYPT_COST: 4, JWT_EXPIRES_IN: '1h' };
const input = { name: ' New user ', email: ' NEW@Example.com ', password: ' initial-password ' };

test('Admin schemas reuse credential boundaries without PATCH defaults or protected fields', () => {
  assert.equal(adminCreateSchema.parse(input).role, 'user');
  assert.equal(adminCreateSchema.parse({ ...input, role: 'admin' }).role, 'admin');
  assert.deepEqual(adminUpdateSchema.parse({ name: ' Updated ', passwordHash: 'injected' }), { name: 'Updated' });
  assert.deepEqual(adminUpdateSchema.parse({ role: 'admin' }), { role: 'admin' });
  for (const body of [{}, { passwordHash: 'injected' }, { role: null }, { role: 'owner' }, { password: 'short' }, { interests: [7] }]) {
    assert.equal(adminUpdateSchema.safeParse(body).success, false);
  }
  for (const password of ['x'.repeat(72), 'ক'.repeat(24)]) {
    assert.equal(adminCreateSchema.safeParse({ ...input, password }).success, true);
    assert.equal(adminUpdateSchema.safeParse({ password }).success, true);
  }
  for (const password of ['x'.repeat(73), 'ক'.repeat(24) + 'x']) {
    assert.equal(adminCreateSchema.safeParse({ ...input, password }).success, false);
    assert.equal(adminUpdateSchema.safeParse({ password }).success, false);
  }
});

test('real Admin user CRUD, password boundaries, atomic cascades and conflicting actions', {
  skip: !process.env.TEST_MONGODB_URI, timeout: 60000,
}, async (t) => {
  const uri = new URL(process.env.TEST_MONGODB_URI);
  if (uri.hostname !== '127.0.0.1' || uri.pathname !== '/secure_notes_models_test') {
    throw new Error('Admin tests require the dedicated local test database URI');
  }
  uri.pathname = '/secure_notes_admin_test';
  await mongoose.connect(uri.href, { serverSelectionTimeoutMS: 5000, bufferCommands: false });
  const ids = [];
  t.after(async () => {
    try {
      await Note.deleteMany({ ownerId: { $in: ids } });
      await Post.deleteMany({ authorId: { $in: ids } });
      await User.deleteMany({ _id: { $in: ids } });
    } finally { await mongoose.disconnect(); }
  });
  for (const model of [User, Note, Post]) await model.syncIndexes();
  app.locals.config = config;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const hash = await bcrypt.hash(input.password, config.BCRYPT_COST);
  async function fixture(role = 'user') {
    const _id = new mongoose.Types.ObjectId();
    ids.push(_id);
    const user = await User.create({ _id, name: 'Fixture', email: `task5-${_id}@example.com`, passwordHash: hash, role, interests: ['keep'] });
    return { user, token: jwt.sign({}, config.JWT_SECRET, { subject: user.id, algorithm: 'HS256', expiresIn: '1h' }) };
  }
  async function request(path, { method = 'GET', token, body } = {}) {
    const response = await fetch(`${origin}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: response.status === 204 ? null : await response.json() };
    if (method === 'POST' && path === '/api/admin/users' && result.status === 201) ids.push(new mongoose.Types.ObjectId(result.body.data._id));
    return result;
  }
  const admin = await fixture('admin');
  const ordinary = await fixture();
  const target = await fixture();

  await t.test('every user-management route requires authentication and current Admin role', async () => {
    for (const [method, path, body] of [
      ['POST', '/api/admin/users', input], ['GET', '/api/admin/users'], ['GET', `/api/admin/users/${target.user.id}`],
      ['PATCH', `/api/admin/users/${target.user.id}`, { name: 'Updated' }], ['DELETE', `/api/admin/users/${target.user.id}`],
    ]) {
      assert.equal((await request(path, { method, body })).status, 401);
      assert.equal((await request(path, { method, body, token: ordinary.token })).status, 403);
    }
  });

  await t.test('Admin creates permitted roles and safely lists/reads paginated accounts', async () => {
    const email = `task5-${new mongoose.Types.ObjectId()}@example.com`;
    const created = await request('/api/admin/users', { method: 'POST', token: admin.token, body: { ...input, email, role: 'admin', passwordHash: 'attack', interests: [' CODE ', 'code'] } });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.role, 'admin');
    assert.deepEqual(created.body.data.interests, ['code']);
    assert.deepEqual(Object.keys(created.body.data).sort(), ['_id', 'name', 'email', 'role', 'interests', 'createdAt', 'updatedAt'].sort());
    const stored = await User.findById(created.body.data._id).select('+passwordHash').lean();
    assert.equal(await bcrypt.compare(input.password, stored.passwordHash), true);
    const listed = await request('/api/admin/users?limit=2', { token: admin.token });
    assert.equal(listed.status, 200);
    assert.deepEqual({ ...listed.body, data: [] }, { data: [], page: 1, limit: 2, total: 4, totalPages: 2 });
    assert.deepEqual(listed.body.data.map(({ _id }) => _id), [...ids].map(String).sort().reverse().slice(0, 2));
    assert.ok(listed.body.data.every((user) => user.passwordHash === undefined && user.__v === undefined));
    const beyond = await request('/api/admin/users?page=99&limit=2', { token: admin.token });
    assert.deepEqual(beyond.body, { data: [], page: 99, limit: 2, total: 4, totalPages: 2 });
    assert.equal((await request('/api/admin/users?limit=100000', { token: admin.token })).body.limit, 100);
    for (const query of ['page=0', 'page=2junk', 'page=1&page=2', 'limit[]=2', 'page[value]=1']) {
      assert.equal((await request(`/api/admin/users?${query}`, { token: admin.token })).status, 400);
    }
    const read = await request(`/api/admin/users/${stored._id}`, { token: admin.token });
    assert.deepEqual(read.body.data, created.body.data);
  });

  await t.test('partial updates preserve omitted fields, hash passwords and reuse duplicate handling', async () => {
    const changed = await request(`/api/admin/users/${target.user.id}`, { method: 'PATCH', token: admin.token, body: { name: ' Changed ', password: ' changed-password ', passwordHash: 'attack' } });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.data.name, 'Changed');
    assert.deepEqual(changed.body.data.interests, ['keep']);
    const stored = await User.findById(target.user._id).select('+passwordHash').lean();
    assert.equal(await bcrypt.compare(' changed-password ', stored.passwordHash), true);
    assert.equal(await bcrypt.compare('changed-password', stored.passwordHash), false);
    assert.equal(stored.password, undefined);
    for (const [method, path, body] of [
      ['POST', '/api/admin/users', { ...input, email: ` ${ordinary.user.email.toUpperCase()} ` }],
      ['PATCH', `/api/admin/users/${target.user.id}`, { email: ordinary.user.email }],
    ]) {
      const version = (await User.findById(admin.user._id).lean()).__v;
      const response = await request(path, { method, token: admin.token, body });
      assert.equal(response.status, 409);
      assert.deepEqual(response.body, { error: { message: 'Email already registered' } });
      assert.equal((await User.findById(admin.user._id).lean()).__v, version);
    }
    assert.equal((await User.findById(target.user._id).lean()).email, target.user.email);
    for (const body of [{}, { passwordHash: 'attack' }, { role: null }, { interests: [null] }]) {
      assert.equal((await request(`/api/admin/users/${target.user.id}`, { method: 'PATCH', token: admin.token, body })).status, 400);
    }
    for (const method of ['GET', 'PATCH', 'DELETE']) {
      const body = method === 'PATCH' ? { name: 'Valid' } : undefined;
      assert.equal((await request('/api/admin/users/bad', { method, token: admin.token, body })).status, 400);
      assert.equal((await request(`/api/admin/users/${new mongoose.Types.ObjectId()}`, { method, token: admin.token, body })).status, 404);
    }
  });

  await t.test('both Admin password-setting paths enforce 72/73 UTF-8 bytes before hashing', async () => {
    for (const password of ['x'.repeat(72), 'ক'.repeat(24)]) {
      const email = `task5-${new mongoose.Types.ObjectId()}@example.com`;
      const created = await request('/api/admin/users', { method: 'POST', token: admin.token, body: { ...input, email, password } });
      assert.equal(created.status, 201);
      assert.equal(created.body.data.role, 'user');
      const updated = await request(`/api/admin/users/${target.user.id}`, { method: 'PATCH', token: admin.token, body: { password } });
      assert.equal(updated.status, 200);
      authLimiter.resetKey('127.0.0.1');
      for (const account of [email, target.user.email]) {
        assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: account, password } })).status, 200);
      }
    }
    const hashing = t.mock.method(bcrypt, 'hash', () => { throw new Error('Invalid input reached hashing'); });
    try {
      for (const password of ['x'.repeat(73), 'ক'.repeat(24) + 'x']) {
        assert.equal((await request('/api/admin/users', { method: 'POST', token: admin.token, body: { ...input, password } })).status, 400);
        assert.equal((await request(`/api/admin/users/${target.user.id}`, { method: 'PATCH', token: admin.token, body: { password } })).status, 400);
      }
      assert.equal(hashing.mock.callCount(), 0);
    } finally { hashing.mock.restore(); }
  });

  await t.test('self deletion/demotion is rejected and permitted self edits lock the account once', async () => {
    assert.equal((await request(`/api/admin/users/${admin.user.id}`, { method: 'DELETE', token: admin.token })).status, 409);
    assert.equal((await request(`/api/admin/users/${admin.user.id}`, { method: 'PATCH', token: admin.token, body: { role: 'user' } })).status, 409);
    const original = User.updateOne;
    const writes = t.mock.method(User, 'updateOne', function (...args) { return original.apply(this, args); });
    try {
      assert.equal((await request(`/api/admin/users/${admin.user.id}`, { method: 'PATCH', token: admin.token, body: { name: 'Renamed Admin', role: 'admin' } })).status, 200);
      assert.equal(writes.mock.callCount(), 1);
    } finally { writes.mock.restore(); }
    assert.equal((await User.findById(admin.user._id).lean()).role, 'admin');
  });

  await t.test('cascade failure rolls back account, both child collections and coordination writes', async () => {
    const victim = await fixture();
    await Note.create({ ownerId: victim.user._id, title: 'Retained note' });
    await Post.create({ authorId: victim.user._id, title: 'Retained post', content: 'body' });
    const actorVersion = (await User.findById(admin.user._id).lean()).__v;
    const original = Post.deleteMany;
    const failure = t.mock.method(Post, 'deleteMany', async function (...args) {
      await original.apply(this, args);
      throw new Error('private-cleanup-detail');
    });
    try {
      const response = await request(`/api/admin/users/${victim.user.id}`, { method: 'DELETE', token: admin.token });
      assert.equal(response.status, 500);
      assert.deepEqual(response.body, { error: { message: 'Internal server error' } });
    } finally { failure.mock.restore(); }
    assert.equal((await User.findById(victim.user._id).lean()).__v, 0);
    assert.equal((await User.findById(admin.user._id).lean()).__v, actorVersion);
    assert.equal(await Note.countDocuments({ ownerId: victim.user._id }), 1);
    assert.equal(await Post.countDocuments({ authorId: victim.user._id }), 1);
  });

  await t.test('successful cascade removes only the target and invalidates its existing token', async () => {
    const victim = await fixture();
    await Note.create({ ownerId: victim.user._id, title: 'Removed note' });
    await Post.create({ authorId: victim.user._id, title: 'Removed post', content: 'body' });
    const retained = await Note.create({ ownerId: ordinary.user._id, title: 'Unrelated note' });
    assert.equal((await request(`/api/admin/users/${victim.user.id}`, { method: 'DELETE', token: admin.token })).status, 204);
    assert.equal(await User.countDocuments({ _id: victim.user._id }), 0);
    assert.equal(await Note.countDocuments({ ownerId: victim.user._id }), 0);
    assert.equal(await Post.countDocuments({ authorId: victim.user._id }), 0);
    assert.equal(await Note.countDocuments({ _id: retained._id }), 1);
    assert.equal((await request('/api/me', { token: victim.token })).status, 401);
  });

  await t.test('transaction-time authorization rejects actors demoted after middleware on every mutation', async () => {
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const actor = await fixture('admin');
      const victim = await fixture();
      const original = User.updateOne;
      let first = true;
      const changedRole = t.mock.method(User, 'updateOne', async function (...args) {
        if (first) {
          first = false;
          await original.call(this, { _id: actor.user._id }, { $set: { role: 'user' } });
        }
        return original.apply(this, args);
      });
      try {
        const path = method === 'POST' ? '/api/admin/users' : `/api/admin/users/${victim.user.id}`;
        const body = method === 'POST' ? { ...input, email: `task5-${new mongoose.Types.ObjectId()}@example.com` } : method === 'PATCH' ? { name: 'Must not change' } : undefined;
        const response = await request(path, { method, token: actor.token, body });
        assert.equal(response.status, 403);
        assert.equal((await User.findById(victim.user._id).lean()).name, 'Fixture');
        if (method === 'POST') assert.equal(await User.countDocuments({ email: body.email }), 0);
      } finally { changedRole.mock.restore(); }
    }
  });

  for (const actions of [['DELETE', 'DELETE'], ['PATCH', 'PATCH'], ['DELETE', 'PATCH']]) {
    await t.test(`opposing Admin ${actions.join('/')} actions cannot remove both Admins`, async () => {
      const left = await fixture('admin');
      const right = await fixture('admin');
      const original = User.updateOne;
      let arrivals = 0;
      let release;
      const bothReady = new Promise((resolve) => { release = resolve; });
      const firstIds = [];
      const gate = t.mock.method(User, 'updateOne', async function (...args) {
        if (arrivals < 2) {
          firstIds.push(String(args[0]._id));
          if (++arrivals === 2) release();
          await bothReady;
        }
        return original.apply(this, args);
      });
      try {
        const results = await Promise.all([[left, right], [right, left]].map(([actor, victim], index) =>
          request(`/api/admin/users/${victim.user.id}`, { method: actions[index], token: actor.token, ...(actions[index] === 'PATCH' ? { body: { role: 'user' } } : {}) })));
        assert.equal(results.filter(({ status }) => status === 403).length, 1);
        assert.equal(results.filter(({ status }) => status === 200 || status === 204).length, 1);
        assert.deepEqual(firstIds, Array(2).fill([left.user.id, right.user.id].sort()[0]));
        assert.equal(await User.countDocuments({ _id: { $in: [left.user._id, right.user._id] }, role: 'admin' }), 1);
      } finally { release(); gate.mock.restore(); }
    });
  }

  await t.test('real note creation racing with the actual Admin cascade leaves no orphan', async () => {
    for (const creationFirst of [false, true]) {
      const victim = await fixture();
      let reached;
      const waiting = new Promise((resolve) => { reached = resolve; });
      let release;
      const released = new Promise((resolve) => { release = resolve; });
      const model = creationFirst ? Note : User;
      const method = creationFirst ? 'create' : 'updateOne';
      const original = model[method];
      let paused = false;
      const gate = t.mock.method(model, method, async function (...args) {
        if (creationFirst) {
          const result = await original.apply(this, args);
          reached();
          await released;
          return result;
        }
        if (!paused && String(args[0]._id) === victim.user.id && args[0].role === undefined) {
          paused = true;
          reached();
          await released;
        }
        return original.apply(this, args);
      });
      const creation = request('/api/notes', { method: 'POST', token: victim.token, body: { title: 'Racing note' } });
      let deletion;
      let observedWrites;
      let attempts = 0;
      try {
        await waiting;
        if (creationFirst) {
          let retried;
          const retry = new Promise((resolve) => { retried = resolve; });
          const parentWrite = User.updateOne;
          observedWrites = t.mock.method(User, 'updateOne', function (...args) {
            if (String(args[0]._id) === victim.user.id && ++attempts >= 2) retried();
            return parentWrite.apply(this, args);
          });
          deletion = request(`/api/admin/users/${victim.user.id}`, { method: 'DELETE', token: admin.token });
          await retry;
        } else {
          deletion = request(`/api/admin/users/${victim.user.id}`, { method: 'DELETE', token: admin.token });
          assert.equal((await deletion).status, 204);
        }
      } finally { release(); gate.mock.restore(); observedWrites?.mock.restore(); }
      const [created, removed] = await Promise.all([creation, deletion]);
      assert.equal(created.status, creationFirst ? 201 : 401);
      assert.equal(removed.status, 204);
      if (creationFirst) assert.ok(attempts >= 2);
      assert.equal(await Note.countDocuments({ ownerId: victim.user._id }), 0);
      assert.equal(await User.countDocuments({ _id: victim.user._id }), 0);
    }
  });
  for (const model of [User, Note, Post]) assert.deepEqual(await model.diffIndexes(), { toDrop: [], toCreate: [] });
  console.log('Admin verified: safe CRUD, credential boundaries, self guards, rollback, cascade, current actor roles and conflicting Admin/child transactions; no new indexes');
});
