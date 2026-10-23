import mongoose from 'mongoose';
import { loadEnv } from '../src/config/env.js';
import { connectDatabase } from '../src/config/database.js';
import { createApplicationIndexes } from '../src/config/indexes.js';

try {
  const env = loadEnv();
  await connectDatabase(env.MONGODB_URI);
  await createApplicationIndexes();
  console.log('Declared indexes created or already present; no indexes dropped.');
} catch {
  console.error('Index creation failed. Check configuration, database permissions and duplicate emails.');
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
