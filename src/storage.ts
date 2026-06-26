// Per-upload storage layout + TTL sweep. Layout: DATA_DIR/<id>/{app.ipa, manifest.plist, icon.png?, meta.json}.

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config";
import { buildManifest } from "./manifest";
import type { IpaInfo, AppMeta } from "./types";

// Security boundary: ids land in filesystem paths, so anything not matching this
// is treated as not-found rather than joined into a path (blocks ../ traversal).
const ID_RE = /^[a-f0-9]{12,64}$/;

function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

export function newId(): string {
  // 16 CSPRNG bytes -> 32 hex chars; unguessable upload tokens.
  return randomBytes(16).toString("hex");
}

export function uploadDir(id: string): string {
  return path.join(config.dataDir, id);
}

export function ipaPath(id: string): string {
  return path.join(uploadDir(id), "app.ipa");
}

export function manifestPath(id: string): string {
  return path.join(uploadDir(id), "manifest.plist");
}

function metaPath(id: string): string {
  return path.join(uploadDir(id), "meta.json");
}

export async function saveUpload(args: {
  info: IpaInfo;
  ipaBytes: Uint8Array;
  originalFilename: string;
}): Promise<{ id: string; meta: AppMeta }> {
  const id = newId();
  const dir = uploadDir(id);
  await fs.mkdir(dir, { recursive: true });

  const meta: AppMeta = {
    ...args.info,
    // uploadedAt is the TTL anchor — never derive TTL from fs mtimes (rsync/restore reset them).
    uploadedAt: Date.now(),
    originalFilename: args.originalFilename,
    size: args.ipaBytes.length,
  };

  // Built here, not by the caller: the manifest's absolute app.ipa url needs the id
  // we just minted, so storage owns it to avoid a chicken-and-egg with the caller.
  const manifestXml = buildManifest({
    id,
    bundleId: args.info.bundleId,
    version: args.info.version,
    name: args.info.name,
  });

  await fs.writeFile(ipaPath(id), args.ipaBytes);
  await fs.writeFile(manifestPath(id), manifestXml);
  // meta.json is the existence/TTL signal, so write it LAST — a crash mid-upload
  // leaves a dir without meta.json, which getMeta/sweep treat as absent.
  await fs.writeFile(metaPath(id), JSON.stringify(meta));

  return { id, meta };
}

export async function getMeta(id: string): Promise<AppMeta | null> {
  if (!isValidId(id)) return null;
  try {
    const raw = await fs.readFile(metaPath(id), "utf8");
    return JSON.parse(raw) as AppMeta;
  } catch {
    // ENOENT or malformed JSON -> not found.
    return null;
  }
}

export function isExpired(meta: AppMeta): boolean {
  return Date.now() - meta.uploadedAt > config.ttlHours * 3600_000;
}

export async function deleteUpload(id: string): Promise<void> {
  if (!isValidId(id)) return;
  await fs.rm(uploadDir(id), { recursive: true, force: true });
}

export async function sweepExpired(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(config.dataDir);
  } catch {
    // Missing dataDir -> nothing to sweep.
    return [];
  }

  const deleted: string[] = [];
  for (const id of entries) {
    const meta = await getMeta(id); // skips invalid ids and dirs without meta.json
    if (meta && isExpired(meta)) {
      await deleteUpload(id);
      deleted.push(id);
    }
  }
  return deleted;
}
