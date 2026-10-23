import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxLength: 100 },
  email: { type: String, required: true, trim: true, lowercase: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, required: true, enum: ['user', 'admin'], default: 'user' },
  interests: {
    type: [String],
    default: [],
    set(values) {
      if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
        throw new TypeError('Interests must be an array of strings');
      }
      return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
    },
    validate: {
      validator: (values) => values.length <= 20,
      message: 'At most 20 normalized interests are allowed',
    },
  },
}, { timestamps: true, autoCreate: false, autoIndex: false });

// Login by normalized email; enforce account email uniqueness in MongoDB.
userSchema.index({ email: 1 }, { unique: true });
// Filter by interest and look up members whose interests contain a selected group.
userSchema.index({ interests: 1 });

export const User = mongoose.model('User', userSchema);
