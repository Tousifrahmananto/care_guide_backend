import { HttpError } from './HttpError.js';

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new HttpError(400, 'Invalid pagination');
  }
  return Number(value);
}

export function parsePagination(query) {
  const page = positiveInteger(query.page, 1);
  const limit = Math.min(positiveInteger(query.limit, 20), 100);
  const skip = (page - 1) * limit;
  if (!Number.isSafeInteger(skip)) throw new HttpError(400, 'Invalid pagination');
  return { page, limit, skip };
}

export function pageResult(data, total, { page, limit }) {
  return { data, page, limit, total, totalPages: Math.ceil(total / limit) };
}
