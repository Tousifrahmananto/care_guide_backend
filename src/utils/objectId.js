import mongoose from 'mongoose';
import { HttpError } from './HttpError.js';

export function parseObjectId(value) {
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) {
    throw new HttpError(400, 'Invalid ID');
  }
  return new mongoose.Types.ObjectId(value);
}
