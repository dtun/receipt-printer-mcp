// The page at /: how to add this printer to Claude, styled as a receipt so
// it can be sent to family as a link. Lists no addresses (the repo is public).

export function setupPage(base) {
  const url = `${base}/mcp`.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(
    `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receipt Printer Setup</title>
<style>
:root{--desk:#d9cfc0;--paper:#fffdf7;--ink:#1d1b18;--faint:#8a8378;--accent:#c2410c}
@media (prefers-color-scheme:dark){:root{--desk:#1f1c19}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--desk);color:var(--ink);font:15px/1.55 ui-monospace,"SF Mono",Menlo,Consolas,monospace;display:flex;justify-content:center;padding:32px 16px 64px}
.slot{width:100%;max-width:400px;animation:feed 1.1s cubic-bezier(.2,.7,.3,1) both}
@keyframes feed{from{transform:translateY(-40px);opacity:0;clip-path:inset(0 0 100% 0)}to{transform:none;opacity:1;clip-path:inset(0 0 -20px 0)}}
@media (prefers-reduced-motion:reduce){.slot{animation:none}}
.receipt{background:var(--paper);padding:28px 22px 36px;box-shadow:0 18px 40px -18px rgba(0,0,0,.45);position:relative}
.receipt::after{content:"";position:absolute;left:0;right:0;bottom:-10px;height:10px;background:linear-gradient(-45deg,transparent 7px,var(--paper) 0),linear-gradient(45deg,transparent 7px,var(--paper) 0);background-size:14px 10px;background-position:left top}
h1{font-size:20px;letter-spacing:.18em;text-align:center;margin:0}
.sub{text-align:center;color:var(--faint);margin:2px 0 0;font-size:13px}
.rule{border:0;border-top:2px dashed var(--faint);margin:20px 0;opacity:.6}
ol{list-style:none;padding:0;margin:0;counter-reset:step}
li{counter-increment:step;display:grid;grid-template-columns:2.2em 1fr;margin:0 0 16px}
li::before{content:counter(step,decimal-leading-zero);color:var(--accent);font-weight:700}
b{font-weight:700}
.url{margin:10px 0 0;border:2px solid var(--ink);padding:10px;word-break:break-all;font-size:13px;user-select:all}
button{font:inherit;font-weight:700;letter-spacing:.12em;width:100%;margin-top:8px;padding:14px;border:0;background:var(--ink);color:var(--paper);cursor:pointer;transition:transform .08s}
button:active{transform:scale(.98)}
button.done{background:var(--accent)}
.try{margin:0;padding:0;list-style:none}
.try p{margin:0 0 6px;padding-left:2ch;text-indent:-2ch}
.try p::before{content:"> ";color:var(--accent)}
.total{display:flex;justify-content:space-between;font-weight:700;font-size:17px}
.bars{height:44px;margin:22px auto 6px;width:80%;background:repeating-linear-gradient(90deg,var(--ink) 0 2px,transparent 2px 4px,var(--ink) 4px 7px,transparent 7px 9px,var(--ink) 9px 10px,transparent 10px 13px)}
.thanks{text-align:center;color:var(--faint);font-size:12px;margin:0}
</style>
<div class="slot"><main class="receipt">
  <h1>RECEIPT PRINTER</h1>
  <p class="sub">setup for Claude · 1 of 1</p>
  <hr class="rule">
  <ol>
    <li><span>Open Claude and go to <b>Settings → Connectors</b>.</span></li>
    <li><span>Tap <b>Add custom connector</b>. Name it <b>Receipt printer</b>.</span></li>
    <li><span>Paste this as the URL:
      <div class="url" id="url">${url}</div>
      <button id="copy" type="button">COPY URL</button></span></li>
    <li><span>Tap <b>Connect</b>. Type your email, then the 6-digit code we email you.</span></li>
  </ol>
  <hr class="rule">
  <div class="try">
    <p>print my grocery list</p>
    <p>print a note that says I love you</p>
    <p>is the printer on?</p>
  </div>
  <hr class="rule">
  <div class="total"><span>TOTAL</span><span>$0.00</span></div>
  <div class="bars" aria-hidden="true"></div>
  <p class="thanks">THANK YOU · PLEASE COME AGAIN</p>
</main></div>
<script>
const btn = document.getElementById("copy");
btn.addEventListener("click", async () => {
  const text = document.getElementById("url").textContent;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    getSelection().selectAllChildren(document.getElementById("url"));
    document.execCommand("copy");
  }
  btn.textContent = "COPIED ✓";
  btn.classList.add("done");
  setTimeout(() => { btn.textContent = "COPY URL"; btn.classList.remove("done"); }, 2000);
});
</script>
</html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY" } },
  );
}
