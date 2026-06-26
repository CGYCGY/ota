// Shared contracts across modules. Keep this dependency-free.

/** Metadata extracted from an IPA's embedded Info.plist. */
export interface IpaInfo {
  bundleId: string;
  version: string;
  build: string;
  name: string;
}

/** Persisted per-upload metadata (DATA_DIR/<id>/meta.json). */
export interface AppMeta extends IpaInfo {
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
  revoked: boolean;
}

/** Token shape safe to expose over the API — no hash, no secret. */
export interface TokenPublic {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
}
