import mongoose from 'mongoose';
import { connectDatabase } from '../src/config/database.js';
import { User } from '../src/models/user.model.js';
import { Note } from '../src/models/note.model.js';
import { Post } from '../src/models/post.model.js';
import { buildInterestPipeline, buildUserPostsPipeline } from '../src/controllers/aggregations.controller.js';
import { parsePagination } from '../src/utils/pagination.js';
import { developmentConfig, sampleId } from './seed.js';

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
    if (value.$sort) stages.add('$sort');
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
  const owner = await User.findById(sampleId('a', 1)).select('email').lean();
  if (!owner) throw new Error('Run the development seed before collecting explain evidence');
  const note = await Note.findOne({ ownerId: owner._id }).select('_id').lean();
  if (!note) throw new Error('Seed notes are missing');
  const pagination = parsePagination({});
  const report = { database: mongoose.connection.name, counts: {}, indexes: {}, queries: [] };
  for (const model of [User, Note, Post]) {
    report.counts[model.collection.name] = await model.countDocuments({});
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
    ['Filtered interests and members', User.aggregate(buildInterestPipeline({ pagination, memberLimit: 20, interest: 'chess' })).allowDiskUse(true)],
    ['Filtered rare-interest members', User.aggregate(buildInterestPipeline({ pagination, memberLimit: 20, interest: 'science' })).allowDiskUse(true)],
    ['Cursor-filtered interest members', User.aggregate(buildInterestPipeline({ pagination, memberLimit: 20, interest: 'chess', afterUserId: sampleId('a', 40) })).allowDiskUse(true)],
    ['Public author posts', User.aggregate(buildUserPostsPipeline(owner._id, pagination))],
  ];
  for (const model of [User, Note, Post]) queries.push([`${model.collection.name} exact global count`, model.aggregate([{ $count: 'total' }])]);
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
    console.error('Explain failed. Check the dedicated development target and run the seed first.');
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
