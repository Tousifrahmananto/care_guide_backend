import mongoose from 'mongoose';
import { connectDatabase } from '../src/config/database.js';
import { User } from '../src/models/user.model.js';
import { Note } from '../src/models/note.model.js';
import { Post } from '../src/models/post.model.js';
import { buildInterestPipeline, buildUserPostsPipeline } from '../src/controllers/aggregations.controller.js';
import { parsePagination } from '../src/utils/pagination.js';
import { developmentConfig } from './seed.js';

export function summarizePlan(plan) {
  const cursor = plan.stages?.find((stage) => stage.$cursor)?.$cursor;
  const execution = plan.executionStats ?? cursor?.executionStats;
  const stages = new Set();
  const indexes = new Set();
  const lookups = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.stage) stages.add(value.stage);
    if (value.indexName) indexes.add(value.indexName);
    if (value.$sort && value.executionTimeMillisEstimate !== undefined) stages.add('$sort');
    if (value.$lookup && Array.isArray(value.indexesUsed)) {
      lookups.push({ from: value.$lookup.from, indexesUsed: value.indexesUsed, collectionScans: value.collectionScans, totalDocsExamined: value.totalDocsExamined, totalKeysExamined: value.totalKeysExamined });
    }
    for (const [key, nested] of Object.entries(value)) {
      if (!['command', 'rejectedPlans', 'allPlansExecution'].includes(key)) visit(nested);
    }
  }
  visit(plan);
  return { stages: [...stages], indexes: [...indexes], nReturned: execution?.nReturned, totalDocsExamined: execution?.totalDocsExamined, totalKeysExamined: execution?.totalKeysExamined, lookups };
}

export async function collectExplainEvidence() {
  const note = await Note.findOne({}).select('_id ownerId').lean();
  if (!note) throw new Error('Explain requires an existing note');
  const owner = await User.findById(note.ownerId).select('email').lean();
  if (!owner) throw new Error('Explain requires the note owner to exist');
  const member = await User.findOne({ 'interests.0': { $exists: true } }).select('interests').sort({ _id: -1 }).lean();
  if (!member) throw new Error('Explain requires a user with an interest');
  const [interest, additionalInterest = interest] = member.interests;
  const pagination = parsePagination({});
  const report = { database: mongoose.connection.name, counts: {}, indexes: {}, queries: [] };
  for (const model of [User, Note, Post]) {
    report.counts[model.collection.name] = await model.countDocuments({}).hint('_id_');
    report.indexes[model.collection.name] = (await model.listIndexes()).map(({ name, key, unique }) => ({ name, key, unique: unique === true }));
  }
  const queries = [
    ['Normalized-email login', User.findOne({ email: owner.email }).select('+passwordHash')],
    ['Current-user profile and Admin user detail', User.findById(owner._id).select('-__v')],
    ['Admin user list', User.find({}).select('-__v').sort({ _id: -1 }).skip(0).limit(20)],
    ['Own notes and Admin owner-filtered notes', Note.find({ ownerId: owner._id }).select('-__v').sort({ _id: -1 }).skip(0).limit(20)],
    ['Owner note detail', Note.findOne({ _id: note._id, ownerId: owner._id }).select('-__v')],
    ['Admin note detail', Note.findById(note._id).select('-__v')],
    ['Admin all-note list', Note.find({}).select('-__v').sort({ _id: -1 }).skip(0).limit(20)],
    ['Public post list', Post.find({}).select('_id authorId title content createdAt updatedAt').sort({ _id: -1 }).skip(0).limit(20)],
    ['Global interests', User.aggregate(buildInterestPipeline({ pagination, memberLimit: 20 })).allowDiskUse(true)],
    ['Filtered interests and members', User.aggregate(buildInterestPipeline({ pagination, memberLimit: 20, interest })).allowDiskUse(true)],
    ['Filtered additional-interest members', User.aggregate(buildInterestPipeline({ pagination, memberLimit: 20, interest: additionalInterest })).allowDiskUse(true)],
    ['Cursor-filtered interest members', User.aggregate(buildInterestPipeline({ pagination, memberLimit: 20, interest, afterUserId: member._id })).allowDiskUse(true)],
    ['Public author posts', User.aggregate(buildUserPostsPipeline(owner._id, pagination))],
  ];
  for (const model of [User, Note, Post]) queries.push([`${model.collection.name} exact global count`, model.aggregate([{ $match: {} }, { $count: 'total' }]).hint('_id_')]);
  queries.push(['Owner-note exact count', Note.aggregate([{ $match: { ownerId: owner._id } }, { $count: 'total' }])]);
  for (const [name, query] of queries) {
    const plan = await query.explain('executionStats');
    report.queries.push({ name, summary: summarizePlan(plan), plan });
  }
  return report;
}

if (import.meta.main) {
  try {
    const env = developmentConfig();
    await connectDatabase(env.MONGODB_URI);
    console.log(JSON.stringify(await collectExplainEvidence(), null, 2));
  } catch {
    console.error('Explain failed. Check the dedicated development target, indexes, an existing note with its owner and a user with interests.');
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
