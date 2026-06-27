import QRCode from "qrcode";
import type { AppMeta, TokenPublic } from "./types";
import { config } from "./config";

// App names/labels come from uploaded IPAs and user input — attacker-influenceable.
// Interpolating them raw into HTML is stored XSS; every dynamic value goes through esc().
function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  padding:24px;background:#16181d;color:#e6e8eb;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  line-height:1.5;-webkit-text-size-adjust:100%}
.card{width:100%;max-width:420px;background:#1f232b;border:1px solid #2c313c;border-radius:16px;
  padding:28px 24px;box-shadow:0 8px 30px rgba(0,0,0,.35);text-align:center}
h1{font-size:1.4rem;margin:0 0 4px}
.muted{color:#8b94a3;font-size:.85rem;word-break:break-all}
.ver{color:#b6bdc8;font-size:1rem;margin:2px 0 18px}
.btn{display:block;width:100%;padding:14px 18px;border:0;border-radius:12px;cursor:pointer;
  background:#3b82f6;color:#fff;font-size:1.05rem;font-weight:600;text-decoration:none;text-align:center}
.btn:active{background:#2f6fd6}
img.qr{width:200px;height:200px;border-radius:12px;background:#fff;padding:8px;margin:22px auto 6px}
.note{color:#8b94a3;font-size:.8rem;margin-top:12px}
form{text-align:left;margin:0}
label{display:block;font-size:.85rem;color:#b6bdc8;margin:14px 0 6px}
input[type=text],input[type=password]{width:100%;padding:12px;border-radius:10px;border:1px solid #2c313c;
  background:#14171c;color:#e6e8eb;font-size:1rem}
.drop{margin:8px 0 4px;padding:26px;border:2px dashed #39404d;border-radius:12px;text-align:center;
  color:#8b94a3;cursor:pointer;transition:border-color .15s,background .15s}
.drop.over{border-color:#3b82f6;background:#1a2230;color:#cdd5e0}
.drop input[type=file]{display:none}
.err{background:#3a1d22;border:1px solid #5b2a31;color:#f3b7bf;padding:10px 12px;border-radius:10px;
  font-size:.85rem;margin-bottom:14px}
.secretbox{display:flex;gap:8px;align-items:stretch;text-align:left}
.secretbox input{flex:1;min-width:0;background:#14171c;border:1px solid #2c313c;border-radius:10px;
  color:#e6e8eb;padding:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem}
.iconbtn{border:1px solid #2c313c;background:#262c36;color:#cdd5e0;border-radius:10px;padding:0 12px;
  cursor:pointer;font-size:.95rem}
.copybtn{border:1px solid #2c313c;background:#262c36;color:#cdd5e0;border-radius:10px;padding:0 14px;
  cursor:pointer;font-size:.85rem;font-weight:600;white-space:nowrap}
.copybtn:active{background:#2f6fd6;color:#fff}
.copybtn.copied{background:#1f3d2f;border-color:#2f6f4f;color:#5dd39e}
.warn{color:#f0c674;font-size:.8rem;margin:10px 0 0}
table{width:100%;border-collapse:collapse;margin-top:18px;font-size:.85rem;text-align:left}
th,td{padding:8px 6px;border-bottom:1px solid #2c313c;vertical-align:top}
th{color:#8b94a3;font-weight:600}
.status-revoked{color:#8b94a3}
.status-active{color:#5dd39e}
.link{display:inline-block;margin-top:18px;color:#7aa7ff;font-size:.85rem;text-decoration:none}
button.inline{background:none;border:1px solid #5b2a31;color:#f3b7bf;border-radius:8px;padding:5px 10px;
  font-size:.8rem;cursor:pointer}
.spacer{margin-top:18px}
</style>
</head>
<body><main class="card">${body}</main></body>
</html>`;
}

export async function installPage(args: {
  id: string;
  meta: AppMeta;
  installLink: string;
  pageUrl: string;
}): Promise<string> {
  const { meta, installLink, pageUrl } = args;
  // QR encodes the https page URL, not the itms-services:// link: scanners handle https
  // far more reliably, and the user then taps Install from Safari on this same page.
  const qr = await QRCode.toDataURL(pageUrl);
  const body = `
<h1>${esc(meta.name)}</h1>
<div class="ver">Version ${esc(meta.version)} (${esc(meta.build)})</div>
<div class="muted">${esc(meta.bundleId)}</div>
<a class="btn spacer" href="${esc(installLink)}">Install</a>
<img class="qr" src="${qr}" alt="QR code">
<div class="muted">Scan with another iPhone to open this page.</div>
<div class="note">Open in Safari. Expires in ${esc(config.ttlHours)} hours.</div>`;
  return layout(meta.name, body);
}

export function notFoundPage(): string {
  return layout(
    "Not found",
    `<h1>Link unavailable</h1>
<p class="muted">This link has expired or doesn't exist.</p>`,
  );
}

export function loginPage(error?: string): string {
  const body = `
<h1>Sign in</h1>
${error ? `<div class="err">${esc(error)}</div>` : ""}
<form method="POST" action="/login">
<label for="pw">Password</label>
<input id="pw" name="password" type="password" autofocus required>
<button class="btn spacer" type="submit">Sign in</button>
</form>`;
  return layout("Sign in", body);
}

export function uploadPage(): string {
  const body = `
<h1>Upload IPA</h1>
<form method="POST" action="/upload" enctype="multipart/form-data">
<label class="drop" id="drop">
  <span id="droptext">Drop an .ipa here or tap to choose</span>
  <input type="file" name="file" accept=".ipa" required>
</label>
<button class="btn spacer" type="submit">Upload</button>
</form>
<a class="link" href="/tokens">Manage CI tokens</a>
<script>
(function(){
  var d=document.getElementById('drop'),t=document.getElementById('droptext'),
      i=d.querySelector('input');
  function show(){t.textContent=i.files&&i.files.length?i.files[0].name:'Drop an .ipa here or tap to choose'}
  i.addEventListener('change',show);
  ['dragenter','dragover'].forEach(function(e){d.addEventListener(e,function(ev){ev.preventDefault();d.classList.add('over')})});
  ['dragleave','drop'].forEach(function(e){d.addEventListener(e,function(ev){ev.preventDefault();d.classList.remove('over')})});
  d.addEventListener('drop',function(ev){if(ev.dataTransfer&&ev.dataTransfer.files.length){i.files=ev.dataTransfer.files;show()}});
})();
</script>`;
  return layout("Upload", body);
}

export function tokensPage(tokens: TokenPublic[], newSecret?: string): string {
  const rows = tokens
    .map(
      (t) => `<tr>
<td>${esc(t.label)}</td>
<td>${esc(fmtDate(t.createdAt))}</td>
<td>${t.lastUsedAt ? esc(fmtDate(t.lastUsedAt)) : "never"}</td>
<td class="statuscell ${t.revoked ? "status-revoked" : "status-active"}">${t.revoked ? "revoked" : "active"}</td>
<td>${
        t.revoked
          ? ""
          : `<form class="revoke" method="POST" action="/tokens/${esc(t.id)}/revoke" data-id="${esc(t.id)}"><button class="inline" type="submit">Revoke</button></form>`
      }</td>
</tr>`,
    )
    .join("");

  const body = `
<h1>CI tokens</h1>
${
  newSecret
    ? `<div class="secretbox">
  <input id="secretval" type="password" value="${esc(newSecret)}" readonly aria-label="New token">
  <button class="iconbtn" id="revealbtn" type="button" aria-label="Reveal token">👁</button>
  <button class="copybtn" id="copybtn" type="button">Copy</button>
</div>
<p class="warn">Auto-copied to your clipboard — it won't be shown again.</p>
<script>
(function(){
  var inp=document.getElementById('secretval'),
      cp=document.getElementById('copybtn'),
      rv=document.getElementById('revealbtn');
  function done(){cp.textContent='Copied!';cp.classList.add('copied');
    setTimeout(function(){cp.textContent='Copy';cp.classList.remove('copied')},1500)}
  function legacy(){var t=inp.type;inp.type='text';inp.select();
    try{document.execCommand('copy');done()}catch(e){}inp.type=t}
  function copy(){
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(inp.value).then(done,legacy);
    }else{legacy()}
  }
  cp.addEventListener('click',copy);
  rv.addEventListener('click',function(){inp.type=inp.type==='password'?'text':'password'});
  copy(); // clipboard write on first render may need a gesture; the Copy button is the reliable fallback
})();
</script>`
    : ""
}
<form method="POST" action="/tokens">
<label for="label">New token label</label>
<input id="label" name="label" type="text" required>
<button class="btn spacer" type="submit">Create token</button>
</form>
<table>
<thead><tr><th>Label</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr></thead>
<tbody>${rows || `<tr><td colspan="5" class="muted">No tokens yet.</td></tr>`}</tbody>
</table>
<a class="link" href="/">Back</a>
<script>
// Revoke deletes the token server-side; show "revoked" in place without a reload
// (it's gone from storage, so a refresh drops the row). No-JS just posts the form.
document.querySelectorAll('form.revoke').forEach(function(f){
  f.addEventListener('submit',function(ev){
    if(!window.fetch) return; // let the plain POST handle it
    ev.preventDefault();
    fetch('/tokens/'+f.getAttribute('data-id'),{method:'DELETE'}).then(function(r){
      if(!r.ok){f.submit();return}
      var row=f.closest('tr'),cell=row&&row.querySelector('.statuscell');
      if(cell){cell.textContent='revoked';cell.className='statuscell status-revoked'}
      f.remove();
    }).catch(function(){f.submit()});
  });
});
</script>`;
  return layout("CI tokens", body);
}
