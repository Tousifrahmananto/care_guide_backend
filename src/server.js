import mongoose from 'mongoose';
import { app } from './app.js';
import { loadEnv } from './config/env.js';
import { connectDatabase } from './config/database.js';
import { createApplicationIndexes, syncDevelopmentIndexes } from './config/indexes.js';

let server;
let stopping = false;

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  try {
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    await mongoose.disconnect();
    process.exitCode = exitCode;
  } catch {
    console.error('Shutdown failed');
    process.exit(1);
  } finally {
    clearTimeout(deadline);
  }
}

try {
  const env = loadEnv();
  app.locals.config = env;
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  await connectDatabase(env.MONGODB_URI);
  console.log('Connected to MongoDB replica set');
  if (env.NODE_ENV === 'development') await syncDevelopmentIndexes(env.NODE_ENV);
  else await createApplicationIndexes();
  server = app.listen(env.PORT);
  server.once('listening', () => console.log(`API listening on port ${env.PORT}`));
  server.once('error', () => {
    console.error('HTTP server failed');
    void shutdown(1);
  });
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
} catch (error) {
  console.error(error.message);
  await mongoose.disconnect();
  process.exitCode = 1;
}
