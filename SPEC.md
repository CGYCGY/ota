# Self-Hosted OTA Install Server — Spec

A tiny, self-hosted replacement for Diawi: upload a signed iOS `.ipa`, get an
HTTPS install page with a QR code that installs the app over-the-air on iPhone.
App-agnostic and multi-project — deploy **once**, reuse across every iOS app.

This document is self-contained; it can be dropped into a new repo as `README`/spec
and built from scratch. It assumes deployment on **Coolify** (Docker + Traefik +
Let's Encrypt), but any host that gives a CA-trusted HTTPS cert works.

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

## 2. What it does (functional spec)

- Accept an uploaded `.ipa` via an authenticated endpoint (and/or a simple web form).
- Parse the IPA's embedded `Info.plist` to read **bundle id, version, build, app
  name** — so it works for any app with zero per-project config.
- Store the IPA under a random, unguessable id: `/<DATA_DIR>/<id>/app.ipa`.
- Generate a per-upload `manifest.plist` from that metadata.
- Serve a per-upload **install page** (`/i/<id>`) with the `itms-services` link and a
  rendered **QR code**, showing app name + version so a shared server stays legible.
- **Auto-delete** each upload after `TTL_HOURS` (default 24h).

Multi-app / multi-build is inherent: every upload is an isolated `<id>` with its own
page, QR, and expiry clock. 10 apps × 50 builds coexist with no config.

---

## 3. HTTP API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/upload` | Bearer token **or** session | multipart `.ipa` upload → returns install URL |
| `GET` | `/login` | public | password form (humans) → sets signed session cookie |
| `GET` | `/` | session (required) | manual drag-and-drop upload form (Option A) |
| `GET` | `/tokens` | session (required) | list upload tokens (label, created, last-used; never the secret) |
| `POST` | `/tokens` | session (required) | create a named token → returns the secret **once** |
| `DELETE` | `/tokens/:id` | session (required) | revoke a token |
| `GET` | `/i/:id` | public | install page (itms link + QR + app info) |
| `GET` | `/i/:id/manifest.plist` | public | OTA manifest, `Content-Type: text/xml` |
| `GET` | `/i/:id/app.ipa` | public | the IPA, `Content-Type: application/octet-stream` |
| `GET` | `/i/:id/icon.png` | public | app icon (optional, see §7) |
| `GET` | `/healthz` | public | `200 OK` for Coolify health check |

**`POST /upload`**
- Header: `Authorization: Bearer <UPLOAD_TOKEN>`
- Body: `multipart/form-data`, field `file` = the `.ipa`
- Response `200`:
  ```json
  {
    "id": "a1b2c3d4e5f6",
    "install_url": "https://install.example.com/i/a1b2c3d4e5f6",
    "app": { "name": "Expari", "bundleId": "com.expari.app", "version": "1.0.0", "build": "12" },
    "expires_at": "2026-06-26T17:00:00Z"
  }
  ```
- Errors: `401` (bad/missing token), `400` (not a valid IPA / no `Info.plist`），`413`
  (over size limit).

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
    app.ipa
    manifest.plist
    icon.png          # optional
    meta.json         # { bundleId, version, build, name, uploadedAt, originalFilename, size }
```

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

## 5. manifest.plist (generated per upload)

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

## 6. Parsing the IPA

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

## 7. App icon (optional, stretch goal)

Icons in an IPA are PNGs under the `.app` (e.g. `AppIcon60x60@3x.png`), but Apple
**"CgBI"-optimizes** them — browsers can't render them as-is; the byte order is
swapped and they use a nonstandard chunk. To show an icon you must run a
**`pcrush`/`revert-iOS-PNG`** step to normalize it. Worth skipping for v1; the page
works fine with just app name + version. Add later if you want polish.

---

## 8. Install page (`GET /i/:id`)

Minimal self-contained HTML:
- App name + version + build (from `meta.json`).
- A big **Install** button → the `itms-services://...` link.
- A **QR code** encoding the **page URL** (`/i/:id`), so a second phone can scan to
  reach this same page and tap install. (Encode the page URL, not the raw
  `itms-services` link — QR scanners/cameras handle https far more reliably, and the
  user still taps Install in Safari.)
- A one-line note: "Open in Safari. Expires in N hours."
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
- **Unzip:** `fflate`. **Plist:** `bplist-parser` (or `simple-plist`).
- **QR:** `qrcode` (client or server).
- ~150–250 lines total. Single service, single container.

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

The server needs **nothing** per project. Each new iOS app just chooses how the IPA
gets uploaded:

**Option A — manual (drag & drop):**
Open `https://install.<yourdomain>.com`, drag the `.ipa`, get a QR. Works for any IPA
from anywhere; zero CI changes.

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
Per project: in the admin UI mint a token labeled for that project, paste it as the
secure CI var `OTA_UPLOAD_TOKEN`. Same endpoint everywhere; each project carries its
**own** token so you can revoke one without affecting the rest. (Adjust the `.ipa`
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
- **Wrong Content-Type** → `manifest.plist` must be `text/xml` (or
  `application/xml`); IPA `application/octet-stream`. Some iOS versions choke
  otherwise.
- **Opened outside Safari** → `itms-services` only fires in Safari. Tell users.
- **Relative URL in manifest** → the IPA `url` must be absolute `https://`.
- **Binary plist** → don't assume XML; parse bplist.
- **Proxy body-size cap** → a 20–150 MB upload dies if the reverse proxy caps it.
- **Not the server's fault:** ad-hoc signing + UDID registration. If install fails
  with a signing/"cannot install" error, it's Apple-side, not delivery.

---

## 17. Non-goals

- Not a TestFlight / public-distribution replacement (still UDID-gated, 24h-ephemeral).
- Does not sign apps or manage Apple provisioning/UDIDs.
- No long-term hosting, no build history UI (could be added behind auth later).

---

## 18. Possible extensions (later)

- **Android APK support** — makes it cover *all* mobile projects. APKs install
  straight from a download link (no manifest needed): detect `.apk`, skip manifest
  generation, serve a download button + QR. Small addition, big reuse win.
- App icon rendering (§7).
- An authenticated index of active builds (app name, version, expiry, link).
- Per-app retention / max-builds caps; `log()` what gets pruned.
- Slack/webhook ping with the install link on each CI upload.
</content>
</invoke>
