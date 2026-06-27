// Admin-managed upload tokens. Secrets are hashed at rest (SHA-256): a DB/file
// leak must not yield usable tokens, and we only ever need to match, not recover.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config";
import type { Token, TokenPublic } from "./types";

const tokensPath = () => path.join(config.dataDir, "tokens.json");

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function toPublic(t: Token): TokenPublic {
  return {
    id: t.id,
    label: t.label,
    createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt,
    revoked: t.revoked,
  };
}

async function readTokens(): Promise<Token[]> {
  try {
    const raw = await fs.readFile(tokensPath(), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Token[]) : [];
  } catch {
    // Missing file (or unreadable/corrupt) → behave as empty set.
    return [];
  }
}

async function writeTokens(tokens: Token[]): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
  // Atomic publish: write a sibling temp file then rename, so a crash mid-write
  // can never leave a partial tokens.json (rename is atomic on the same fs).
  const tmp = path.join(config.dataDir, `tokens.json.${randomBytes(8).toString("hex")}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(tokens, null, 2));
  await fs.rename(tmp, tokensPath());
}

export async function listTokens(): Promise<TokenPublic[]> {
  const tokens = await readTokens();
  // Legacy cleanup: older builds soft-revoked (kept a revoked:true row). Revoke
  // now deletes outright, so purge any leftover revoked records on read.
  const live = tokens.filter((t) => !t.revoked);
  if (live.length !== tokens.length) await writeTokens(live);
  return live.map(toPublic);
}

export async function createToken(label: string): Promise<{ token: TokenPublic; secret: string }> {
  if (!label || !label.trim()) throw new Error("token label is required");

  const secret = "ota_" + randomBytes(32).toString("base64url");
  const token: Token = {
    id: "tok_" + randomBytes(4).toString("hex"),
    label,
    hash: sha256Hex(secret),
    createdAt: Date.now(),
    lastUsedAt: null,
    revoked: false,
  };

  const tokens = await readTokens();
  tokens.push(token);
  await writeTokens(tokens);

  // Plaintext secret is returned exactly once; it is never persisted.
  return { token: toPublic(token), secret };
}

// Revoking a token deletes it outright: the hash is useless once gone, and we
// keep no audit trail. The UI flips the row to "revoked" client-side for the
// moment, but a refresh re-reads storage and the row is gone.
export async function deleteToken(id: string): Promise<boolean> {
  const tokens = await readTokens();
  const next = tokens.filter((x) => x.id !== id);
  if (next.length === tokens.length) return false;
  await writeTokens(next);
  return true;
}

export async function validateToken(presentedSecret: string): Promise<Token | null> {
  const presentedHash = sha256Hex(presentedSecret);
  const presentedBuf = Buffer.from(presentedHash, "hex");

  const tokens = await readTokens();
  for (const t of tokens) {
    if (t.revoked) continue;
    const storedBuf = Buffer.from(t.hash, "hex");
    // Length guard first: timingSafeEqual throws on unequal lengths, and an
    // early length-mismatch reject leaks nothing here (all hashes are 32 bytes).
    if (storedBuf.length !== presentedBuf.length) continue;
    if (timingSafeEqual(storedBuf, presentedBuf)) {
      t.lastUsedAt = Date.now();
      await writeTokens(tokens);
      return t;
    }
  }
  return null;
}
