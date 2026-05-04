"""Standalone WhatsApp Manager page served at sera.jonhdev.io/wa.

Why a self-contained HTML and not the SPA: the seraphine backend
serves API only; the React app lives in Tauri (desktop/iOS) and is
not bundled into the public domain. Inlining the manager as a single
HTMLResponse keeps deploy zero-touch — no extra container, no static
file mount, no build step in CI.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter()


_PAGE = """<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>WhatsApp Bridges — Seraphine</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; padding: 32px 24px;
    background: #06091A; color: #EEF2FF;
    font-family: "DM Sans", system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1100px; margin: 0 auto; }
  header { margin-bottom: 28px; display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
  .sub { color: #8B9CC8; font-size: 13px; }
  .meta { margin-left: auto; color: #4D5E8A; font-size: 12px; }
  .grid {
    display: grid; gap: 18px;
    grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
  }
  .card {
    background: #0C1228;
    border: 1px solid rgba(99,130,255,0.10);
    border-radius: 16px;
    padding: 20px;
    display: flex; flex-direction: column; gap: 14px;
  }
  .row { display: flex; align-items: center; gap: 10px; }
  .dot { width: 8px; height: 8px; border-radius: 999px; }
  .label { margin: 0; font-size: 18px; font-weight: 600; }
  .badge {
    margin-left: auto; font-size: 11px; color: #8B9CC8;
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  dl {
    margin: 0; display: grid;
    grid-template-columns: auto 1fr; gap: 6px 14px;
    font-size: 13px; color: #8B9CC8;
  }
  dl dd { margin: 0; color: #EEF2FF; font-variant-numeric: tabular-nums; }
  .qr-wrap {
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    padding: 14px; border-radius: 12px;
    background: rgba(245,166,35,0.05);
    border: 1px solid rgba(245,166,35,0.20);
  }
  .qr-img {
    width: 220px; height: 220px;
    background: white; padding: 8px; border-radius: 8px;
  }
  .qr-placeholder {
    width: 220px; height: 220px;
    display: grid; place-items: center;
    color: #F5A623; font-size: 12px;
  }
  .qr-hint { font-size: 11px; color: #F5A623; text-align: center; }
  .recent-title {
    font-size: 11px; color: #4D5E8A;
    text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px;
  }
  .recent-list {
    list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column; gap: 6px;
    max-height: 200px; overflow-y: auto;
  }
  .recent-list li {
    font-size: 12px; display: flex; gap: 8px;
    padding: 6px 8px; border-radius: 8px;
    border: 1px solid rgba(99,130,255,0.06);
  }
  .recent-list li.fromMe { background: rgba(45,212,191,0.06); }
  .recent-list li.fromOther { background: rgba(255,255,255,0.03); }
  .recent-list .who { min-width: 70px; font-weight: 500; }
  .recent-list .who.me { color: #2DD4BF; }
  .recent-list .who.them { color: #7DA4FF; }
  .recent-list .body {
    color: #EEF2FF; flex: 1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .recent-list .when { color: #4D5E8A; min-width: 60px; text-align: right; }
  footer { display: flex; gap: 8px; margin-top: auto; }
  button {
    flex: 1; padding: 8px 12px; border-radius: 8px;
    font: inherit; font-size: 12px; cursor: pointer;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(99,130,255,0.20);
    color: #8B9CC8;
  }
  button:hover:not(:disabled) { background: rgba(255,255,255,0.07); color: #EEF2FF; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.danger {
    color: #FF5B72;
    background: rgba(255,91,114,0.08);
    border-color: rgba(255,91,114,0.30);
  }
  button.danger:hover:not(:disabled) { background: rgba(255,91,114,0.14); }
  .err {
    padding: 14px; border-radius: 10px; font-size: 13px;
    background: rgba(255,91,114,0.08);
    border: 1px solid rgba(255,91,114,0.20);
    color: #FF5B72; margin-bottom: 16px;
  }
  .card-err { color: #FF5B72; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>WhatsApp Bridges</h1>
    <span class="sub">Manager unificado · Seraphine + Aura</span>
    <span class="meta" id="meta">carregando…</span>
  </header>
  <div id="err" class="err" hidden></div>
  <div id="grid" class="grid"></div>
</div>
<script>
  const STATUS_DOT = {
    ready: "#2DD4BF",
    qr_pending: "#F5A623",
    authenticating: "#7DA4FF",
    disconnected: "#FF5B72",
    unreachable: "#FF5B72",
  };

  function fmtUptime(s) {
    if (!s) return "—";
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return h + "h " + m + "m";
    if (m > 0) return m + "m " + sec + "s";
    return sec + "s";
  }
  function fmtPhone(phone) {
    if (!phone) return "—";
    const d = phone.replace(/\\D/g, "");
    if (d.length >= 12 && d.startsWith("55")) {
      return "+55 " + d.slice(2,4) + " " + d.slice(4, -4) + "-" + d.slice(-4);
    }
    return phone.startsWith("+") ? phone : ("+" + phone);
  }
  function fmtRel(ts) {
    const s = Math.round((Date.now() - ts * 1000) / 1000);
    if (s < 60) return s + "s atrás";
    if (s < 3600) return Math.round(s/60) + "m atrás";
    if (s < 86400) return Math.round(s/3600) + "h atrás";
    return Math.round(s/86400) + "d atrás";
  }
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") e.className = attrs[k];
      else if (k === "style") Object.assign(e.style, attrs[k]);
      else if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else if (k === "dataset") Object.assign(e.dataset, attrs[k]);
      else if (k === "html") e.innerHTML = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    if (children) for (const c of [].concat(children)) {
      if (c == null || c === false) continue;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return e;
  }

  // Per-bridge in-memory state
  const state = new Map(); // slug -> {qr, qrAge, recent}

  async function fetchJson(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  async function refreshBridges() {
    try {
      const d = await fetchJson("/wa-manager/bridges");
      document.getElementById("err").hidden = true;
      document.getElementById("meta").textContent =
        d.bridges.length + " bridge" + (d.bridges.length === 1 ? "" : "s");
      render(d.bridges);
      // refresh QR + recent for any qr_pending / ready
      d.bridges.forEach((b) => {
        if (b.status === "qr_pending") refreshQr(b.slug);
        if (b.status === "ready") refreshRecent(b.slug);
      });
    } catch (e) {
      const err = document.getElementById("err");
      err.textContent = "Falha ao carregar: " + e.message;
      err.hidden = false;
    }
  }

  async function refreshQr(slug) {
    try {
      const d = await fetchJson("/wa-manager/" + slug + "/qr");
      const s = state.get(slug) || {};
      s.qr = d.qr || null;
      s.qrAge = d.expires_in_s || null;
      state.set(slug, s);
      const wrap = document.querySelector('[data-qr="' + slug + '"]');
      if (wrap) renderQrInto(wrap, s);
    } catch {}
  }

  async function refreshRecent(slug) {
    try {
      const d = await fetchJson("/wa-manager/" + slug + "/recent?limit=8");
      const s = state.get(slug) || {};
      s.recent = d.messages || [];
      state.set(slug, s);
      const list = document.querySelector('[data-recent="' + slug + '"]');
      if (list) renderRecentInto(list, s.recent);
    } catch {}
  }

  function renderQrInto(wrap, s) {
    wrap.innerHTML = "";
    if (s.qr) {
      wrap.appendChild(el("img", { class: "qr-img", src: s.qr, alt: "QR code" }));
      wrap.appendChild(el("div", { class: "qr-hint" },
        (s.qrAge ? "expira em ~" + s.qrAge + "s" : "rotaciona a cada ~20s") +
        " · escaneia em Configurações → Aparelhos conectados → Conectar aparelho"
      ));
    } else {
      wrap.appendChild(el("div", { class: "qr-placeholder" }, "aguardando próximo QR…"));
      wrap.appendChild(el("div", { class: "qr-hint" }, "rotaciona a cada ~20s"));
    }
  }

  function renderRecentInto(list, messages) {
    list.innerHTML = "";
    if (!messages || !messages.length) {
      list.appendChild(el("li", { class: "fromOther" },
        el("span", { class: "body", style: { color: "#4D5E8A" } }, "sem atividade recente")
      ));
      return;
    }
    messages.forEach((m) => {
      const li = el("li", { class: m.fromMe ? "fromMe" : "fromOther" }, [
        el("span", { class: "who " + (m.fromMe ? "me" : "them") },
          m.fromMe ? "Aura" : (m.author || m.chatName || "?").slice(0, 14)
        ),
        el("span", { class: "body" }, m.body || "[" + m.chatName + "]"),
        el("span", { class: "when" }, fmtRel(m.timestamp)),
      ]);
      list.appendChild(li);
    });
  }

  async function logout(slug, label, wipe) {
    const msg = wipe
      ? "Desconectar " + label + " E APAGAR a sessão? Vai precisar escanear QR de novo."
      : "Desconectar " + label + "? A sessão fica salva e reconecta sozinha no próximo restart.";
    if (!confirm(msg)) return;
    try {
      await fetch("/wa-manager/" + slug + "/logout" + (wipe ? "?wipe=true" : ""), { method: "POST" });
    } catch {}
    refreshBridges();
  }

  function render(bridges) {
    const grid = document.getElementById("grid");
    grid.innerHTML = "";
    bridges.forEach((b) => {
      const dot = el("span", { class: "dot", style: {
        background: STATUS_DOT[b.status] || "#8B9CC8",
        boxShadow: "0 0 6px " + (STATUS_DOT[b.status] || "#8B9CC8") + "55",
      } });
      const header = el("div", { class: "row" }, [
        dot,
        el("h2", { class: "label" }, b.label),
        el("span", { class: "badge" }, b.status),
      ]);
      const dl = el("dl", null, [
        el("dt", null, "Telefone"),
        el("dd", null, fmtPhone(b.phone)),
        el("dt", null, "Nome"),
        el("dd", null, b.name || "—"),
        el("dt", null, "Uptime"),
        el("dd", null, fmtUptime(b.uptime_s)),
      ]);
      const card = el("div", { class: "card" });
      card.appendChild(header);
      if (b.error) card.appendChild(el("div", { class: "card-err" }, b.error));
      card.appendChild(dl);

      if (b.status === "qr_pending") {
        const wrap = el("div", { class: "qr-wrap", dataset: { qr: b.slug } });
        const cached = state.get(b.slug);
        renderQrInto(wrap, cached || {});
        card.appendChild(wrap);
      }
      if (b.status === "ready") {
        const wrap = el("div");
        wrap.appendChild(el("div", { class: "recent-title" }, "Atividade recente"));
        const list = el("ul", { class: "recent-list", dataset: { recent: b.slug } });
        const cached = state.get(b.slug);
        renderRecentInto(list, (cached && cached.recent) || []);
        wrap.appendChild(list);
        card.appendChild(wrap);
      }

      const footer = el("footer", null, [
        el("button", {
          onClick: () => logout(b.slug, b.label, false),
          disabled: b.status === "unreachable" ? "true" : null,
        }, "Desconectar"),
        el("button", {
          class: "danger",
          onClick: () => logout(b.slug, b.label, true),
          disabled: b.status === "unreachable" ? "true" : null,
        }, "Reset (apaga sessão)"),
      ]);
      card.appendChild(footer);
      grid.appendChild(card);
    });
  }

  refreshBridges();
  setInterval(refreshBridges, 5000);
</script>
</body>
</html>
"""


@router.get("/wa", response_class=HTMLResponse, include_in_schema=False)
async def wa_manager_page() -> HTMLResponse:
    return HTMLResponse(_PAGE)
