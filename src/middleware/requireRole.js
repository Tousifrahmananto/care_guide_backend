import { HttpError } from '../utils/HttpError.js';

export const requireRole = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.user?.role)) throw new HttpError(403, 'Forbidden');
  next();
};
