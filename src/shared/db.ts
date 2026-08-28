import { MongoClient, type Collection, type Db } from "mongodb";
import type { StoredPayment } from "./schema.js";
export const MONGODB_URI =
  process.env.MONGODB_URI ?? "mongodb://localhost:27020/?directConnection=true";
export const DB_NAME = process.env.DB_NAME ?? "dwp_payments";
export const COLLECTION_NAME = "benefitPayments";

let client: MongoClient | undefined;

export async function getDb(): Promise<Db> {
  if (!client) {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
  }
  return client.db(DB_NAME);
}

export async function getPayments(): Promise<Collection<StoredPayment>> {
  const db = await getDb();
  return db.collection<StoredPayment>(COLLECTION_NAME);
}

export async function closeDb(): Promise<void> {
  await client?.close();
  client = undefined;
}
