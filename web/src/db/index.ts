import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { sql?: postgres.Sql };

// Reuse one connection pool across hot reloads in development.
// prepare: false keeps it working behind transaction-mode poolers like Neon's.
const sql = globalForDb.sql ?? postgres(process.env.DATABASE_URL!, { max: 10, prepare: false });
if (process.env.NODE_ENV !== "production") globalForDb.sql = sql;

export const db = drizzle(sql, { schema });
export * from "./schema";
