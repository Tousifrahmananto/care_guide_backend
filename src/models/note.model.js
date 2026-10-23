import mongoose from 'mongoose';

const noteSchema = new mongoose.Schema({
  ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true, trim: true, maxLength: 200 },
  content: { type: String, default: '', maxLength: 10000 },
}, { timestamps: true, autoCreate: false, autoIndex: false });

// List one owner's notes by descending ID; the ownerId prefix also serves cascade cleanup.
noteSchema.index({ ownerId: 1, _id: -1 });

export const Note = mongoose.model('Note', noteSchema);
