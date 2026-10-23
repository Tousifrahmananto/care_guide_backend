import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('model tests reject remote or wrong database targets before connecting', () => {
  const script = "import mongoose from 'mongoose'; mongoose.connect = async () => { throw new Error('Unexpected database connection'); }; await import('./tests/models.test.js');";
  for (const uri of ['mongodb://blocked.invalid/secure_notes_models_test', 'mongodb+srv://blocked.invalid/secure_notes_models_test', 'mongodb://127.0.0.1/wrong_database']) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('../', import.meta.url), env: { ...process.env, TEST_MONGODB_URI: uri }, encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    const output = child.stdout + child.stderr;
    assert.equal(child.status, 1);
    assert.match(output, /require the dedicated local secure_notes_models_test/);
    assert.doesNotMatch(output, /Unexpected database connection/);
  }
});
