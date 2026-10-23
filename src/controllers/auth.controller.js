import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { User } from '../models/user.model.js';
import { HttpError } from '../utils/HttpError.js';
import { userView } from '../utils/userView.js';

export async function register(req, res) {
  const { name, email, password, interests } = req.body;
  const passwordHash = await bcrypt.hash(password, req.app.locals.config.BCRYPT_COST);
  let user;
  try {
    user = await User.create({ name, email, passwordHash, interests, role: 'user' });
  } catch (error) {
    if (error.code === 11000) throw new HttpError(409, 'Email already registered');
    throw error;
  }
  res.status(201).json({ data: userView(user) });
}

export async function login(req, res) {
  const { email, password } = req.body;
  const user = await User.findOne({ email }).select('+passwordHash');
  if (!user || !await bcrypt.compare(password, user.passwordHash)) {
    throw new HttpError(401, 'Invalid credentials');
  }
  const { JWT_SECRET, JWT_EXPIRES_IN } = req.app.locals.config;
  const token = jwt.sign({}, JWT_SECRET, {
    algorithm: 'HS256', subject: user.id, expiresIn: JWT_EXPIRES_IN,
  });
  res.json({ token });
}
