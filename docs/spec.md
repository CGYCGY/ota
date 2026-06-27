# Self-Hosted OTA Install Server — Spec

A tiny, self-hosted replacement for Diawi: upload a signed iOS `.ipa` or an Android
`.apk`, get an HTTPS install page with a QR code that installs the app over-the-air.
App-agnostic and multi-project — deploy **once**, reuse across every mobile app.

This document is self-contained; it can be dropped into a new repo as `README`/spec
and built from scratch. It assumes deployment on **Coolify** (Docker + Traefik +
Let's Encrypt), but any host that gives a CA-trusted HTTPS cert works.

The design is **iOS-shaped** because iOS is the hard case (§1). Android is strictly
easier and rides the same endpoints/id/TTL model — see §1b for the deltas.

---

## 1. Why this exists / the iOS constraints driving the design

iOS cannot install a bare `.ipa` from a downloaded file (unlike Android APKs). The
**only** non-cable install path is Apple's OTA flow, which requires:

1. A **`manifest.plist`** describing the app, served over **HTTPS with a CA-trusted
   cert** (self-signed/IP/plain-HTTP are all rejected).
2. The **`.ipa` itself served over that same trusted HTTPS**, fetchable with no auth
   headers (iOS fetches it directly during install — it cannot send a token).
3. A link of the form
   `itms-services://?action=download-manifest&url=<url-encoded https manifest url>`
   opened in **Safari** (in-app browsers like Chrome/WhatsApp do not trigger it).

These are Apple rules the server cannot change. Two more are **out of the server's
hands entirely** — they live in the IPA's signing, per app and per device:

- The IPA must be **ad-hoc** (or enterprise/dev) signed.
- The target iPhone's **UDID must be registered** in that app's provisioning profile.

The server only handles **delivery**. It never signs, never touches Apple. If an IPA
is signed correctly and the device is registered, this server gets it installed; if
not, no delivery mechanism can help.

Coolify is a good fit specifically because Traefik + Let's Encrypt auto-provisions the
trusted cert for requirement (1)/(2) the moment a subdomain points at the service.

---

## 1b. Android: none of the above

An `.apk` installs from a **plain HTTPS download** — Android has none of iOS's three
constraints:

- **No `manifest.plist`**, no `itms-services://`, no Safari-only requirement — any
  browser works.
- **No trusted-cert-for-manifest dance** beyond ordinary HTTPS (the Let's Encrypt cert
  already satisfies it).
- **No UDID / provisioning-profile gate.**

The whole Android flow: serve the `.apk` over HTTPS with `Content-Type:
application/vnd.android.package-archive`, show a **Download** button + a QR of the page
URL. User taps Download → taps the file → Android's package installer runs. The
unguessable-id + TTL + token model carries over **unchanged**.

The one wrinkle is metadata: an `.apk` is a zip, but `AndroidManifest.xml` inside it is
**binary AXML** and the display label is a `resources.arsc` resource reference, not text.
So a focused dependency reads the reliable fields and the human name comes from the
upload — see §6b.

Two device-side prompts the server can't bypass (document, don't fix): "Install unknown
apps" (a per-source OS prompt for the downloading browser, Android 8+), and Play
Protect / Samsung Auto Blocker nagging on debug-signed APKs.

---

## 2. What it does (functional spec)

- Accept an uploaded `.ipa` **or** `.apk` via an authenticated endpoint (and/or a simple
  web form). Platform is detected from the file extension.
- Read **bundle id, version, build, app name** from the build — from the IPA's
  `Info.plist`, or from the APK's binary manifest (`package`/`versionName`/`versionCode`).
  Works for any app with zero per-project config.
- Store the build under a random, unguessable id: `/<DATA_DIR>/<id>/app.ipa` or `app.apk`.
- For iOS only, generate a per-upload `manifest.plist`. Android needs none.
- Serve a per-upload **install page** (`/i/<id>`) with the platform-appropriate action
  (**Install** itms link on iOS, **Download** button on Android) and a rendered **QR
  code**, showing app name + version so a shared server stays legible.
- **Auto-delete** each upload after `TTL_HOURS` (default 24h).

Multi-app / multi-build / multi-platform is inherent: every upload is an isolated `<id>`
with its own page, QR, and expiry clock. iOS and Android builds coexist with no config.

---

## 3. HTTP API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/upload` | Bearer token **or** session | multipart `.ipa`/`.apk` upload → returns install URL |
| `GET` | `/login` | public | password form (humans) → sets signed session cookie |
| `GET` | `/` | session (required) | manual drag-and-drop upload form (Option A) |
| `GET` | `/tokens` | session (required) | list upload tokens (label, created, last-used; never the secret) |
| `POST` | `/tokens` | session (required) | create a named token → returns the secret **once** |
| `DELETE` | `/tokens/:id` | session (required) | revoke a token |
| `GET` | `/i/:id` | public | install page (Install/Download + QR + app info) |
| `GET` | `/i/:id/manifest.plist` | public | iOS OTA manifest, `Content-Type: text/xml` (404 for android) |
| `GET` | `/i/:id/app.ipa` | public | the IPA, `Content-Type: application/octet-stream` (404 for android) |
| `GET` | `/i/:id/app.apk` | public | the APK, `Content-Type: application/vnd.android.package-archive` (404 for ios) |
| `GET` | `/i/:id/icon.png` | public | app icon (optional, see §7) |
| `GET` | `/healthz` | public | `200 OK` for Coolify health check |

The platform-specific asset routes cross-guard on `meta.platform`: an android id 404s on
`app.ipa`/`manifest.plist`, an iOS id 404s on `app.apk`.

**`POST /upload`**
- Header: `Authorization: Bearer <UPLOAD_TOKEN>`
- Body: `multipart/form-data`
  - field `file` = the `.ipa` or `.apk` — **platform is detected from the extension**
  - field `name` = optional display name (used as the Android label override; ignored
    for iOS, where the name comes from the IPA)
- Response `200`:
  ```json
  {
    "id": "a1b2c3d4e5f6",
    "install_url": "https://install.example.com/i/a1b2c3d4e5f6",
    "platform": "ios",
    "app": { "name": "Expari", "bundleId": "com.expari.app", "version": "1.0.0", "build": "12" },
    "expires_at": "2026-06-26T17:00:00Z"
  }
  ```
- Errors: `401` (bad/missing token), `400` (not a `.ipa`/`.apk`, or unreadable build),
  `413` (over size limit).

**Two ways to authenticate an upload, one endpoint:**
- **Humans** log in at `/login` (password → signed, HttpOnly session cookie), then the
  `/` form and its `POST /upload` ride that cookie. The upload form is **never open** —
  hitting `/` without a valid session redirects to `/login`.
- **CI** sends `Authorization: Bearer <token>` directly to `POST /upload`, no
  cookie/login. Tokens are **minted by the admin** (see §4b), not a static env value —
  one per project, individually revocable.
`POST /upload` accepts **either** credential.

Public `/i/:id*` endpoints **must not** require auth — security comes from the
unguessable id + TTL, never a login (iOS can't authenticate the IPA fetch). Gate the
**upload**, not the download.

---

## 4. Storage layout

```
<DATA_DIR>/
  tokens.json         # managed upload tokens (see §4b)
  <id>/
    app.ipa           # iOS uploads          (filename derived from meta.platform)
    app.apk           # Android uploads
    manifest.plist    # iOS only — Android writes none
    icon.png          # optional
    meta.json         # { platform, bundleId, version, build, name, uploadedAt, originalFilename, size }
```

`meta.platform` is `"ios" | "android"` and drives the on-disk filename, the asset-route
guards, and the install-page branch. **Backward compat:** uploads predating the field
have no `platform` — `getMeta` defaults a missing/unknown value to `"ios"` so old links
keep resolving after deploy.

- `id`: ≥12 chars from a CSPRNG (e.g. `crypto.randomUUID()` without dashes, or 16
  hex bytes). Unguessable is the access control.
- `meta.json.uploadedAt` (epoch ms) is the TTL anchor — don't rely on filesystem
  mtimes (copies/restores reset them).
- Persist `<DATA_DIR>` to a **volume** so a redeploy doesn't drop still-valid links.
  (Ephemeral-by-24h means it's not catastrophic, but a volume avoids surprise dead
  links right after a deploy.)

---

## 4b. Upload tokens (admin-managed)

CI authenticates with **named, revocable tokens** the admin mints from the UI — not a
single static env secret. One token per project; revoke a project's CI access without
touching the others.

`<DATA_DIR>/tokens.json` (on the persisted volume):
```json
[
  { "id": "tok_7f3a", "label": "expari", "hash": "<sha256 of secret>",
    "createdAt": 1750000000000, "lastUsedAt": 1750086400000, "revoked": false }
]
```

Rules:
- **Create** (`POST /tokens`, label required): generate a high-entropy secret
  (e.g. `ota_` + 32 random bytes base64url), store **only its SHA-256 hash**, return
  the **plaintext once** in the response. It's never retrievable again — admin copies
  it into that project's CI.
- **Validate** (`POST /upload`): hash the presented Bearer, look up a non-revoked
  match, stamp `lastUsedAt`. No match → `401`.
- **List** (`GET /tokens`): return label / created / last-used / revoked — **never**
  the secret or its hash.
- **Revoke** (`DELETE /tokens/:id`): set `revoked: true` (keep the row for audit) or
  delete it. Takes effect immediately.
- Single-admin, low write volume → a JSON file with atomic write (temp + rename) is
  fine. Swap for SQLite only if you outgrow it.

This replaces the old static `UPLOAD_TOKEN` env var entirely. Bootstrap is just: admin
logs in → creates the first token.

## 5. manifest.plist (generated per upload — iOS only)

Android writes no manifest; the rest of this section applies only to `.ipa` uploads.
Exact Apple OTA manifest. Substitute `{...}`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
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
          <key>url</key><string>{PUBLIC_BASE_URL}/i/{id}/app.ipa</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key><string>{bundleId}</string>
        <key>bundle-version</key><string>{version}</string>
        <key>kind</key><string>software</string>
        <key>title</key><string>{appName}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
```

The `url` **must** be the absolute `https://` URL (hence `PUBLIC_BASE_URL` config).

Install link rendered on the page:
```
itms-services://?action=download-manifest&url={urlencode(PUBLIC_BASE_URL + "/i/" + id + "/manifest.plist")}
```

---

## 6. Parsing the IPA (iOS)

An `.ipa` is a zip. The app's plist lives at `Payload/<AppName>.app/Info.plist` and is
**usually a binary plist** (bplist), not XML — use a parser that handles both.

Extract:
- `CFBundleIdentifier` → bundleId (required; if absent, reject as invalid IPA)
- `CFBundleShortVersionString` → version (fallback `CFBundleVersion`)
- `CFBundleVersion` → build
- `CFBundleDisplayName` or `CFBundleName` → app name (fallback: filename)

Suggested libs (Node/Bun): `yauzl` or `fflate` (unzip) + `bplist-parser` or
`simple-plist` (handles binary + xml plists). Read just the one `Info.plist` entry;
don't extract the whole archive.

---

## 6b. Parsing the APK (Android)

An `.apk` is also a zip, but `AndroidManifest.xml` is **binary AXML**, and the display
label is usually a `resources.arsc` resource reference (e.g. `@7f0a0001`), not text. A
hand-rolled AXML+arsc parser is fiddly and easy to get wrong, so:

- Use a focused dependency — `@devicefarmer/adbkit-apkreader` (pure JS) — to read
  `package` → bundleId (required), `versionName` → version, `versionCode` → build.
- **Take the display name from the upload, not the APK.** Use the optional `name` upload
  field (CI/admin knows the real app name), falling back to the filename minus `.apk`.
  This sidesteps `resources.arsc` entirely.
- The lib's `application.label` may come back as a number / resource id — never render it
  raw; treat the label as absent and use the `name` field / filename.
- `versionCode` can be a large integer (Long) — coerce to string before storing.

The lib's `ApkReader.open()` accepts a `Buffer`, so parse the uploaded bytes in-memory —
no temp file. Reject a non-zip / missing-manifest input with a clear error → `400`.

Zero-dep fallback (if the dep is unacceptable): skip APK manifest parsing entirely, use
the `name`/filename for the display name and show no version. Uglier but functional;
version-on-the-page is worth the small dep.

---

## 7. App icon (optional, stretch goal)

Icons in an IPA are PNGs under the `.app` (e.g. `AppIcon60x60@3x.png`), but Apple
**"CgBI"-optimizes** them — browsers can't render them as-is; the byte order is
swapped and they use a nonstandard chunk. To show an icon you must run a
**`pcrush`/`revert-iOS-PNG`** step to normalize it. Worth skipping for v1; the page
works fine with just app name + version. Add later if you want polish.

---

## 8. Install page (`GET /i/:id`)

Minimal self-contained HTML, branched on `meta.platform`:
- App name + version + build (from `meta.json`) — same for both.
- Action button:
  - **iOS:** a big **Install** button → the `itms-services://...` link, plus a note
    "Open in Safari. Expires in N hours."
  - **Android:** a **Download** button — `<a href="/i/<id>/app.apk" download>` — plus a
    note "Tap the downloaded file to install. You may be asked to allow installs from
    your browser the first time. Expires in N hours."
- A **QR code** encoding the **page URL** (`/i/:id`) for both, so a second phone can scan
  to reach this same page. (Encode the page URL, not the raw `itms-services`/apk link —
  QR scanners handle https far more reliably.)
- Generate the QR client-side with a tiny lib (e.g. `qrcode` to a `<canvas>`/data-URL)
  or server-side to a PNG — either is fine.

Show a friendly 404/expired page when `<id>` is gone.

---

## 9. TTL / auto-delete

- Background sweeper on an interval (e.g. every 10 min): for each `<id>`, if
  `now - meta.uploadedAt > TTL_HOURS`, `rm -rf` the dir.
- Also lazily check on access: if a request hits an expired `<id>`, treat as 404 and
  delete.
- `TTL_HOURS` configurable (default 24).

---

## 10. Configuration (env vars)

| Var | Required | Default | Purpose |
|---|---|---|---|
| `PUBLIC_BASE_URL` | yes | — | e.g. `https://install.example.com`; used to build absolute manifest/IPA URLs |
| `DATA_DIR` | no | `/data` | storage root + token store (mount a volume here) |
| `TTL_HOURS` | no | `24` | retention before auto-delete |
| `PORT` | no | `3000` | listen port |
| `MAX_UPLOAD_MB` | no | `300` | reject larger bodies |
| `ADMIN_PASSWORD` | yes | — | password for the human `/login` (gates the upload form) |
| `SESSION_SECRET` | yes | — | random string used to sign session cookies |
| `SESSION_TTL_HOURS` | no | `168` | how long a human login stays valid (default 7d) |

---

## 11. Tech stack (recommendation)

- **Runtime:** Bun. **HTTP:** Hono (tiny, fast, first-class multipart + static).
- **Unzip:** `fflate`. **iOS plist:** `bplist-parser` (or `simple-plist`).
- **APK manifest:** `@devicefarmer/adbkit-apkreader` (pure JS).
- **QR:** `qrcode` (client or server).
- ~200–300 lines total. Single service, single container.

Not prescriptive — any stack that serves static files over HTTPS and can unzip +
parse a plist works (Go, Node, Deno, even nginx + a small CGI). Bun/Hono keeps it
smallest.

---

## 12. Dockerfile (sketch)

```dockerfile
FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .
ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000
VOLUME ["/data"]
CMD ["bun", "run", "src/index.ts"]
```

Add a `HEALTHCHECK` hitting `/healthz` if you like.

---

## 13. Deploy on Coolify

1. Push this repo to git (or build/push a Docker image).
2. New Coolify resource → from the repo/image.
3. **Domain:** set a neutral subdomain, e.g. `install.<yourdomain>.com` (this is shared
   infra — don't name it after one product). Coolify provisions the TLS cert
   automatically; that cert is what satisfies iOS's trusted-HTTPS requirement.
4. **Env vars:** set `PUBLIC_BASE_URL` (= that https subdomain), `ADMIN_PASSWORD`
   (the human `/login` password), and `SESSION_SECRET` (a long random string). See §10
   for the full list. CI upload access is **not** an env var — mint per-project tokens
   from the UI after first login (§4b).
5. **Persistent storage:** mount a volume at `/data`.
6. Confirm Traefik/proxy does not cap upload body size below `MAX_UPLOAD_MB`
   (Traefik default is unlimited; only an explicit middleware would cap it).
7. Deploy. Hit `https://install.<yourdomain>.com/healthz` → `200`.
8. Log in at `/login`, mint your first upload token (§4b), and you're live.

---

## 14. Using it from each project

The server needs **nothing** per project. Each new app just chooses how its build
(`.ipa` or `.apk`) gets uploaded:

**Option A — manual (drag & drop):**
Open `https://install.<yourdomain>.com`, drag the `.ipa`/`.apk`, get a QR. Works for any
build from anywhere; zero CI changes. (For Android, optionally type the app name in the
form's **App name** field — it becomes the install-page label.)

**Option B — CI auto-push (one line in that project's `codemagic.yaml`):**
```yaml
    publishing:
      scripts:
        - name: Publish OTA install link
          script: |
            RESP=$(curl -fsS -X POST \
              -H "Authorization: Bearer $OTA_UPLOAD_TOKEN" \
              -F "file=@$CM_BUILD_DIR/apps/mobile/ios/build/ios/ipa/App.ipa" \
              https://install.<yourdomain>.com/upload)
            echo "Install: $(echo "$RESP" | jq -r .install_url)"
```
For an **Android** build, the same endpoint takes the `.apk` plus an optional `name`:
```yaml
            curl -fsS -X POST \
              -H "Authorization: Bearer $OTA_UPLOAD_TOKEN" \
              -F "file=@app-release.apk" -F "name=Expari" \
              https://install.<yourdomain>.com/upload
```
Per project: in the admin UI mint a token labeled for that project, paste it as the
secure CI var `OTA_UPLOAD_TOKEN`. Same endpoint everywhere; each project carries its
**own** token so you can revoke one without affecting the rest. (Adjust the build
path per project.)

Both can coexist (B just calls the same endpoint A's form posts to). Recommended:
ship A first (it's the whole product), then add B's curl line where you want
hands-free links.

---

## 15. Security model

- **Upload** is the only privileged action, guarded two ways:
  - **Humans:** `/login` (password `ADMIN_PASSWORD`) → signed HttpOnly session cookie.
    The `/` form is **never** reachable without a valid session.
  - **CI:** `Authorization: Bearer <token>`, where tokens are admin-minted, named,
    hashed-at-rest, and individually revocable (§4b).
  Both land on the same `POST /upload`; it accepts either. Set the cookie `Secure`
  (the whole site is HTTPS) and `SameSite=Lax`.
- **Download/install** endpoints are intentionally public — they must be (iOS fetches
  unauthenticated). Protection = unguessable CSPRNG id + short TTL. Don't put secrets
  in IPAs you upload here, and treat any install URL as effectively shareable until it
  expires.
- Tokens are per-project and individually revocable (§4b) — leak one, revoke just that
  one from the UI; the others keep working. Rotate by creating a new token, updating
  that project's CI var, then revoking the old.

---

## 16. Gotchas (the things that silently break it)

- **Untrusted HTTPS** → iOS install fails with no useful error. Must be a real CA cert
  (Coolify/LE gives it). No IP, no self-signed, no plain HTTP.
- **Wrong Content-Type (iOS)** → `manifest.plist` must be `text/xml` (or
  `application/xml`); IPA `application/octet-stream`. Some iOS versions choke
  otherwise.
- **Wrong Content-Type (Android)** → the APK **must** be served
  `application/vnd.android.package-archive`. A generic type makes the browser save a
  `.zip` and the package installer never fires.
- **Opened outside Safari (iOS)** → `itms-services` only fires in Safari. Tell users.
- **Relative URL in manifest** → the IPA `url` must be absolute `https://`.
- **Binary plist / binary AXML** → don't assume XML for either; parse bplist (iOS) and
  AXML (Android). The APK label is an arsc resource ref — never render it raw (§6b).
- **`versionCode` is a Long** → coerce to string before storing.
- **"Install unknown apps" (Android)** → a per-source OS prompt (8+) for the downloading
  browser; the page must tell the user, the server can't bypass it. Play Protect /
  Samsung Auto Blocker may also nag on debug-signed APKs — device-side only.
- **Proxy body-size cap** → a 20–150 MB upload dies if the reverse proxy caps it.
- **Backward compat** → old `meta.json` has no `platform`; default it to `"ios"` in
  `getMeta` or pre-existing iOS links break after deploy.
- **Not the server's fault:** ad-hoc signing + UDID registration (iOS). If install fails
  with a signing/"cannot install" error, it's Apple-side, not delivery.

---

## 17. Non-goals

- Not a TestFlight / public-distribution replacement (still UDID-gated, 24h-ephemeral).
- Does not sign apps or manage Apple provisioning/UDIDs.
- No long-term hosting, no build history UI (could be added behind auth later).

---

## 18. Possible extensions (later)

- **Android APK support** — **shipped** (§1b, §6b). Detect `.apk`, skip manifest
  generation, serve a download button + QR.
- App icon rendering (§7).
- **Android arsc label resolution** — resolve the real app label from `resources.arsc`
  so the `name` upload field becomes optional. Skipped for now (§6b).
- An authenticated index of active builds (app name, version, expiry, link).
- Per-app retention / max-builds caps; `log()` what gets pruned.
- Slack/webhook ping with the install link on each CI upload.
</content>
</invoke>
