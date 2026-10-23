import assert from 'node:assert/strict';
import { test } from 'node:test';
import { User } from '../src/models/user.model.js';
import { registerSchema, profileSchema, adminCreateSchema, adminUpdateSchema } from '../src/utils/userSchemas.js';

const fields = { name: 'Interest fixture', email: 'interests@example.com', password: 'test-only-password' };
const schemas = [registerSchema, profileSchema, adminCreateSchema, adminUpdateSchema];

test('every account input and the model cap interests after normalization', async () => {
  for (const interest of ['x'.repeat(100), 'অ'.repeat(100), '😀'.repeat(50), 'İ'.repeat(50), ` ${'X'.repeat(100)} `]) {
    for (const schema of schemas) assert.equal(schema.safeParse({ ...fields, interests: [interest] }).success, true);
    const user = new User({ ...fields, passwordHash: 'unused-verifier', interests: [interest] });
    await user.validate();
    assert.equal(user.interests[0], interest.trim().toLowerCase());
    assert.equal(user.interests[0].length, 100);
  }
  for (const interest of ['x'.repeat(101), 'অ'.repeat(101), '😀'.repeat(51), 'İ'.repeat(51)]) {
    for (const schema of schemas) assert.equal(schema.safeParse({ ...fields, interests: [interest] }).success, false);
    await assert.rejects(new User({ ...fields, passwordHash: 'unused-verifier', interests: [interest] }).validate(), /100 UTF-16 units/);
  }
});
