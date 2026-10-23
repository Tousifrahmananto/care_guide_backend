import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { app } from '../src/app.js';
import { User } from '../src/models/user.model.js';
import { Note } from '../src/models/note.model.js';
import { Post } from '../src/models/post.model.js';

test('maximum normalized interest and post pages stay under BSON limits', () => {
  const _id = new mongoose.Types.ObjectId();
  const members = Array.from({ length: 101 }, () => ({ _id, name: 'অ'.repeat(100) }));
  const interest = 'অ'.repeat(100);
  const groups = { data: Array.from({ length: 100 }, () => ({ _id: interest, count: 101, users: members })), metadata: [{ total: 100 }] };
  const posts = { data: Array.from({ length: 100 }, () => ({ _id, authorId: _id, title: 'অ'.repeat(200), content: 'অ'.repeat(10000), createdAt: new Date(), updatedAt: new Date() })), metadata: [{ total: 100 }] };
  const groupBytes = mongoose.mongo.BSON.calculateObjectSize(groups);
  const postBytes = mongoose.mongo.BSON.calculateObjectSize({ _id, name: members[0].name, posts: [posts] });
  assert.ok(groupBytes < 16 * 1024 * 1024);
  assert.ok(postBytes < 16 * 1024 * 1024);
  console.log(`Maximum shape bytes with normalized interest cap: interests=${groupBytes}, user-posts=${postBytes}; each below 16 MiB`);
});

test('real single-call aggregation views, privacy, pagination and cursor reachability', {
  skip: !process.env.TEST_MONGODB_URI, timeout: 60000,
}, async (t) => {
  const uri = new URL(process.env.TEST_MONGODB_URI);
  if (uri.hostname !== '127.0.0.1' || uri.pathname !== '/secure_notes_models_test') {
    throw new Error('Aggregation tests require the dedicated local test database URI');
  }
  uri.pathname = '/secure_notes_aggregations_test';
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
  const secret = 'task7-test-only-secret-at-least-32-characters';
  app.locals.config = { JWT_SECRET: secret };
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  function input(name, interests = [], role = 'user') {
    const _id = new mongoose.Types.ObjectId();
    userIds.push(_id);
    return { _id, name, interests, role, email: `task7-${_id}@example.com`, passwordHash: 'test-only-unused-verifier' };
  }
  const admin = await User.create(input('Admin', [], 'admin'));
  const empty = await User.create(input('No interests or posts'));
  const token = jwt.sign({}, secret, { algorithm: 'HS256', subject: admin.id, expiresIn: '1h' });
  const ordinaryToken = jwt.sign({}, secret, { algorithm: 'HS256', subject: empty.id, expiresIn: '1h' });
  async function request(path, auth) {
    const response = await fetch(`${origin}${path}`, { headers: auth ? { authorization: `Bearer ${auth}` } : {} });
    return { status: response.status, body: await response.json() };
  }
  async function view(path, { auth, calls = 1, authReads = path.startsWith('/api/admin/') && auth ? 1 : 0 } = {}) {
    const methods = [[User, 'aggregate'], [User, 'findById'], [User, 'findOne'], [User, 'find'], [User, 'countDocuments'], [User, 'distinct'], [Post, 'aggregate'], [Post, 'find'], [Post, 'findOne'], [Post, 'findById'], [Post, 'countDocuments']];
    const spies = methods.map(([model, method]) => t.mock.method(model, method));
    try {
      const response = await request(path, auth);
      assert.equal(spies[0].mock.callCount(), calls);
      assert.equal(spies[1].mock.callCount(), authReads);
      assert.equal(spies[2].mock.callCount(), authReads);
      for (const spy of spies.slice(3)) assert.equal(spy.mock.callCount(), 0);
      return { ...response, pipeline: spies[0].mock.calls[0]?.arguments[0] };
    } finally { for (const spy of spies.reverse()) spy.mock.restore(); }
  }
  function lookupCount(value) {
    if (!value || typeof value !== 'object') return 0;
    return Object.entries(value).reduce((total, [key, nested]) => total + Number(key === '$lookup') + lookupCount(nested), 0);
  }
  const groupPath = '/api/admin/users/by-interest';

  await t.test('interests require a current Admin while public author views ignore credentials', async () => {
    assert.equal((await view(groupPath, { calls: 0 })).status, 401);
    assert.equal((await view(groupPath, { auth: 'invalid', calls: 0, authReads: 0 })).status, 401);
    assert.equal((await view(groupPath, { auth: ordinaryToken, calls: 0 })).status, 403);
    await User.updateOne({ _id: admin._id }, { $set: { role: 'user' } });
    try { assert.equal((await view(groupPath, { auth: token, calls: 0 })).status, 403); }
    finally { await User.updateOne({ _id: admin._id }, { $set: { role: 'admin' } }); }
    for (const auth of [undefined, 'invalid']) {
      const response = await view(`/api/posts/by-user/${empty.id}`, { auth });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { data: [], page: 1, limit: 20, total: 0, totalPages: 0, author: { _id: empty.id, name: empty.name } });
      assert.equal(lookupCount(response.pipeline), 1);
    }
  });

  await t.test('no interests produces a correctly shaped empty page through the static route', async () => {
    const response = await view(groupPath, { auth: token });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { data: [], page: 1, limit: 20, total: 0, totalPages: 0, memberLimit: 20 });
    assert.equal(lookupCount(response.pipeline), 1);
  });

  const [alice, bob, carol] = await User.insertMany([
    input('Alice', [' Chess ', 'chess', 'Reading']), input('Bob', ['chess']), input('Carol', ['music', 'reading']),
  ]);
  const ownPosts = await Post.insertMany(Array.from({ length: 5 }, (_, index) => ({ authorId: alice._id, title: `Post ${index}`, content: `Public ${index}` })));
  await Post.create({ authorId: bob._id, title: 'Other author', content: 'Not Alice' });
  await Note.create({ ownerId: alice._id, title: 'Private note sentinel' });
  let interestPipeline;
  let postPipeline;

  await t.test('groups count memberships once, sort names, page groups and bound safe members', async () => {
    const response = await view(`${groupPath}?limit=2&memberLimit=1`, { auth: token });
    assert.equal(response.status, 200);
    assert.deepEqual({ ...response.body, data: [] }, { data: [], page: 1, limit: 2, total: 3, totalPages: 2, memberLimit: 1 });
    assert.deepEqual(response.body.data, [
      { interest: 'chess', count: 2, users: [{ _id: bob.id, name: bob.name }], hasMoreUsers: true, nextUserCursor: bob.id },
      { interest: 'music', count: 1, users: [{ _id: carol.id, name: carol.name }], hasMoreUsers: false, nextUserCursor: null },
    ]);
    assert.equal(lookupCount(response.pipeline), 1);
    assert.equal(JSON.stringify(response.pipeline).includes('"$push"'), false);
    const branch = response.pipeline.find((stage) => stage.$facet).$facet.data;
    assert.deepEqual(branch.slice(0, 2), [{ $skip: 0 }, { $limit: 2 }]);
    assert.deepEqual(branch[2].$lookup.pipeline.slice(-2), [{ $limit: 2 }, { $project: { _id: 1, name: 1 } }]);
    const second = await view(`${groupPath}?page=2&limit=2`, { auth: token });
    assert.deepEqual(second.body.data.map(({ interest }) => interest), ['reading']);
    const beyond = await view(`${groupPath}?page=9&limit=2`, { auth: token });
    assert.deepEqual(beyond.body, { data: [], page: 9, limit: 2, total: 3, totalPages: 2, memberLimit: 20 });
  });

  await t.test('normalized filtering repeats after unwind and cursors affect members, not counts', async () => {
    const first = await view(`${groupPath}?interest=%20CHESS%20&memberLimit=1`, { auth: token });
    assert.equal(first.status, 200);
    interestPipeline = first.pipeline;
    assert.deepEqual(first.pipeline.slice(0, 3), [{ $match: { interests: 'chess' } }, { $unwind: '$interests' }, { $match: { interests: 'chess' } }]);
    assert.equal(first.body.total, 1);
    assert.deepEqual(first.body.data.map(({ interest }) => interest), ['chess']);
    const next = await view(`${groupPath}?interest=chess&memberLimit=1&afterUserId=${first.body.data[0].nextUserCursor}`, { auth: token });
    assert.deepEqual(next.body.data, [{ interest: 'chess', count: 2, users: [{ _id: alice.id, name: alice.name }], hasMoreUsers: false, nextUserCursor: null }]);
    const exhausted = await view(`${groupPath}?interest=chess&afterUserId=${'0'.repeat(24)}`, { auth: token });
    assert.deepEqual(exhausted.body.data, [{ interest: 'chess', count: 2, users: [], hasMoreUsers: false, nextUserCursor: null }]);
    const absent = await view(`${groupPath}?interest=missing`, { auth: token });
    assert.deepEqual(absent.body, { data: [], page: 1, limit: 20, total: 0, totalPages: 0, memberLimit: 20 });
  });

  await t.test('saved interest limits reject oversized values and keep cursor URLs usable', async () => {
    const interest = 'অ'.repeat(100);
    for (const user of [alice, bob]) {
      const auth = jwt.sign({}, secret, { algorithm: 'HS256', subject: user.id, expiresIn: '1h' });
      for (const [value, status] of [['অ'.repeat(2000), 400], [interest, 200]]) {
        const response = await fetch(`${origin}/api/me`, { method: 'PATCH', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify({ interests: [...user.interests, value] }) });
        assert.equal(response.status, status);
        await response.json();
      }
    }
    const first = await view(`${groupPath}?interest=${encodeURIComponent(interest)}&memberLimit=1`, { auth: token });
    assert.equal(first.status, 200);
    assert.equal(first.body.data[0].hasMoreUsers, true);
    const next = await view(`${groupPath}?interest=${encodeURIComponent(interest)}&memberLimit=1&afterUserId=${first.body.data[0].nextUserCursor}`, { auth: token });
    assert.equal(next.status, 200);
    assert.deepEqual(next.body.data[0].users.map(({ _id }) => _id), [alice.id]);
    assert.equal((await view(`${groupPath}?interest=${'x'.repeat(101)}`, { auth: token, calls: 0 })).status, 400);
  });

  await t.test('one public User pipeline joins only that author and returns safe exact post pages', async () => {
    const response = await view(`/api/posts/by-user/${alice.id}?limit=2`);
    assert.equal(response.status, 200);
    postPipeline = response.pipeline;
    assert.equal(lookupCount(postPipeline), 1);
    assert.ok(postPipeline[0].$match._id instanceof mongoose.Types.ObjectId);
    assert.deepEqual({ ...response.body, data: [] }, { data: [], page: 1, limit: 2, total: 5, totalPages: 3, author: { _id: alice.id, name: alice.name } });
    assert.deepEqual(response.body.data.map(({ _id }) => _id), ownPosts.map(({ id }) => id).reverse().slice(0, 2));
    const all = await view(`/api/posts/by-user/${alice.id}?limit=100000`);
    assert.equal(all.body.limit, 100);
    for (const post of all.body.data) {
      assert.deepEqual(Object.keys(post).sort(), ['_id', 'authorId', 'title', 'content', 'createdAt', 'updatedAt'].sort());
      assert.equal(post.authorId, alice.id);
    }
    assert.equal(JSON.stringify(all.body).includes('Private note sentinel'), false);
    const second = await view(`/api/posts/by-user/${alice.id}?page=2&limit=2`);
    assert.deepEqual(second.body.data.map(({ _id }) => _id), ownPosts.map(({ id }) => id).reverse().slice(2, 4));
    const beyond = await view(`/api/posts/by-user/${alice.id}?page=9&limit=2`);
    assert.deepEqual(beyond.body, { data: [], page: 9, limit: 2, total: 5, totalPages: 3, author: { _id: alice.id, name: alice.name } });
    const missing = await view(`/api/posts/by-user/${new mongoose.Types.ObjectId()}`);
    assert.deepEqual(missing.body, { error: { message: 'User not found' } });
    assert.equal(missing.status, 404);
  });

  await t.test('malformed IDs, cursors, filters and all pagination inputs fail before aggregation', async () => {
    for (const query of ['page=', 'page=0', 'page=abc', 'page=2junk', 'page=1%0A', 'page=1&page=2', 'page[]=1', 'page[value]=1', 'limit=0', 'limit=1.5', 'limit[]=2', 'page=9007199254740992', 'page=9007199254740991&limit=100']) {
      for (const [path, auth] of [[groupPath, token], [`/api/posts/by-user/${alice.id}`, undefined]]) {
        assert.equal((await view(`${path}?${query}`, { auth, calls: 0 })).status, 400);
      }
    }
    for (const query of ['memberLimit=0', 'memberLimit=1.5', 'memberLimit=abc', 'memberLimit=1%0A', 'memberLimit[]=1', 'memberLimit[value]=1', 'memberLimit=1&memberLimit=2', 'memberLimit=9007199254740992', 'interest=', 'interest=%20', 'interest=a&interest=b', 'interest[]=chess', 'interest[value]=chess', `afterUserId=${alice.id}`, 'interest=chess&afterUserId=bad', 'interest=chess&afterUserId=', `interest=chess&afterUserId=${alice.id}%0A`, `interest=chess&afterUserId[]=${alice.id}`, `interest=chess&afterUserId=${alice.id}&afterUserId=${bob.id}`]) {
      assert.equal((await view(`${groupPath}?${query}`, { auth: token, calls: 0 })).status, 400);
    }
    for (const id of ['bad', 'x'.repeat(24), '1'.repeat(12), `${alice.id}%0A`]) {
      assert.equal((await view(`/api/posts/by-user/${id}`, { calls: 0 })).status, 400);
    }
  });

  await t.test('member cursors reach every user beyond a full capped page without duplicates', async () => {
    const users = await User.insertMany(Array.from({ length: 205 }, (_, index) => input(`Member ${index}`, ['cursor-club'])));
    const seen = [];
    let cursor;
    do {
      const response = await view(`${groupPath}?interest=cursor-club&memberLimit=100000${cursor ? `&afterUserId=${cursor}` : ''}`, { auth: token });
      assert.equal(response.status, 200);
      assert.equal(response.body.memberLimit, 100);
      const [group] = response.body.data;
      assert.equal(group.count, 205);
      assert.ok(group.users.length <= 100);
      seen.push(...group.users.map(({ _id }) => _id));
      assert.equal(group.hasMoreUsers, seen.length < 205);
      cursor = group.nextUserCursor;
    } while (cursor);
    assert.deepEqual(seen, users.map(({ id }) => id).reverse());
    assert.equal(new Set(seen).size, 205);
  });

  await t.test('maximum group and member limits produce bounded real result arrays', async () => {
    const inputs = [];
    for (let batch = 0; batch < 5; batch++) {
      const interests = Array.from({ length: 20 }, (_, index) => `bulk-${String(batch * 20 + index).padStart(3, '0')}-${'অ'.repeat(20)}`);
      for (let member = 0; member < 101; member++) inputs.push(input('অ'.repeat(100), interests));
    }
    await User.insertMany(inputs);
    const response = await view(`${groupPath}?limit=100000&memberLimit=100000`, { auth: token });
    assert.equal(response.status, 200);
    assert.equal(response.body.limit, 100);
    assert.equal(response.body.memberLimit, 100);
    assert.equal(response.body.total, 105);
    assert.equal(response.body.data.length, 100);
    for (const group of response.body.data) {
      assert.equal(group.count, 101);
      assert.equal(group.users.length, 100);
      assert.equal(group.hasMoreUsers, true);
      assert.equal(group.nextUserCursor, group.users.at(-1)._id);
      for (const user of group.users) assert.deepEqual(Object.keys(user).sort(), ['_id', 'name']);
    }
    const posts = await Post.insertMany(Array.from({ length: 100 }, () => ({ authorId: empty._id, title: 'অ'.repeat(200), content: 'অ'.repeat(10000) })));
    const postPage = await view(`/api/posts/by-user/${empty.id}?limit=100000`);
    assert.equal(postPage.status, 200);
    assert.equal(postPage.body.data.length, 100);
    assert.equal(postPage.body.total, posts.length);
    assert.ok(mongoose.mongo.BSON.calculateObjectSize(postPage.body) < 16 * 1024 * 1024);
  });

  await t.test('real lookup execution plans expose foreign-index work without new indexes', async () => {
    for (const [name, pipeline] of [['interest', interestPipeline], ['user-posts', postPipeline]]) {
      const plan = await User.aggregate(pipeline).allowDiskUse(true).explain('executionStats');
      const summaries = [];
      function inspect(value) {
        if (!value || typeof value !== 'object') return;
        if (value.$lookup && Array.isArray(value.indexesUsed)) summaries.push({ from: value.$lookup.from, indexesUsed: value.indexesUsed, collectionScans: value.collectionScans, totalDocsExamined: value.totalDocsExamined, totalKeysExamined: value.totalKeysExamined });
        for (const nested of Object.values(value)) inspect(nested);
      }
      inspect(plan);
      assert.equal(summaries.length, 1);
      assert.ok(summaries[0].indexesUsed.length > 0);
      assert.equal(summaries[0].collectionScans, 0);
      console.log(`${name} lookup execution: ${JSON.stringify(summaries[0])}`);
    }
  });

  await t.test('aggregation failures keep internal details private', async () => {
    const failure = t.mock.method(User, 'aggregate', () => { throw new Error('private-aggregation-detail'); });
    try {
      for (const [path, auth] of [[groupPath, token], [`/api/posts/by-user/${alice.id}`, undefined]]) {
        assert.deepEqual(await request(path, auth), { status: 500, body: { error: { message: 'Internal server error' } } });
      }
    } finally { failure.mock.restore(); }
  });
  for (const model of [User, Note, Post]) assert.deepEqual(await model.diffIndexes(), { toDrop: [], toCreate: [] });
});
