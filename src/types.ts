// Shared contracts across modules. Keep this dependency-free.

export type Platform = "ios" | "android";

/**
 * Build metadata extracted from an uploaded app. Field names are platform-neutral;
 * the per-platform mapping is:
 *   bundleId ← iOS CFBundleIdentifier        / Android package
 *   version  ← iOS CFBundleShortVersionString / Android versionName
 *   build    ← iOS CFBundleVersion            / Android versionCode (coerced to string)
 *   name     ← display name
 */
export interface AppInfo {
  platform: Platform;
  bundleId: string;
  version: string;
  build: string;
  name: string;
}

/** @deprecated kept as an alias to minimize churn in ipa.ts; use AppInfo. */
export type IpaInfo = AppInfo;

/** Persisted per-upload metadata (DATA_DIR/<id>/meta.json). */
export interface AppMeta extends AppInfo {
  /** Epoch ms; the TTL anchor — never use filesystem mtimes. */
  uploadedAt: number;
  originalFilename: string;
  size: number;
}

/** A managed upload token (DATA_DIR/tokens.json). The plaintext secret is never stored. */
export interface Token {
  id: string;
  label: string;
  /** SHA-256 hex of the plaintext secret. */
  hash: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** Token shape safe to expose over the API — no hash, no secret. */
export interface TokenPublic {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}
