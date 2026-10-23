import mongoose from 'mongoose';

export async function connectDatabase(uri) {
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, bufferCommands: false });
    const db = mongoose.connection.db;
    const { versionArray } = await db.admin().command({ buildInfo: 1 });
    const { setName, isWritablePrimary } = await db.admin().command({ hello: 1 });
    if (![8, 9].includes(versionArray[0]) || versionArray[1] !== 0 || !setName || !isWritablePrimary) {
      throw new Error('Unsupported database deployment');
    }
    return mongoose.connection;
  } catch {
    await mongoose.disconnect();
    throw new Error('MongoDB connection failed; check the URI and MongoDB 8.0/9.0 replica set.');
  }
}
