// Runs once when the server starts. In production the container applies any pending database
// migrations before serving, so a deploy never runs new code against an old schema.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.KESTREL_MIGRATE_ON_START !== "1") return;
  const { migrate } = await import("drizzle-orm/libsql/migrator");
  const { db } = await import("@/db");
  await migrate(db, { migrationsFolder: process.env.KESTREL_MIGRATIONS_DIR ?? "drizzle" });
  console.log("database migrations applied");
}
