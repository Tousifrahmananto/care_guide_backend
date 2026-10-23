import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { app } from '../src/app.js';
import { User } from '../src/models/user.model.js';
import { Note } from '../src/models/note.model.js';
import { Post } from '../src/models/post.model.js';

test('real posts API public reads, validation and transaction coordination', {
  skip: !process.env.TEST_MONGODB_URI, timeout: 60000,
}, async (t) => {
  const uri = new URL(process.env.TEST_MONGODB_URI);
  if (uri.hostname !== '127.0.0.1' || uri.pathname !== '/secure_notes_models_test') {
    throw new Error('Posts tests require the dedicated local test database URI');
  }
  uri.pathname = '/secure_notes_posts_test';
  await mongoose.connect(uri.href, { serverSelectionTimeoutMS: 5000, bufferCommands: false });
  const userIds = [];
  t.after(async () => {
    try {
      await Post.deleteMany({ authorId: { $in: userIds } });
      await Note.deleteMany({ ownerId: { $in: userIds } });
      await User.deleteMany({ _id: { $in: userIds } });
    } finally { await mongoose.disconnect(); }
  });
  for (const model of [User, Note, Post]) await model.syncIndexes();
  const secret = 'task6-test-only-secret-at-least-32-characters';
  app.locals.config = { JWT_SECRET: secret };
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function fixture(role = 'user') {
    const _id = new mongoose.Types.ObjectId();
    userIds.push(_id);
    const user = await User.create({ _id, name: 'Posts fixture', email: `task6-${_id}@example.com`, passwordHash: 'test-only-unused-verifier', role });
    return { user, token: jwt.sign({}, secret, { algorithm: 'HS256', subject: user.id, expiresIn: '1h' }) };
  }
  async function request(path, { method = 'GET', body, token } = {}) {
    const response = await fetch(`${origin}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json() };
  }
  const owner = await fixture();
  const other = await fixture();
  const admin = await fixture('admin');
  const ids = [];
  const fields = ['_id', 'authorId', 'title', 'content', 'createdAt', 'updatedAt'].sort();

  await t.test('empty public lists work without credentials, even with an invalid token', async () => {
    for (const token of [undefined, 'invalid-token']) {
      assert.deepEqual(await request('/api/posts', { token }), {
        status: 200, body: { data: [], page: 1, limit: 20, total: 0, totalPages: 0 },
      });
    }
  });

  await t.test('creation requires a current account and valid unexpired credentials', async () => {
    const removed = await fixture();
    assert.equal((await request(`/api/admin/users/${removed.user.id}`, { method: 'DELETE', token: admin.token })).status, 204);
    const expired = jwt.sign({}, secret, { algorithm: 'HS256', subject: owner.user.id, expiresIn: -1 });
    for (const token of [undefined, 'invalid-token', expired, removed.token]) {
      assert.equal((await request('/api/posts', { method: 'POST', token, body: { title: 'Denied', content: 'Public' } })).status, 401);
    }
    assert.equal(await Post.countDocuments({}), 0);
  });

  await t.test('users and Admins create their own posts, ignore injected fields and preserve content', async () => {
    for (const [index, actor] of [owner, other, admin].entries()) {
      const before = await User.findById(actor.user._id).lean();
      const content = index === 2 ? '\n \t' : `  Public ${index}  `;
      const response = await request('/api/posts', { method: 'POST', token: actor.token, body: {
        title: ` Post ${index} `, content, authorId: other.user.id, _id: other.user.id, __v: 99, role: 'admin', passwordHash: 'injected',
      } });
      assert.equal(response.status, 201);
      assert.deepEqual(Object.keys(response.body.data).sort(), fields);
      assert.equal(response.body.data.authorId, actor.user.id);
      assert.equal(response.body.data.title, `Post ${index}`);
      assert.equal(response.body.data.content, content);
      assert.notEqual(response.body.data._id, other.user.id);
      assert.equal((await User.findById(actor.user._id).lean()).__v, before.__v + 1);
      assert.equal((await Post.findById(response.body.data._id).lean()).authorId.toString(), actor.user.id);
      ids.push(response.body.data._id);
    }
    await Note.create({ ownerId: owner.user._id, title: 'Private note sentinel', content: 'Never a public post' });
  });

  await t.test('invalid bodies and UTF-16 overflow are rejected before parent or child writes', async () => {
    const before = await User.findById(owner.user._id).lean();
    for (const body of [
      {}, null, [], { title: 'Valid' }, { title: ' ', content: 'Valid' }, { title: 7, content: 'Valid' },
      { title: 'Valid', content: '' }, { title: 'Valid', content: null }, { title: 'Valid', content: 7 },
      { title: 'x'.repeat(201), content: 'Valid' }, { title: '😀'.repeat(101), content: 'Valid' },
      { title: 'Valid', content: 'x'.repeat(10001) }, { title: 'Valid', content: '😀'.repeat(5001) },
    ]) assert.equal((await request('/api/posts', { method: 'POST', token: owner.token, body })).status, 400);
    assert.equal(await Post.countDocuments({}), ids.length);
    assert.equal((await User.findById(owner.user._id).lean()).__v, before.__v);
  });

  await t.test('exact maximum title/content lengths are accepted for ASCII and emoji', async () => {
    for (const [title, content] of [['x'.repeat(200), 'x'.repeat(10000)], ['😀'.repeat(100), '😀'.repeat(5000)]]) {
      const response = await request('/api/posts', { method: 'POST', token: owner.token, body: { title, content } });
      assert.equal(response.status, 201);
      assert.equal(response.body.data.title, title);
      assert.equal(response.body.data.content, content);
      ids.push(response.body.data._id);
    }
  });

  await t.test('public pages include all authors, exact totals and only safe post fields', async () => {
    for (const token of [undefined, 'invalid-token', owner.token]) {
      const first = await request('/api/posts?limit=2', { token });
      assert.equal(first.status, 200);
      assert.deepEqual({ ...first.body, data: [] }, { data: [], page: 1, limit: 2, total: ids.length, totalPages: 3 });
      assert.deepEqual(first.body.data.map(({ _id }) => _id), [...ids].reverse().slice(0, 2));
    }
    const all = await request('/api/posts?limit=100000');
    assert.equal(all.body.limit, 100);
    assert.deepEqual(all.body.data.map(({ _id }) => _id), [...ids].reverse());
    for (const post of all.body.data) assert.deepEqual(Object.keys(post).sort(), fields);
    assert.deepEqual([...new Set(all.body.data.map(({ authorId }) => authorId))].sort(), [owner.user.id, other.user.id, admin.user.id].sort());
    const second = await request('/api/posts?page=2&limit=2');
    assert.deepEqual(second.body.data.map(({ _id }) => _id), [...ids].reverse().slice(2, 4));
    const beyond = await request('/api/posts?page=9&limit=2');
    assert.deepEqual(beyond.body, { data: [], page: 9, limit: 2, total: ids.length, totalPages: 3 });
    assert.equal(JSON.stringify(all.body).includes('Private note sentinel'), false);
  });

  await t.test('public pagination rejects malformed, repeated, nested and unsafe values', async () => {
    for (const query of ['page=', 'page=0', 'page=-1', 'page=abc', 'page=2junk', 'page=1%0A', 'page=1&page=2', 'page[]=1', 'page[value]=1', 'limit=0', 'limit=1.5', 'limit[]=2', 'page=9007199254740992', 'page=9007199254740991&limit=100']) {
      assert.equal((await request(`/api/posts?${query}`)).status, 400);
    }
  });

  await t.test('an inserted post and parent increment both roll back on failure', async () => {
    const before = await User.findById(owner.user._id).lean();
    const count = await Post.countDocuments({});
    const original = Post.create;
    const failure = t.mock.method(Post, 'create', async function (...args) {
      await original.apply(this, args);
      throw new Error('private-post-insert-detail');
    });
    try {
      const response = await request('/api/posts', { method: 'POST', token: owner.token, body: { title: 'Rollback', content: 'Public' } });
      assert.deepEqual(response, { status: 500, body: { error: { message: 'Internal server error' } } });
    } finally { failure.mock.restore(); }
    assert.equal(await Post.countDocuments({}), count);
    assert.equal((await User.findById(owner.user._id).lean()).__v, before.__v);
  });

  await t.test('a real stale-snapshot conflict retries creation and commits one post', async () => {
    const before = await User.findById(owner.user._id).lean();
    const count = await Post.countDocuments({});
    const original = User.updateOne;
    let attempts = 0;
    const conflict = t.mock.method(User, 'updateOne', async function (filter, update, options) {
      if (++attempts === 1) {
        await User.findById(filter._id).session(options.session);
        await original.call(this, filter, { $inc: { __v: 1 } });
      }
      return original.call(this, filter, update, options);
    });
    try {
      assert.equal((await request('/api/posts', { method: 'POST', token: owner.token, body: { title: 'Retried once', content: 'Public' } })).status, 201);
    } finally { conflict.mock.restore(); }
    assert.ok(attempts >= 2);
    assert.equal(await Post.countDocuments({}), count + 1);
    assert.equal((await User.findById(owner.user._id).lean()).__v, before.__v + 2);
  });

  for (const creationFirst of [false, true]) {
    await t.test(`${creationFirst ? 'creation' : 'Admin deletion'} winning leaves no orphan post`, async () => {
      const victim = await fixture();
      let reached;
      const waiting = new Promise((resolve) => { reached = resolve; });
      let release;
      const released = new Promise((resolve) => { release = resolve; });
      const model = creationFirst ? Post : User;
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
      const creation = request('/api/posts', { method: 'POST', token: victim.token, body: { title: 'Racing post', content: 'Public' } });
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
      assert.equal(await Post.countDocuments({ authorId: victim.user._id }), 0);
      assert.equal(await User.countDocuments({ _id: victim.user._id }), 0);
    });
  }
  for (const model of [User, Note, Post]) assert.deepEqual(await model.diffIndexes(), { toDrop: [], toCreate: [] });
  console.log('Posts verified: public pagination/projections, authenticated authors, boundaries, rollback, real retry and both actual Admin-deletion orders; no new indexes');
});
