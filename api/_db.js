import { MongoClient } from 'mongodb';

let cachedClient = null;

export async function getDb() {
  if (!cachedClient) {
    cachedClient = new MongoClient(process.env.MONGO_URI);
    await cachedClient.connect();
  }
  return cachedClient.db();
}
