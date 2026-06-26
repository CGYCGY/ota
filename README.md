# OTA Install Server

A tiny, self-hosted replacement for Diawi: upload a signed iOS `.ipa`, get an HTTPS
install page with a QR code that installs the app over-the-air on iPhone. App-agnostic
and multi-project — deploy **once**, reuse across every iOS app.

- [`docs/spec.md`](./docs/spec.md) — full design and the iOS constraints that drive it.
- [`docs/architecture.html`](./docs/architecture.html) — architecture & request-flow diagrams (open in a browser).

## How it works

1. Upload an `.ipa` (drag-and-drop in the UI, or `POST /upload` with a CI token).
2. The server parses the IPA's `Info.plist`, stores it under an unguessable id, and
   generates an Apple OTA `manifest.plist`.
3. You get an install page `…/i/<id>` with an **Install** button and a **QR code**.
4. Open it in **Safari** on a registered iPhone → tap Install → app installs OTA.
5. Each upload auto-deletes after `TTL_HOURS` (default 24h).

> The server only handles **delivery**. The IPA must be **ad-hoc/enterprise/dev signed**
> and the iPhone's **UDID registered** in the provisioning profile — Apple's rules, not
> something this server controls.

## Stack

Bun + [Hono](https://hono.dev). `fflate` (unzip) · `bplist-parser` (binary plist) ·
`qrcode` (server-rendered QR). Single service, single container.

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
| `POST` | `/upload` | bearer **or** session | multipart `.ipa` → install URL (JSON) |
| `GET` | `/login` | public | password form |
| `POST` | `/login` | public | sets session cookie |
| `GET` | `/` | session | drag-and-drop upload form |
| `GET` | `/tokens` | session | list CI tokens |
| `POST` | `/tokens` | session | create token (secret shown once) |
| `POST` | `/tokens/:id/revoke` | session | revoke a token |
| `GET` | `/i/:id` | public | install page (itms link + QR) |
| `GET` | `/i/:id/manifest.plist` | public | OTA manifest (`text/xml`) |
| `GET` | `/i/:id/app.ipa` | public | the IPA (`application/octet-stream`) |
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
