// Human session cookies for the /login flow. Stateless by design: the cookie
// carries its own HMAC-SHA256 signature over an expiry, so there is no
// server-side session store to keep, scale, or invalidate on restart.

import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";

export const SESSION_COOKIE_NAME = "ota_session";

function sign(payloadB64: string): string {
  return createHmac("sha256", config.sessionSecret).update(payloadB64).digest("hex");
}

export function checkPassword(presented: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(config.adminPassword);
  // Length guard first (timingSafeEqual requires equal lengths). The remaining
  // compare runs in constant time so a correct-length guess can't be probed.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createSessionCookieValue(): string {
  const exp = Date.now() + config.sessionTtlHours * 3_600_000;
  const payloadB64 = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return payloadB64 + "." + sign(payloadB64);
}

export function verifySessionCookie(value: string | undefined): boolean {
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;

  const payloadB64 = value.slice(0, dot);
  const sig = value.slice(dot + 1);

  const expectedSig = sign(payloadB64);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  // Reject before trusting the payload: an unsigned/forged cookie must not pass.
  if (sigBuf.length !== expectedBuf.length) return false;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return false;

  try {
    const { exp } = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    return typeof exp === "number" && exp >= Date.now();
  } catch {
    return false;
  }
}
