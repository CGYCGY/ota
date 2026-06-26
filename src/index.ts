import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { config } from "./config.ts";
import { parseIpa } from "./ipa.ts";
import { installLink } from "./manifest.ts";
import {
  saveUpload, getMeta, isExpired, deleteUpload, sweepExpired,
  ipaPath, manifestPath, uploadDir,
} from "./storage.ts";
import { listTokens, createToken, revokeToken, validateToken } from "./tokens.ts";
import {
  checkPassword, createSessionCookieValue, verifySessionCookie, SESSION_COOKIE_NAME,
} from "./auth.ts";
import {
  installPage, notFoundPage, loginPage, uploadPage, tokensPage,
} from "./views.ts";
import { promises as fs } from "node:fs";

const app = new Hono();

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

// HTML forms can't issue DELETE; the revoke button posts here.
app.post("/tokens/:id/revoke", async (c) => {
  if (!hasSession(c)) return c.redirect("/login");
  await revokeToken(c.req.param("id"));
  return c.redirect("/tokens");
});

app.delete("/tokens/:id", async (c) => {
  if (!hasSession(c)) return c.json({ error: "unauthorized" }, 401);
  const ok = await revokeToken(c.req.param("id"));
  return c.json({ revoked: ok });
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
    const ipaBytes = new Uint8Array(await file.arrayBuffer());

    let info;
    try {
      info = await parseIpa(ipaBytes, file.name);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }

    const { id, meta } = await saveUpload({ info, ipaBytes, originalFilename: file.name });

    return c.json({
      id,
      install_url: `${config.publicBaseUrl}/i/${id}`,
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
  if (!meta) return c.text("Not found", 404);
  const xml = await fs.readFile(manifestPath(id), "utf8").catch(() => null);
  if (xml === null) return c.text("Not found", 404);
  // Some iOS versions reject the manifest with any other Content-Type.
  return c.body(xml, 200, { "Content-Type": "text/xml; charset=utf-8" });
});

app.get("/i/:id/app.ipa", async (c) => {
  const id = c.req.param("id");
  const meta = await loadLiveMeta(id);
  if (!meta) return c.text("Not found", 404);
  const bytes = await fs.readFile(ipaPath(id)).catch(() => null);
  if (bytes === null) return c.text("Not found", 404);
  return c.body(bytes, 200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${meta.bundleId}.ipa"`,
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
