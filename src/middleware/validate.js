import { HttpError } from '../utils/HttpError.js';

export const validate = (schema) => (req, _res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) throw new HttpError(400, 'Invalid request body');
  req.body = result.data;
  next();
};
