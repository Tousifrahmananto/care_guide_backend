import assert from 'node:assert/strict';
import { test } from 'node:test';
import mongoose from 'mongoose';
import { User } from '../src/models/user.model.js';
import { Note } from '../src/models/note.model.js';
import { Post } from '../src/models/post.model.js';
import { syncDevelopmentIndexes } from '../src/config/indexes.js';

const userInput = { name: ' Ada ', email: ' ADA@Example.com ', passwordHash: 'test-only-hash' };
const ownerId = new mongoose.Types.ObjectId();
const definitions = [
  [User, [[{ email: 1 }, true], [{ interests: 1 }, false]]],
  [Note, [[{ ownerId: 1, _id: -1 }, false]]],
  [Post, [[{ authorId: 1, _id: -1 }, false]]],
];

test('schemas declare only the four query-driven custom indexes', () => {
  for (const [model, expected] of definitions) {
    const declared = model.schema.indexes().map(([key, options]) => [key, options.unique === true]);
    assert.deepEqual(declared, expected);
    model.schema.eachPath((_name, path) => {
      assert.equal(path.options.index, undefined);
      assert.equal(path.options.unique, undefined);
    });
    assert.equal(model.schema.options.timestamps, true);
    assert.equal(model.schema.options.versionKey, '__v');
    assert.equal(model.schema.options.autoIndex, false);
    assert.equal(model.schema.options.autoCreate, false);
  }
  assert.equal(User.collection.name, 'users');
  assert.equal(Note.collection.name, 'notes');
  assert.equal(Post.collection.name, 'posts');
  assert.equal(User.schema.path('passwordHash').options.select, false);
});

test('user normalization keeps defaults and at most twenty distinct interests', async () => {
  const user = new User({ ...userInput, interests: [' Music ', 'music', '', '  ', 'CODING'] });
  await user.validate();
  assert.equal(user.name, 'Ada');
  assert.equal(user.email, 'ada@example.com');
  assert.equal(user.role, 'user');
  assert.deepEqual([...user.interests], ['music', 'coding']);
  assert.deepEqual([...new User(userInput).interests], []);
  const repeated = new User({ ...userInput, interests: Array(21).fill(' SAME ') });
  await repeated.validate();
  assert.deepEqual([...repeated.interests], ['same']);
  await new User({ ...userInput, interests: Array.from({ length: 20 }, (_, i) => `tag-${i}`) }).validate();
});

test('invalid user fields and malformed interest inputs fail model validation', async () => {
  for (const changes of [
    { name: '  ' }, { name: 'x'.repeat(101) }, { email: '' }, { passwordHash: '' },
    { role: 'owner' }, { role: null }, { interests: 'music' }, { interests: null },
    { interests: ['music', 7] }, { interests: [null] }, { interests: [{}] },
    { interests: Array.from({ length: 21 }, (_, i) => `tag-${i}`) },
  ]) {
    await assert.rejects(new User({ ...userInput, ...changes }).validate(), mongoose.Error.ValidationError);
  }
});

test('note and post schemas enforce their different content requirements', async () => {
  const note = new Note({ ownerId, title: ' Note ' });
  await note.validate();
  assert.equal(note.title, 'Note');
  assert.equal(note.content, '');
  await new Post({ authorId: ownerId, title: 'Post', content: ' ' }).validate();
  for (const [Model, parentField] of [[Note, 'ownerId'], [Post, 'authorId']]) {
    const base = { [parentField]: ownerId, title: 'Title', content: 'body' };
    await new Model({ ...base, title: 'x'.repeat(200), content: 'x'.repeat(10000) }).validate();
    for (const changes of [
      { [parentField]: undefined }, { [parentField]: 'bad-id' }, { title: '  ' },
      { title: 'x'.repeat(201) }, { content: 'x'.repeat(10001) },
    ]) {
      await assert.rejects(new Model({ ...base, ...changes }).validate(), mongoose.Error.ValidationError);
    }
  }
  await assert.rejects(new Post({ authorId: ownerId, title: 'Post' }).validate(), /content/);
  await assert.rejects(new Post({ authorId: ownerId, title: 'Post', content: '' }).validate(), /content/);
});

test('index synchronization is disabled outside development and rejects another database', async () => {
  await syncDevelopmentIndexes('production');
  await syncDevelopmentIndexes('test');
  await assert.rejects(syncDevelopmentIndexes('development'), /dedicated secure_notes_dev/);
});

test('real MongoDB indexes, uniqueness, safe selection and stored references', {
  skip: !process.env.TEST_MONGODB_URI,
  timeout: 30000,
}, async (t) => {
  const uri = new URL(process.env.TEST_MONGODB_URI);
  if (uri.hostname !== '127.0.0.1' || uri.pathname !== '/secure_notes_models_test') {
    throw new Error('Model integration tests require the dedicated local secure_notes_models_test database');
  }
  await mongoose.connect(uri.href, { serverSelectionTimeoutMS: 5000, bufferCommands: false });
  const userIds = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
  t.after(async () => {
    try {
      await Note.deleteMany({ ownerId: { $in: userIds } });
      await Post.deleteMany({ authorId: { $in: userIds } });
      await User.deleteMany({ _id: { $in: userIds } });
    } finally {
      await mongoose.disconnect();
    }
  });

  for (const [model, expected] of definitions) {
    await model.syncIndexes();
    const indexes = await model.listIndexes();
    assert.deepEqual(indexes.map(({ key, unique }) => [key, unique === true]), [[{ _id: 1 }, false], ...expected]);
    assert.deepEqual(await model.diffIndexes(), { toDrop: [], toCreate: [] });
    assert.deepEqual(await model.syncIndexes(), []);
    assert.deepEqual(await model.diffIndexes(), { toDrop: [], toCreate: [] });
    console.log(`${model.collection.name}: ${indexes.map(({ name }) => name).join(', ')}; repeat sync has no changes`);
  }

  const email = `task2-${userIds[0]}@example.com`;
  const saved = await User.create({ ...userInput, _id: userIds[0], email, interests: [' MUSIC ', 'music'] });
  assert.ok(saved.createdAt instanceof Date);
  assert.ok(saved.updatedAt instanceof Date);
  assert.equal(saved.__v, 0);
  await assert.rejects(User.create({ ...userInput, _id: userIds[1], email: ` ${email.toUpperCase()} ` }), { code: 11000 });
  const safe = await User.findById(saved._id).lean();
  assert.equal(safe.passwordHash, undefined);
  const credential = await User.findById(saved._id).select('+passwordHash').lean();
  assert.equal(credential.passwordHash, userInput.passwordHash);
  assert.equal((await User.findOne({ email: ` ${email.toUpperCase()} ` })).id, saved.id);
  const members = await User.find({ interests: 'music', _id: saved._id }).select('_id').lean();
  assert.equal(members.length, 1);
  await User.updateOne({ _id: saved._id }, { $set: { interests: [' CODE ', 'code', ' '] } }, { runValidators: true });
  assert.deepEqual((await User.findById(saved._id).lean()).interests, ['code']);

  for (const [Model, parentField] of [[Note, 'ownerId'], [Post, 'authorId']]) {
    const first = await Model.create({ [parentField]: saved._id, title: ' First ', content: 'body' });
    const second = await Model.create({ [parentField]: saved._id, title: 'Second', content: 'body' });
    const listed = await Model.find({ [parentField]: saved._id }).sort({ _id: -1 }).limit(2).lean();
    assert.deepEqual(listed.map(({ _id }) => String(_id)), [String(second._id), String(first._id)]);
    assert.equal(listed[1].title, 'First');
    assert.ok(listed[0].createdAt instanceof Date);
  }
});
