// Apple OTA (itms-services) manifest builder. Pure — no IO.

import { config } from "./config";

// App names can contain & < > " ' — these would break the plist XML if not escaped.
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildManifest(args: {
  id: string;
  bundleId: string;
  version: string;
  name: string;
}): string {
  // iOS fetches this URL directly off-device, so it must be absolute https.
  const url = `${config.publicBaseUrl}/i/${args.id}/app.ipa`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key><string>software-package</string>
          <key>url</key><string>${xmlEscape(url)}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key><string>${xmlEscape(args.bundleId)}</string>
        <key>bundle-version</key><string>${xmlEscape(args.version)}</string>
        <key>kind</key><string>software</string>
        <key>title</key><string>${xmlEscape(args.name)}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>`;
}

export function installLink(id: string): string {
  return (
    "itms-services://?action=download-manifest&url=" +
    encodeURIComponent(`${config.publicBaseUrl}/i/${id}/manifest.plist`)
  );
}
