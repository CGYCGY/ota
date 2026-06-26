// Centralized env-var config. Reads once at startup; fail fast on missing required vars.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got: ${v}`);
  return n;
}

export const config = {
  /** e.g. https://install.example.com — no trailing slash. Used to build absolute manifest/IPA URLs. */
  publicBaseUrl: required("PUBLIC_BASE_URL").replace(/\/+$/, ""),
  dataDir: process.env.DATA_DIR ?? "/data",
  ttlHours: num("TTL_HOURS", 24),
  port: num("PORT", 3000),
  maxUploadMb: num("MAX_UPLOAD_MB", 300),
  adminPassword: required("ADMIN_PASSWORD"),
  sessionSecret: required("SESSION_SECRET"),
  sessionTtlHours: num("SESSION_TTL_HOURS", 168),
};

export type Config = typeof config;
