import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePagination, pageResult } from '../src/utils/pagination.js';
import { parseObjectId } from '../src/utils/objectId.js';
import { createNoteSchema, updateNoteSchema } from '../src/utils/noteSchemas.js';

test('pagination defaults, cap, exact totals and empty pages use one contract', () => {
  assert.deepEqual(parsePagination({}), { page: 1, limit: 20, skip: 0 });
  assert.deepEqual(parsePagination({ page: '2', limit: '100000' }), { page: 2, limit: 100, skip: 100 });
  assert.deepEqual(parsePagination({ page: '03', limit: '2' }), { page: 3, limit: 2, skip: 4 });
  assert.deepEqual(pageResult([], 0, parsePagination({})), { data: [], page: 1, limit: 20, total: 0, totalPages: 0 });
  assert.deepEqual(pageResult([], 3, parsePagination({ page: '9', limit: '2' })), { data: [], page: 9, limit: 2, total: 3, totalPages: 2 });
});

test('pagination rejects malformed raw values, unsafe integers and unsafe offsets', () => {
  for (const field of ['page', 'limit']) {
    for (const value of ['0', '-1', '+1', '1.2', '', ' ', '1\n', '1\r', 'abc', '2junk', '1e2', 'Infinity', '9007199254740992', ['1', '2'], { value: '1' }, 2, null]) {
      assert.throws(() => parsePagination({ [field]: value }), { status: 400, message: 'Invalid pagination' });
    }
  }
  assert.throws(() => parsePagination({ page: '9007199254740991', limit: '100' }), { status: 400 });
  assert.deepEqual(parsePagination({ page: '9007199254740991', limit: '1' }), { page: Number.MAX_SAFE_INTEGER, limit: 1, skip: Number.MAX_SAFE_INTEGER - 1 });
});

test('note input and IDs reject coercion, injected fields and mismatched Unicode limits', () => {
  assert.equal(String(parseObjectId('ABCDEF0123456789ABCDEF01')), 'abcdef0123456789abcdef01');
  for (const value of ['bad', 'x'.repeat(24), '', '1'.repeat(12), 'abcdef0123456789abcdef01\n', 123, null, ['abcdef0123456789abcdef01'], { $ne: null }]) {
    assert.throws(() => parseObjectId(value), { status: 400, message: 'Invalid ID' });
  }
  assert.deepEqual(createNoteSchema.parse({ title: ' Note ', ownerId: 'injected', __v: 7 }), { title: 'Note' });
  assert.deepEqual(updateNoteSchema.parse({ content: '', ownerId: 'injected' }), { content: '' });
  assert.equal(createNoteSchema.safeParse({ title: 'x'.repeat(200), content: 'x'.repeat(10000) }).success, true);
  for (const body of [{ title: ' ' }, { title: 7 }, { title: 'x'.repeat(201) }, { title: '😀'.repeat(101) }, { title: 'ok', content: null }, { title: 'ok', content: '😀'.repeat(5001) }]) {
    assert.equal(createNoteSchema.safeParse(body).success, false);
  }
  for (const body of [{}, { ownerId: 'injected' }, { title: null }]) assert.equal(updateNoteSchema.safeParse(body).success, false);
});
