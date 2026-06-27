import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { config } from "./config.ts";
import { parseIpa } from "./ipa.ts";
import { parseApk } from "./apk.ts";
import { installLink } from "./manifest.ts";
import {
  saveUpload, getMeta, isExpired, deleteUpload, sweepExpired,
  appPath, manifestPath, uploadDir,
} from "./storage.ts";
import { listTokens, createToken, deleteToken, validateToken } from "./tokens.ts";
import {
  checkPassword, createSessionCookieValue, verifySessionCookie, SESSION_COOKIE_NAME,
} from "./auth.ts";
import {
  installPage, notFoundPage, loginPage, uploadPage, tokensPage,
} from "./views.ts";
import { promises as fs } from "node:fs";

const app = new Hono();

// Advertise the agent-readable API guide on every response (incl. the /login
// redirect), so an agent pointed at the bare host discovers it via the header.
app.use("*", async (c, next) => {
  await next();
  c.header("Link", '</llms.txt>; rel="llms-txt"');
});

// --- helpers ---------------------------------------------------------------

function hasSession(c: import("hono").Context): boolean {
  return verifySessionCookie(getCookie(c, SESSION_COOKIE_NAME));
}

/** iOS fetches the install assets unauthenticated, so an expired upload must read as a clean 404 — also delete it lazily. */
async function loadLiveMeta(id: string) {
  const meta = await getMeta(id);
  if (!meta) return null;
  if (await isExpired(meta)) {
    await deleteUpload(id);
    return null;
  }
  return meta;
}

// --- public health ---------------------------------------------------------

app.get("/healthz", (c) => c.text("OK"));

// --- agent-readable API guide (public, plaintext) --------------------------

app.get("/llms.txt", (c) => {
  const base = config.publicBaseUrl;
  return c.text(
    `# ${new URL(base).host} — self-hosted iOS + Android OTA install server

Upload a signed .ipa or an .apk, get a public HTTPS install page + QR for
over-the-air install. App-agnostic; one server hosts many projects.

## Publish a build (CI / agents)
POST ${base}/upload
  Auth:  Authorization: Bearer <token>      # humans mint tokens at ${base}/tokens (login at /login)
  Body:  multipart/form-data
           field "file" = the .ipa or .apk   (platform is detected from the extension)
           field "name" = optional display name (Android label override; ignored for iOS)
  Limit: ${config.maxUploadMb} MB max

  curl -H "Authorization: Bearer $OTA_TOKEN" -F file=@App.ipa ${base}/upload
  curl -H "Authorization: Bearer $OTA_TOKEN" -F file=@app-release.apk -F name=Expari ${base}/upload

Response 200 (application/json):
  {
    "id": "<hex>",
    "install_url": "${base}/i/<id>",
    "platform": "ios" | "android",
    "app": { "name": "...", "bundleId": "...", "version": "...", "build": "..." },
    "expires_at": "<ISO-8601>"
  }

Errors: 401 (missing/invalid token), 400 (no "file" field, not a .ipa/.apk, or unreadable), 413 (too large).

## Install on device
iOS:     open install_url in **Safari** on a UDID-registered device, tap Install.
         The device's UDID must be in the .ipa's ad-hoc/enterprise provisioning profile.
Android: open install_url in **any browser**, tap Download, then tap the file to install.
         No Safari, no UDID. The OS may prompt to allow installs from the browser once.

## Notes
- Builds expire ${config.ttlHours}h after upload; re-upload to refresh.
- install_url is public and unguessable — devices fetch the manifest/ipa/apk with no auth headers.
- Two credentials hit /upload: a session cookie (humans, via /login) OR a Bearer token (CI/agents).
`,
    200,
    { "Content-Type": "text/plain; charset=utf-8" },
  );
});

// --- human auth ------------------------------------------------------------

app.get("/login", (c) => c.html(loginPage()));

app.post("/login", async (c) => {
  const body = await c.req.parseBody();
  const password = typeof body.password === "string" ? body.password : "";
  if (!checkPassword(password)) {
    return c.html(loginPage("Wrong password."), 401);
  }
  setCookie(c, SESSION_COOKIE_NAME, createSessionCookieValue(), {
    httpOnly: true,
    secure: true, // whole site is HTTPS in production
    sameSite: "Lax",
    path: "/",
    maxAge: config.sessionTtlHours * 3600,
  });
  return c.redirect("/");
});

app.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
  return c.redirect("/login");
});

// --- gated upload form (humans) -------------------------------------------

app.get("/", (c) => {
  if (!hasSession(c)) return c.redirect("/login");
  return c.html(uploadPage());
});

// --- token admin (humans, session-gated) -----------------------------------

app.get("/tokens", async (c) => {
  if (!hasSession(c)) return c.redirect("/login");
  return c.html(tokensPage(await listTokens()));
});

app.post("/tokens", async (c) => {
  if (!hasSession(c)) return c.redirect("/login");
  const body = await c.req.parseBody();
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) return c.html(tokensPage(await listTokens(), undefined), 400);
  const { secret } = await createToken(label);
  return c.html(tokensPage(await listTokens(), secret));
});

// No-JS fallback: HTML forms can't issue DELETE, so the revoke button posts
// here and the deleted row simply vanishes on the redirect.
app.post("/tokens/:id/revoke", async (c) => {
  if (!hasSession(c)) return c.redirect("/login");
  await deleteToken(c.req.param("id"));
  return c.redirect("/tokens");
});

// The JS path: revoke without a reload, then the row clears on next refresh.
app.delete("/tokens/:id", async (c) => {
  if (!hasSession(c)) return c.json({ error: "unauthorized" }, 401);
  const ok = await deleteToken(c.req.param("id"));
  return c.json({ deleted: ok });
});

// --- upload (humans via session OR CI via bearer token) --------------------

app.post(
  "/upload",
  bodyLimit({
    maxSize: config.maxUploadMb * 1024 * 1024,
    onError: (c) => c.json({ error: "file too large" }, 413),
  }),
  async (c) => {
    // Either credential is accepted on the same endpoint (spec §3).
    let authed = hasSession(c);
    if (!authed) {
      const auth = c.req.header("Authorization") ?? "";
      const m = auth.match(/^Bearer\s+(.+)$/i);
      if (m && (await validateToken(m[1].trim()))) authed = true;
    }
    if (!authed) return c.json({ error: "unauthorized" }, 401);

    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) {
      return c.json({ error: "missing file field" }, 400);
    }
    // Platform is driven purely off the extension — the parser to use and the
    // on-disk filename both follow from it.
    const lower = file.name.toLowerCase();
    const platform = lower.endsWith(".apk") ? "android" : lower.endsWith(".ipa") ? "ios" : null;
    if (!platform) {
      return c.json({ error: "file must be a .ipa or .apk" }, 400);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Optional display-name override (Android label lives in arsc, not parsed).
    const nameOverride = typeof body.name === "string" ? body.name : undefined;

    let info;
    try {
      info =
        platform === "android"
          ? await parseApk(bytes, file.name, nameOverride)
          : await parseIpa(bytes, file.name);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }

    const { id, meta } = await saveUpload({ info, bytes, originalFilename: file.name });

    return c.json({
      id,
      install_url: `${config.publicBaseUrl}/i/${id}`,
      platform: meta.platform,
      app: { name: meta.name, bundleId: meta.bundleId, version: meta.version, build: meta.build },
      expires_at: new Date(meta.uploadedAt + config.ttlHours * 3600_000).toISOString(),
    });
  },
);

// --- public install endpoints (must be unauthenticated — iOS fetches these) -

app.get("/i/:id", async (c) => {
  const id = c.req.param("id");
  const meta = await loadLiveMeta(id);
  if (!meta) return c.html(notFoundPage(), 404);
  const pageUrl = `${config.publicBaseUrl}/i/${id}`;
  return c.html(await installPage({ id, meta, installLink: installLink(id), pageUrl }));
});

app.get("/i/:id/manifest.plist", async (c) => {
  const id = c.req.param("id");
  const meta = await loadLiveMeta(id);
  if (!meta || meta.platform !== "ios") return c.text("Not found", 404);
  const xml = await fs.readFile(manifestPath(id), "utf8").catch(() => null);
  if (xml === null) return c.text("Not found", 404);
  // Some iOS versions reject the manifest with any other Content-Type.
  return c.body(xml, 200, { "Content-Type": "text/xml; charset=utf-8" });
});

app.get("/i/:id/app.ipa", async (c) => {
  const id = c.req.param("id");
  const meta = await loadLiveMeta(id);
  if (!meta || meta.platform !== "ios") return c.text("Not found", 404);
  const bytes = await fs.readFile(appPath(id, "ios")).catch(() => null);
  if (bytes === null) return c.text("Not found", 404);
  return c.body(bytes, 200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${meta.bundleId}.ipa"`,
  });
});

app.get("/i/:id/app.apk", async (c) => {
  const id = c.req.param("id");
  const meta = await loadLiveMeta(id);
  if (!meta || meta.platform !== "android") return c.text("Not found", 404);
  const bytes = await fs.readFile(appPath(id, "android")).catch(() => null);
  if (bytes === null) return c.text("Not found", 404);
  // The vnd.android mime is mandatory — a generic type makes the browser save a
  // .zip and Android's package installer never fires.
  return c.body(bytes, 200, {
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Disposition": `attachment; filename="${meta.bundleId}.apk"`,
  });
});

app.get("/i/:id/icon.png", async (c) => {
  const id = c.req.param("id");
  const meta = await loadLiveMeta(id);
  if (!meta) return c.text("Not found", 404);
  const bytes = await fs.readFile(`${uploadDir(id)}/icon.png`).catch(() => null);
  if (bytes === null) return c.text("Not found", 404);
  return c.body(bytes, 200, { "Content-Type": "image/png" });
});

// --- TTL sweeper -----------------------------------------------------------

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
async function sweep() {
  try {
    const deleted = await sweepExpired();
    if (deleted.length) console.log(`[sweep] deleted ${deleted.length} expired upload(s)`);
  } catch (e) {
    console.error("[sweep] error", e);
  }
}
setInterval(sweep, SWEEP_INTERVAL_MS).unref?.();
sweep();

console.log(`OTA install server on :${config.port} — base ${config.publicBaseUrl}, ttl ${config.ttlHours}h`);

export default { port: config.port, fetch: app.fetch, maxRequestBodySize: config.maxUploadMb * 1024 * 1024 + 1024 * 1024 };
