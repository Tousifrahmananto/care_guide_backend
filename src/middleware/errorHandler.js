import { HttpError } from '../utils/HttpError.js';

export function errorHandler(error, _req, res, next) {
  if (res.headersSent) return next(error);

  let status = 500;
  let message = 'Internal server error';
  if (error instanceof HttpError && Number.isInteger(error.status) && error.status >= 400 && error.status < 600) {
    status = error.status;
    if (status < 500) message = error.message;
  } else if (error?.code === 11000) {
    status = 409;
    message = 'Email already registered';
  } else if (error?.type === 'entity.parse.failed') {
    status = 400;
    message = 'Invalid JSON body';
  } else if (error?.type === 'entity.too.large') {
    status = 413;
    message = 'Request body too large';
  }

  res.status(status).json({ error: { message } });
}
