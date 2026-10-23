import mongoose from 'mongoose';
import { User } from '../models/user.model.js';
import { Note } from '../models/note.model.js';
import { Post } from '../models/post.model.js';

const models = [User, Note, Post];

export async function createApplicationIndexes() {
  for (const model of models) await model.createIndexes();
}

export async function syncDevelopmentIndexes(environment) {
  if (environment !== 'development') return;
  if (mongoose.connection.name !== 'secure_notes_dev') {
    throw new Error('Development index sync requires the dedicated secure_notes_dev database');
  }
  for (const model of models) {
    await model.syncIndexes();
  }
}
