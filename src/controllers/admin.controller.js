import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import { User } from '../models/user.model.js';
import { Note } from '../models/note.model.js';
import { Post } from '../models/post.model.js';
import { authorizeAdminMutation } from '../middleware/adminGuard.js';
import { HttpError } from '../utils/HttpError.js';
import { parseObjectId } from '../utils/objectId.js';
import { parsePagination, pageResult } from '../utils/pagination.js';
import { userView } from '../utils/userView.js';

export async function createUser(req, res) {
  const { name, email, password, interests, role } = req.body;
  const passwordHash = await bcrypt.hash(password, req.app.locals.config.BCRYPT_COST);
  const user = await mongoose.connection.transaction(async (session) => {
    await authorizeAdminMutation(req.user._id, session);
    const [created] = await User.create([{ name, email, passwordHash, interests, role }], { session });
    return created;
  });
  res.status(201).json({ data: userView(user) });
}

export async function listUsers(req, res) {
  const pagination = parsePagination(req.query);
  const [users, total] = await Promise.all([
    User.find().select('-__v').sort({ _id: -1 }).skip(pagination.skip).limit(pagination.limit).lean(),
    User.countDocuments(),
  ]);
  res.json(pageResult(users.map(userView), total, pagination));
}

export async function getUser(req, res) {
  const user = await User.findById(parseObjectId(req.params.id)).lean();
  if (!user) throw new HttpError(404, 'User not found');
  res.json({ data: userView(user) });
}

export async function updateUser(req, res) {
  const { password, ...changes } = req.body;
  if (password !== undefined) changes.passwordHash = await bcrypt.hash(password, req.app.locals.config.BCRYPT_COST);
  const user = await mongoose.connection.transaction(async (session) => {
    await authorizeAdminMutation(req.user._id, session, req.targetUserId);
    return User.findOneAndUpdate({ _id: req.targetUserId }, { $set: changes }, {
      session, returnDocument: 'after', runValidators: true,
    }).lean();
  });
  res.json({ data: userView(user) });
}

export async function deleteUser(req, res) {
  await mongoose.connection.transaction(async (session) => {
    await authorizeAdminMutation(req.user._id, session, req.targetUserId);
    await User.deleteOne({ _id: req.targetUserId }, { session });
    await Note.deleteMany({ ownerId: req.targetUserId }, { session });
    await Post.deleteMany({ authorId: req.targetUserId }, { session });
  });
  res.status(204).end();
}
