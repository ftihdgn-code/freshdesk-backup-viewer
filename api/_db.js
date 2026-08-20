import { MongoClient } from 'mongodb';

let cachedClient = null;

export async function getDb() {
  if (!cachedClient) {
    const client = new MongoClient(process.env.MONGO_URI);
    try {
      await client.connect();
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    }
    cachedClient = client;
  }
  return cachedClient.db();
}
