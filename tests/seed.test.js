import assert from 'node:assert/strict';
import { test } from 'node:test';
import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import { User } from '../src/models/user.model.js';
import { Note } from '../src/models/note.model.js';
import { Post } from '../src/models/post.model.js';
import { developmentConfig, seedConfig, seedDatabase, sampleId } from '../scripts/seed.js';
import { collectExplainEvidence, summarizePlan } from '../scripts/explain.js';

const input = {
  NODE_ENV: 'development', MONGODB_URI: 'mongodb://127.0.0.1:27029/secure_notes_dev?replicaSet=notes-dev9',
  JWT_SECRET: 'task8-test-only-secret-at-least-32-characters', FRONTEND_ORIGIN: 'http://localhost:5500', BCRYPT_COST: '4',
  SEED_ADMIN_EMAIL: 'seed-admin@example.com', SEED_ADMIN_PASSWORD: 'task8-explicit-admin-password',
};

test('seed configuration requires an explicit development target and valid Admin credentials', () => {
  assert.equal(seedConfig(input).admin.role, 'admin');
  for (const changes of [{ NODE_ENV: 'production' }, { NODE_ENV: 'test' }, { MONGODB_URI: 'mongodb://127.0.0.1/shared' }]) {
    assert.throws(() => developmentConfig({ ...input, ...changes }), /dedicated secure_notes_dev/);
  }
  for (const changes of [{ SEED_ADMIN_EMAIL: '' }, { SEED_ADMIN_PASSWORD: '' }, { SEED_ADMIN_PASSWORD: 'x'.repeat(73) }]) {
    assert.throws(() => seedConfig({ ...input, ...changes }), /SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD/);
  }
  assert.equal(seedConfig({ ...input, SEED_ADMIN_PASSWORD: 'ক'.repeat(24) }).admin.password.length, 24);
});

test('explain summaries ignore rejected plans and echoed command pipelines', () => {
  const plan = { queryPlanner: { winningPlan: { stage: 'IXSCAN', indexName: 'email_1' }, rejectedPlans: [{ stage: 'COLLSCAN' }] }, executionStats: { nReturned: 1, totalDocsExamined: 1, totalKeysExamined: 1 }, command: { pipeline: [{ $lookup: { from: 'ignored' } }] } };
  assert.deepEqual(summarizePlan(plan), { stages: ['IXSCAN'], indexes: ['email_1'], nReturned: 1, totalDocsExamined: 1, totalKeysExamined: 1, lookups: [] });
});

test('real additive seed, transaction rollback, preserved edits and representative explain evidence', {
  skip: !process.env.TEST_MONGODB_URI, timeout: 60000,
}, async (t) => {
  const uri = new URL(process.env.TEST_MONGODB_URI);
  if (uri.hostname !== '127.0.0.1' || uri.pathname !== '/secure_notes_models_test') throw new Error('Seed tests require the dedicated local test URI');
  uri.pathname = '/secure_notes_seed_test';
  await mongoose.connect(uri.href, { serverSelectionTimeoutMS: 5000, bufferCommands: false });
  const userIds = Array.from({ length: 60 }, (_, index) => sampleId('a', index + 1));
  const config = seedConfig(input);
  t.after(async () => {
    try {
      const admin = await User.findOne({ email: config.admin.email }).select('_id').lean();
      if (admin) userIds.push(admin._id);
      await Note.deleteMany({ ownerId: { $in: userIds } });
      await Post.deleteMany({ authorId: { $in: userIds } });
      await User.deleteMany({ _id: { $in: userIds } });
    } finally { await mongoose.disconnect(); }
  });
  for (const model of [User, Note, Post]) await model.syncIndexes();

  await t.test('a failure after actual child writes rolls back all seed accounts and children', async () => {
    const original = Post.insertMany;
    const failure = t.mock.method(Post, 'insertMany', async function (...args) {
      await original.apply(this, args);
      throw new Error('forced-seed-rollback');
    });
    try { await assert.rejects(seedDatabase(config), /forced-seed-rollback/); }
    finally { failure.mock.restore(); }
    for (const model of [User, Note, Post]) assert.equal(await model.countDocuments({}), 0);
  });

  await t.test('first run creates hashed Admin/sample users, memberships and coordinated children', async () => {
    assert.deepEqual(await seedDatabase(config), { adminCreated: true, usersCreated: 60, notesCreated: 300, postsCreated: 300 });
    assert.equal(await User.countDocuments({}), 61);
    assert.equal(await Note.countDocuments({}), 300);
    assert.equal(await Post.countDocuments({}), 300);
    const admin = await User.findOne({ email: config.admin.email }).select('+passwordHash').lean();
    assert.equal(admin.role, 'admin');
    assert.equal(await bcrypt.compare(config.admin.password, admin.passwordHash), true);
    const owner = await User.findById(sampleId('a', 1)).select('+passwordHash').lean();
    assert.equal(bcrypt.getRounds(owner.passwordHash), 4);
    assert.equal(owner.__v, 1);
    assert.equal(await User.countDocuments({ interests: 'chess' }), 54);
    assert.equal(await User.countDocuments({ interests: [] }), 7);
  });

  await t.test('reruns do not reset credentials, profiles, titles, timestamps or parent versions', async () => {
    const admin = await User.findOne({ email: config.admin.email }).select('+passwordHash').lean();
    const ownerId = sampleId('a', 1);
    await User.updateOne({ _id: ownerId }, { $set: { name: 'Preserved edit' } });
    await Note.updateOne({ _id: sampleId('b', 1) }, { $set: { title: 'Preserved note title' } });
    const before = await User.findById(ownerId).select('+passwordHash').lean();
    assert.deepEqual(await seedDatabase({ ...config, admin: { ...config.admin, password: 'different-explicit-password' } }), { adminCreated: false, usersCreated: 0, notesCreated: 0, postsCreated: 0 });
    assert.deepEqual(await User.findById(ownerId).select('+passwordHash').lean(), before);
    assert.equal((await Note.findById(sampleId('b', 1)).lean()).title, 'Preserved note title');
    assert.equal((await User.findById(admin._id).select('+passwordHash').lean()).passwordHash, admin.passwordHash);
  });

  await t.test('restoring a missing seed child writes its existing parent and remains scoped', async () => {
    await Post.deleteOne({ _id: sampleId('c', 1) });
    assert.deepEqual(await seedDatabase(config), { adminCreated: false, usersCreated: 0, notesCreated: 0, postsCreated: 1 });
    assert.equal((await User.findById(sampleId('a', 1)).lean()).__v, 2);
    assert.equal(await Post.countDocuments({}), 300);
  });

  await t.test('seed refuses account promotion and reserved-ID ownership conflicts', async () => {
    const ownerId = sampleId('a', 1);
    const ordinary = await User.findById(ownerId).lean();
    await assert.rejects(seedDatabase({ ...config, admin: { ...config.admin, email: ordinary.email } }), /refuses to promote/);
    await Post.updateOne({ _id: sampleId('c', 1) }, { $set: { authorId: sampleId('a', 2) } });
    try { await assert.rejects(seedDatabase(config), /Seed ID conflicts/); }
    finally { await Post.updateOne({ _id: sampleId('c', 1) }, { $set: { authorId: ownerId } }); }
    assert.equal((await User.findById(ownerId).lean()).role, 'user');
  });

  await t.test('explain covers reads, exact counts, global grouping and actual foreign lookup work', async () => {
    const report = await collectExplainEvidence();
    assert.equal(report.queries.length, 17);
    assert.deepEqual(report.counts, { users: 61, notes: 300, posts: 300 });
    assert.equal(Object.values(report.indexes).flat().length, 7);
    const query = (name) => report.queries.find((entry) => entry.name === name).summary;
    assert.ok(query('Normalized-email login').indexes.includes('email_1'));
    assert.ok(query('Own notes and Admin owner-filtered notes').indexes.includes('ownerId_1__id_-1'));
    for (const name of ['Current-user profile and Admin user detail', 'Admin user list', 'Admin note detail', 'Admin all-note list', 'Public post list']) {
      assert.ok(query(name).indexes.includes('_id_'), JSON.stringify({ name, summary: query(name) }));
    }
    assert.ok(query('Owner note detail').indexes.some((name) => ['_id_', 'ownerId_1__id_-1'].includes(name)));
    for (const name of ['Filtered interests and members', 'Filtered rare-interest members', 'Cursor-filtered interest members']) {
      assert.equal(query(name).lookups.length, 1);
      assert.ok(query(name).lookups[0].indexesUsed.length > 0);
      assert.ok(query(name).lookups[0].indexesUsed.every((index) => ['_id_', 'interests_1'].includes(index)));
      assert.equal(query(name).lookups[0].collectionScans, 0);
    }
    assert.ok(query('Public author posts').lookups[0].indexesUsed.includes('authorId_1__id_-1'));
    assert.ok(query('Global interests').totalDocsExamined > 0);
    console.log('Representative explain verified: 17 read/count/aggregation plans, 7 total indexes, no hints or new index definitions.');
  });
  for (const model of [User, Note, Post]) assert.deepEqual(await model.diffIndexes(), { toDrop: [], toCreate: [] });
});
