import { config } from "dotenv";
import path from "node:path";
import type { NextConfig } from "next";

// Secrets live in the repo-root .env, shared with the Rust engine.
config({ path: path.resolve(process.cwd(), "..", ".env"), quiet: true });

const nextConfig: NextConfig = {};

export default nextConfig;
