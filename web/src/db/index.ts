import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

/**
 * SQLite through libSQL. Locally (and on a server) DATABASE_URL is a file, by default
 * data/kestrel.db at the repo root; it can also point at a hosted Turso database, with
 * DATABASE_AUTH_TOKEN.
 */
export const DATABASE_URL = process.env.DATABASE_URL ?? "file:../data/kestrel.db";

const globalForDb = globalThis as unknown as { client?: Client };

function connect(): Client {
  const client = createClient({ url: DATABASE_URL, authToken: process.env.DATABASE_AUTH_TOKEN });
  if (DATABASE_URL.startsWith("file:")) {
    // WAL lets the app and the paper trading loop read while the other writes; the timeout
    // makes a writer wait for a lock instead of failing.
    void client.executeMultiple("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  }
  return client;
}

// Reuse one client across hot reloads in development.
const client = globalForDb.client ?? connect();
if (process.env.NODE_ENV !== "production") globalForDb.client = client;

export const db = drizzle(client, { schema });
export * from "./schema";
