import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: "../.env", quiet: true });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "turso",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "file:../data/kestrel.db",
    authToken: process.env.DATABASE_AUTH_TOKEN,
  },
});
