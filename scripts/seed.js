import { randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import { loadEnv } from '../src/config/env.js';
import { connectDatabase } from '../src/config/database.js';
import { syncDevelopmentIndexes } from '../src/config/indexes.js';
import { adminCreateSchema } from '../src/utils/userSchemas.js';
import { User } from '../src/models/user.model.js';
import { Note } from '../src/models/note.model.js';
import { Post } from '../src/models/post.model.js';

export function developmentConfig(source = process.env) {
  const env = loadEnv(source);
  if (env.NODE_ENV !== 'development' || new URL(env.MONGODB_URI).pathname !== '/secure_notes_dev') {
    throw new Error('Seed and explain commands require development and the dedicated secure_notes_dev database');
  }
  return env;
}

export function seedConfig(source = process.env) {
  const env = developmentConfig(source);
  const parsed = adminCreateSchema.safeParse({ name: 'Assessment Admin', email: source.SEED_ADMIN_EMAIL, password: source.SEED_ADMIN_PASSWORD, role: 'admin' });
  if (!parsed.success) throw new Error('Valid SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required');
  return { env, admin: parsed.data, bcryptCost: env.BCRYPT_COST };
}

export function sampleId(kind, index) {
  return new mongoose.Types.ObjectId(`650000000000${kind}${index.toString(16).padStart(11, '0')}`);
}

async function missingRecords(model, documents, identity, session) {
  const existing = await model.find({ _id: { $in: documents.map(({ _id }) => _id) } }).select(`_id ${identity}`).session(session).lean();
  const byId = new Map(existing.map((document) => [String(document._id), document]));
  return documents.filter((document) => {
    const found = byId.get(String(document._id));
    if (found && String(found[identity]) !== String(document[identity])) throw new Error('Seed ID conflicts with an existing record');
    return !found;
  });
}

export async function seedDatabase({ admin, bcryptCost }) {
  const existingAdmin = await User.findOne({ email: admin.email }).select('role').lean();
  if (existingAdmin && existingAdmin.role !== 'admin') throw new Error('Seed refuses to promote an existing ordinary account');
  const passwordHash = existingAdmin ? undefined : await bcrypt.hash(admin.password, bcryptCost);
  const users = [];
  const notes = [];
  const posts = [];
  const interests = ['reading', 'music', 'coding', 'travel', 'art', 'sports', 'science'];
  for (let index = 0; index < 60; index++) {
    const _id = sampleId('a', index + 1);
    users.push({ _id, name: `Sample user ${index + 1}`, email: `sample-${index + 1}@secure-notes.test`, role: 'user', interests: index % 10 === 9 ? [] : ['chess', interests[index % 7], interests[(index + 1) % 7]] });
    for (let child = 0; child < 5; child++) {
      const sequence = index * 5 + child + 1;
      notes.push({ _id: sampleId('b', sequence), ownerId: _id, title: `Sample private note ${sequence}`, content: 'Development-only private note for permission and query-plan checks.' });
      posts.push({ _id: sampleId('c', sequence), authorId: _id, title: `Sample public post ${sequence}`, content: 'Development-only public post for aggregation and pagination checks.' });
    }
  }
  for (const user of await missingRecords(User, users, 'email')) {
    user.passwordHash = await bcrypt.hash(randomBytes(32).toString('base64url'), bcryptCost);
  }
  return mongoose.connection.transaction(async (session) => {
    const currentAdmin = await User.findOne({ email: admin.email }).session(session).lean();
    if (currentAdmin && currentAdmin.role !== 'admin') throw new Error('Seed refuses to promote an existing ordinary account');
    if (!currentAdmin) await User.create([{ name: admin.name, email: admin.email, passwordHash, role: 'admin', interests: [] }], { session });
    const newUsers = await missingRecords(User, users, 'email', session);
    const newNotes = await missingRecords(Note, notes, 'ownerId', session);
    const newPosts = await missingRecords(Post, posts, 'authorId', session);
    if (newUsers.length) await User.insertMany(newUsers, { session, ordered: true });
    const parents = [...new Set([...newNotes.map(({ ownerId }) => String(ownerId)), ...newPosts.map(({ authorId }) => String(authorId))])].sort();
    for (const _id of parents) {
      const parent = await User.updateOne({ _id }, { $inc: { __v: 1 } }, { session });
      if (parent.matchedCount !== 1) throw new Error('Seed parent disappeared; retry the command');
    }
    if (newNotes.length) await Note.insertMany(newNotes, { session, ordered: true });
    if (newPosts.length) await Post.insertMany(newPosts, { session, ordered: true });
    return { adminCreated: !currentAdmin, usersCreated: newUsers.length, notesCreated: newNotes.length, postsCreated: newPosts.length };
  });
}

if (import.meta.main) {
  try {
    const config = seedConfig();
    await connectDatabase(config.env.MONGODB_URI);
    await syncDevelopmentIndexes(config.env.NODE_ENV);
    console.log('Preparing sample credentials and applying the additive development seed.');
    console.log(JSON.stringify(await seedDatabase(config), null, 2));
  } catch {
    console.error('Seed failed. Check the dedicated development target, explicit Admin credentials and possible seed-ID conflicts.');
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
