import mongoose from 'mongoose';

const postSchema = new mongoose.Schema({
  authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true, trim: true, maxLength: 200 },
  content: { type: String, required: true, maxLength: 10000 },
}, { timestamps: true, autoCreate: false, autoIndex: false });

// Look up one author's posts by descending ID; the authorId prefix also serves cascade cleanup.
postSchema.index({ authorId: 1, _id: -1 });

export const Post = mongoose.model('Post', postSchema);
