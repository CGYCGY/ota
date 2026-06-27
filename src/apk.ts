import ApkReader from "@devicefarmer/adbkit-apkreader";
import type { AppInfo } from "./types.ts";

// The lib reads package/version reliably from the binary AndroidManifest.xml.
// It does NOT resolve the display label — that's a resources.arsc reference, so
// the human name comes from the uploader's `name` field (or the filename) instead.
export async function parseApk(
  buf: Uint8Array,
  originalFilename: string,
  nameOverride?: string,
): Promise<AppInfo> {
  let manifest;
  try {
    const reader = await ApkReader.open(Buffer.from(buf));
    manifest = await reader.readManifest();
  } catch (e) {
    throw new Error("not a valid APK: " + (e instanceof Error ? e.message : String(e)));
  }

  const bundleId = manifest.package;
  if (!bundleId) throw new Error("not a valid APK: missing package in manifest");

  const version = manifest.versionName || "0";
  // versionCode may be a Long for >32-bit values — stringify whatever it is.
  const build = manifest.versionCode != null ? String(manifest.versionCode) : version || "0";
  const name =
    (nameOverride && nameOverride.trim()) ||
    originalFilename.replace(/\.apk$/i, "") ||
    "App";

  return { platform: "android", bundleId, version, build, name };
}
