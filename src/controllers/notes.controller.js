import mongoose from 'mongoose';
import { Note } from '../models/note.model.js';
import { User } from '../models/user.model.js';
import { HttpError } from '../utils/HttpError.js';
import { parseObjectId } from '../utils/objectId.js';
import { parsePagination, pageResult } from '../utils/pagination.js';

export async function createNote(req, res) {
  const { title, content } = req.body;
  const note = await mongoose.connection.transaction(async (session) => {
    // This real parent write conflicts with account deletion; a read alone cannot coordinate them.
    const parent = await User.updateOne({ _id: req.user._id }, { $inc: { __v: 1 } }, { session });
    if (parent.matchedCount !== 1) throw new HttpError(401, 'Missing or invalid token');
    const [created] = await Note.create([{ ownerId: req.user._id, title, content }], { session });
    return created;
  });
  const { _id, ownerId, createdAt, updatedAt } = note;
  res.status(201).json({ data: { _id, ownerId, title: note.title, content: note.content, createdAt, updatedAt } });
}

async function sendNotes(res, query, filter) {
  const pagination = parsePagination(query);
  const count = Note.countDocuments(filter);
  if (filter.ownerId === undefined) count.hint('_id_');
  const [data, total] = await Promise.all([
    Note.find(filter).select('-__v').sort({ _id: -1 }).skip(pagination.skip).limit(pagination.limit).lean(),
    count,
  ]);
  res.json(pageResult(data, total, pagination));
}

export function listOwnNotes(req, res) {
  return sendNotes(res, req.query, { ownerId: req.user._id });
}

export function listAdminNotes(req, res) {
  const filter = req.query.ownerId === undefined ? {} : { ownerId: parseObjectId(req.query.ownerId) };
  return sendNotes(res, req.query, filter);
}

export async function getNote(req, res) {
  const note = await Note.findOne(req.noteReadFilter).select('-__v').lean();
  if (!note) throw new HttpError(404, 'Note not found');
  res.json({ data: note });
}

export async function updateNote(req, res) {
  const note = await Note.findOneAndUpdate({ _id: parseObjectId(req.params.id), ownerId: req.user._id }, {
    $set: req.body,
  }, { returnDocument: 'after', runValidators: true }).select('-__v').lean();
  if (!note) throw new HttpError(404, 'Note not found');
  res.json({ data: note });
}

export async function deleteNote(req, res) {
  const result = await Note.deleteOne({ _id: parseObjectId(req.params.id), ownerId: req.user._id });
  if (result.deletedCount !== 1) throw new HttpError(404, 'Note not found');
  res.status(204).end();
}
