import { unzipSync } from "fflate";
import bplist from "bplist-parser";
import type { IpaInfo } from "./types.ts";

// Case-sensitive: Apple's tooling always emits exactly this casing; a loose
// match could pick up nested .app bundles (extensions) inside Frameworks/Plugins.
const INFO_PLIST_RE = /^Payload\/[^/]+\.app\/Info\.plist$/;

// "bplist" — the binary plist magic. Info.plist is compiled to bplist at build
// time, but ad-hoc/resigned archives sometimes carry an XML plist instead.
const BPLIST_MAGIC = [0x62, 0x70, 0x6c, 0x69, 0x73, 0x74];

export async function parseIpa(buf: Uint8Array, originalFilename: string): Promise<IpaInfo> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(buf);
  } catch (e) {
    throw new Error("not a valid IPA: " + (e instanceof Error ? e.message : String(e)));
  }

  const path = Object.keys(entries).find((p) => INFO_PLIST_RE.test(p));
  if (!path) throw new Error("not a valid IPA: no Info.plist found");
  const bytes = entries[path]!;

  const dict = isBplist(bytes)
    ? (bplist.parseBuffer(Buffer.from(bytes))[0] as Record<string, unknown>)
    : parseXmlPlist(new TextDecoder().decode(bytes));

  const bundleId = str(dict.CFBundleIdentifier);
  if (!bundleId) throw new Error("not a valid IPA: missing CFBundleIdentifier");

  const shortVersion = str(dict.CFBundleShortVersionString);
  const bundleVersion = str(dict.CFBundleVersion);
  const version = shortVersion || bundleVersion || "0";
  const build = bundleVersion || version || "0";
  const name =
    str(dict.CFBundleDisplayName) ||
    str(dict.CFBundleName) ||
    originalFilename.replace(/\.ipa$/i, "") ||
    "App";

  return { bundleId, version, build, name };
}

function isBplist(bytes: Uint8Array): boolean {
  return BPLIST_MAGIC.every((b, i) => bytes[i] === b);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Minimal reader for the four <key>/<string> pairs we need — avoids pulling in
// an XML parser for a format we only touch on the rare XML-plist path.
function parseXmlPlist(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<key>([^<]*)<\/key>\s*<string>([\s\S]*?)<\/string>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    out[m[1]!.trim()] = unescapeXml(m[2]!);
  }
  return out;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
