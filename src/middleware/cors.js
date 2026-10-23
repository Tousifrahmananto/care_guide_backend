import { HttpError } from '../utils/HttpError.js';

export function cors(req, res, next) {
  res.vary('Origin');
  const origin = req.get('Origin');
  if (!origin) return next();
  if (origin !== req.app.locals.config?.FRONTEND_ORIGIN) throw new HttpError(403, 'Origin not allowed');
  res.set('Access-Control-Allow-Origin', origin);
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PATCH, DELETE');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    return res.status(204).end();
  }
  next();
}
