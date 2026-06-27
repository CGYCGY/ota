# OTA Install Server

A tiny, self-hosted replacement for Diawi: upload a signed iOS `.ipa` or an Android
`.apk`, get an HTTPS install page with a QR code that installs the app over-the-air.
App-agnostic and multi-project — deploy **once**, reuse across every app.

- [`docs/spec.md`](./docs/spec.md) — full design and the iOS constraints that drive it.
- [`docs/architecture.html`](./docs/architecture.html) — architecture & request-flow diagrams (open in a browser).

## How it works

1. Upload an `.ipa` or `.apk` (drag-and-drop in the UI, or `POST /upload` with a CI token).
   Platform is detected from the extension.
2. The server parses the build's metadata, stores it under an unguessable id, and — for
   iOS — generates an Apple OTA `manifest.plist`. (Android needs no manifest.)
3. You get an install page `…/i/<id>` with a **QR code** and an action button.
4. **iOS:** open in **Safari** on a registered iPhone → tap Install → app installs OTA.
   **Android:** open in **any browser** → tap Download → tap the file → installer runs.
5. Each upload auto-deletes after `TTL_HOURS` (default 24h).

> The server only handles **delivery**. iOS IPAs must be **ad-hoc/enterprise/dev signed**
> with the iPhone's **UDID registered** in the provisioning profile (Apple's rules). For
> Android, the OS prompts once to allow installs from the browser — device-side, not
> something this server controls.
>
> The Android display name comes from the optional `name` upload field (or the filename) —
> the APK's real label lives in `resources.arsc`, which we don't parse.

## Stack

Bun + [Hono](https://hono.dev). `fflate` (unzip) · `bplist-parser` (binary plist) ·
`@devicefarmer/adbkit-apkreader` (APK manifest) · `qrcode` (server-rendered QR).
Single service, single container.

## Run locally

```sh
bun install
cp .env.example .env   # then edit PUBLIC_BASE_URL / ADMIN_PASSWORD / SESSION_SECRET
bun run src/index.ts
```

For a real OTA install you need CA-trusted HTTPS (iOS rejects self-signed/IP/plain-HTTP).
Locally you can exercise the API/UI, but device installs require the deployed HTTPS host.

## Auth model

- **Upload** is the only privileged action.
  - **Humans:** `/login` (password `ADMIN_PASSWORD`) → signed HttpOnly session cookie.
    The `/` upload form is never reachable without a valid session.
  - **CI:** `Authorization: Bearer <token>`. Tokens are admin-minted in the UI
    (`/tokens`), one per project, hashed at rest, individually revocable.
- **Download/install** endpoints (`/i/:id*`) are intentionally **public** — iOS fetches
  them unauthenticated. Security = unguessable CSPRNG id + short TTL.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/upload` | bearer **or** session | multipart `.ipa`/`.apk` (+ optional `name`) → install URL (JSON) |
| `GET` | `/login` | public | password form |
| `POST` | `/login` | public | sets session cookie |
| `GET` | `/` | session | drag-and-drop upload form |
| `GET` | `/tokens` | session | list CI tokens |
| `POST` | `/tokens` | session | create token (secret shown once) |
| `POST` | `/tokens/:id/revoke` | session | revoke a token |
| `GET` | `/i/:id` | public | install page (Install/Download + QR) |
| `GET` | `/i/:id/manifest.plist` | public | iOS OTA manifest (`text/xml`) |
| `GET` | `/i/:id/app.ipa` | public | the IPA (`application/octet-stream`) |
| `GET` | `/i/:id/app.apk` | public | the APK (`application/vnd.android.package-archive`) |
| `GET` | `/healthz` | public | health check |

## CI usage (Codemagic example)

Mint a token in the UI labeled for the project, store it as the secure CI var
`OTA_UPLOAD_TOKEN`, then:

```yaml
publishing:
  scripts:
    - name: Publish OTA install link
      script: |
        RESP=$(curl -fsS -X POST \
          -H "Authorization: Bearer $OTA_UPLOAD_TOKEN" \
          -F "file=@$CM_BUILD_DIR/apps/mobile/ios/build/ios/ipa/App.ipa" \
          https://install.example.com/upload)
        echo "Install: $(echo "$RESP" | jq -r .install_url)"
```

## Deploy (Coolify)

1. Point a neutral subdomain (e.g. `install.<yourdomain>.com`) at the service — Coolify/
   Traefik auto-provisions the Let's Encrypt cert that satisfies iOS's trusted-HTTPS rule.
2. Set env vars: `PUBLIC_BASE_URL`, `ADMIN_PASSWORD`, `SESSION_SECRET` (see `.env.example`).
3. Mount a persistent volume at `/data`.
4. Ensure the proxy doesn't cap upload bodies below `MAX_UPLOAD_MB`.
5. Deploy, then hit `/healthz` → `200`. Log in, mint a token, and you're live.
