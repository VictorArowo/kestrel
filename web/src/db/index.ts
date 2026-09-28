import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema";

/**
 * SQLite through libSQL. Locally (and on a server) DATABASE_URL is a file, by default
 * data/kestrel.db at the repo root; it can also point at a hosted Turso database, with
 * DATABASE_AUTH_TOKEN.
 */
export const DATABASE_URL = process.env.DATABASE_URL ?? "file:../data/kestrel.db";

type Db = LibSQLDatabase<typeof schema>;
const globalForDb = globalThis as unknown as { db?: Db };

function connect(): Client {
  const client = createClient({ url: DATABASE_URL, authToken: process.env.DATABASE_AUTH_TOKEN });
  if (DATABASE_URL.startsWith("file:")) {
    // WAL lets the app and the paper trading loop read while the other writes; the timeout
    // makes a writer wait for a lock instead of failing.
    void client.executeMultiple("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  }
  return client;
}

function instance(): Db {
  // One client per process, reused across hot reloads in development.
  globalForDb.db ??= drizzle(connect(), { schema });
  return globalForDb.db;
}

/**
 * Connects on first use rather than on import, so `next build` can load every route without a
 * database being there.
 */
export const db = new Proxy({} as Db, {
  get(_, prop) {
    const real = instance();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
export * from "./schema";
