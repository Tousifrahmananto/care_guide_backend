import jwt from 'jsonwebtoken';
import { User } from '../models/user.model.js';
import { HttpError } from '../utils/HttpError.js';

export async function authenticate(req, _res, next) {
  const match = /^Bearer ([^\s]+)$/i.exec(req.get('authorization') || '');
  if (!match) throw new HttpError(401, 'Missing or invalid token');
  let claims;
  try {
    claims = jwt.verify(match[1], req.app.locals.config.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) throw new HttpError(401, 'Missing or invalid token');
    throw error;
  }
  if (!claims || typeof claims !== 'object' || typeof claims.sub !== 'string' || !/^[a-f\d]{24}$/i.test(claims.sub) ||
      !Number.isFinite(claims.exp)) throw new HttpError(401, 'Missing or invalid token');
  const user = await User.findById(claims.sub).select('-__v').lean();
  if (!user) throw new HttpError(401, 'Missing or invalid token');
  req.user = user;
  next();
}
