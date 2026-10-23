import mongoose from 'mongoose';
import { Post } from '../models/post.model.js';
import { User } from '../models/user.model.js';
import { HttpError } from '../utils/HttpError.js';
import { parsePagination, pageResult } from '../utils/pagination.js';

export async function createPost(req, res) {
  const { title, content } = req.body;
  const post = await mongoose.connection.transaction(async (session) => {
    // This real parent write conflicts with account deletion; a read alone cannot coordinate them.
    const parent = await User.updateOne({ _id: req.user._id }, { $inc: { __v: 1 } }, { session });
    if (parent.matchedCount !== 1) throw new HttpError(401, 'Missing or invalid token');
    const [created] = await Post.create([{ authorId: req.user._id, title, content }], { session });
    return created;
  });
  const { _id, authorId, createdAt, updatedAt } = post;
  res.status(201).json({ data: { _id, authorId, title: post.title, content: post.content, createdAt, updatedAt } });
}

export async function listPosts(req, res) {
  const pagination = parsePagination(req.query);
  const [data, total] = await Promise.all([
    Post.find({}).select('_id authorId title content createdAt updatedAt').sort({ _id: -1 }).skip(pagination.skip).limit(pagination.limit).lean(),
    Post.countDocuments({}),
  ]);
  res.json(pageResult(data, total, pagination));
}
