// toprr web GUI. Keys live server-side; only masked hints are ever returned.

const $ = (id) => document.getElementById(id);
let allCountries = [];
let selectedServices = new Set();
let serviceMeta = {}; // id -> { name, logo }
let savedProfiles = { radarr: {}, sonarr: {} };
let currentPlan = [];
let sortKey = "score";
let sortDir = -1; // -1 desc, 1 asc

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2500);
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  // CSRF: custom header required by the server for cookie-authed mutations.
  headers["X-Requested-With"] = "toprr";
  const res = await fetch(path, { ...opts, headers, credentials: "same-origin" });
  if (res.status === 401) {
    // Session missing/expired -> show the auth gate instead of erroring.
    showAuthGate();
    throw new Error("Not authenticated");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- Spinner ----
// Browser port of the ora-based CLI spinner: same braille frames and the same
// succeed()/fail()/start()/stop() + `text` API. Instead of a TTY it renders
// into a DOM element. All active spinners share one ticker (and honor
// prefers-reduced-motion by holding a single frame).
const ORA_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const _reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const _spinners = new Set();
let _spinTick = 0;
let _spinTimer = null;
function _ensureTicker() {
  if (_spinTimer || _reduceMotion) return;
  _spinTimer = setInterval(() => {
    _spinTick = (_spinTick + 1) % ORA_FRAMES.length;
    for (const s of _spinners) s._paint();
    // Also animate "orphan" static spinners (inline markup not backed by a
    // Spinner object, e.g. per-row status cells) so they spin too.
    const frame = ORA_FRAMES[_spinTick];
    document.querySelectorAll(".spinner.spinning .spin-glyph").forEach((g) => {
      if (!g.dataset.managed) g.textContent = frame;
    });
  }, 80);
}
// Keep the ticker alive while any static spinner exists on the page.
function _hasStaticSpinners() {
  return document.querySelector(".spinner.spinning .spin-glyph:not([data-managed])") != null;
}
function _maybeStopTicker() {
  if (_spinTimer && _spinners.size === 0 && !_hasStaticSpinners()) { clearInterval(_spinTimer); _spinTimer = null; }
}

class Spinner {
  // `target` is a DOM element (or id) to render into; `text` is the label.
  constructor(target, text = "") {
    this.el = typeof target === "string" ? document.getElementById(target) : target;
    this._text = text;
    this._state = "idle"; // idle | spinning | ok | fail
    this.enabled = true;
  }
  set text(t) { this._text = t; this._paint(); }
  get text() { return this._text; }
  get isSpinning() { return this._state === "spinning"; }

  _mark() {
    if (this._state === "ok") return "✓";
    if (this._state === "fail") return "✗";
    return _reduceMotion ? ORA_FRAMES[0] : ORA_FRAMES[_spinTick];
  }
  _paint() {
    if (!this.el) return;
    this.el.innerHTML =
      `<span class="spinner ${this._state === "spinning" ? "spinning" : this._state}">` +
      `<span class="spin-glyph" data-managed="1" aria-hidden="true">${this._mark()}</span>` +
      `<span class="spin-text">${esc(this._text)}</span></span>`;
    // Live-region semantics so screen readers hear state changes.
    this.el.setAttribute("role", "status");
    this.el.setAttribute("aria-live", "polite");
  }
  start(text) {
    if (!this.enabled) return this;
    if (text !== undefined) this._text = text;
    this._state = "spinning";
    _spinners.add(this);
    _ensureTicker();
    this._paint();
    return this;
  }
  succeed(text) {
    if (!this.enabled) return this;
    if (text !== undefined) this._text = text;
    this._state = "ok";
    _spinners.delete(this); _maybeStopTicker();
    this._paint();
    return this;
  }
  fail(text) {
    if (text !== undefined) this._text = text;
    this._state = "fail";
    _spinners.delete(this); _maybeStopTicker();
    this._paint();
    return this;
  }
  stop() {
    this._state = "idle";
    _spinners.delete(this); _maybeStopTicker();
    if (this.el) this.el.innerHTML = "";
    return this;
  }
}

// Convenience: render a centered, immediately-spinning spinner into `el`.
function spinnerCenter(el, text = "Loading…") {
  const target = typeof el === "string" ? document.getElementById(el) : el;
  if (!target) return null;
  target.innerHTML = `<div class="spinner-center"><span class="spin-slot"></span></div>`;
  const sp = new Spinner(target.querySelector(".spin-slot"), text);
  return sp.start();
}
// Convenience: inline spinner markup string (static first frame) for use
// inside larger innerHTML templates where a live object isn't needed.
function spinnerInline(text = "") {
  // Ensure the shared ticker runs so these static spinners animate once the
  // returned markup is inserted into the DOM.
  queueMicrotask(_ensureTicker);
  return `<span class="spinner spinning"><span class="spin-glyph" aria-hidden="true">${ORA_FRAMES[0]}</span><span class="spin-text">${esc(text)}</span></span>`;
}

function pill(ok, label) {
  const cls = ok === true ? "ok" : ok === false ? "err" : "muted";
  const dot = ok === null || ok === undefined ? "○" : "●";
  return `<span class="pill ${cls}">${dot} ${esc(label)}</span>`;
}
function tmdbUrl(mediaType, tmdbId) {
  return `https://www.themoviedb.org/${mediaType === "tv" ? "tv" : "movie"}/${tmdbId}`;
}
function imdbUrl(imdbId) { return `https://www.imdb.com/title/${imdbId}/`; }

// ---- Details modal ----
// Shows the rich info toprr already has for a title (poster, overview, cast,
// crew, runtime/seasons, genres, services) — no extra API calls. IMDb/TMDB are
// offered as optional "more info" links. Works from both the plan and history.
function openDetailsModal(e) {
  if (!e) return;
  const isTv = e.mediaType === "tv";
  const runtimeTxt = isTv
    ? (e.seasonCount != null ? `${e.seasonCount} season${e.seasonCount === 1 ? "" : "s"}${e.episodes != null || e.episodeCount != null ? ` · ${e.episodes ?? e.episodeCount} episodes` : ""}` : "")
    : (e.runtime ? `${e.runtime} min` : "");
  const crew = isTv
    ? (e.creators && e.creators.length ? `<div class="dt-row"><span>Creator</span><b>${esc(e.creators.join(", "))}</b></div>` : "")
    : (e.directors && e.directors.length ? `<div class="dt-row"><span>Director</span><b>${esc(e.directors.join(", "))}</b></div>` : "");
  const castTxt = e.cast && e.cast.length ? `<div class="dt-row"><span>Cast</span><b>${esc(e.cast.slice(0, 6).join(", "))}</b></div>` : "";
  const genresTxt = (e.genres && e.genres.length) ? `<div class="dt-chips">${e.genres.map((g) => `<span class="dt-genre">${esc(g)}</span>`).join("")}</div>` : "";
  const links = [];
  if (e.tmdbId) links.push(`<a class="dt-link" href="${tmdbUrl(e.mediaType, e.tmdbId)}" target="_blank" rel="noopener">TMDB ↗</a>`);
  if (e.imdbId) links.push(`<a class="dt-link" href="${imdbUrl(e.imdbId)}" target="_blank" rel="noopener">IMDb ↗</a>`);
  const score = typeof e.tmdbScore === "number" && e.tmdbScore > 0 ? scoreBadge(e.tmdbScore)
    : (typeof e.rating === "number" && e.rating > 0 ? scoreBadge(e.rating / 10) : "");

  const el = document.createElement("div");
  el.className = "modal-backdrop";
  el.innerHTML = `
    <div class="modal dt-modal" role="dialog" aria-modal="true">
      <button type="button" class="modal-x dt-x" aria-label="Close">✕</button>
      <div class="dt-top">
        <div class="dt-poster">${e.poster ? `<img src="${esc(e.poster)}" alt="" loading="lazy" />` : `<div class="poster poster-ph">${isTv ? "📺" : "🎬"}</div>`}</div>
        <div class="dt-head">
          <h2>${esc(e.title)}${e.year ? ` <span class="muted">(${e.year})</span>` : ""}</h2>
          ${e.originalTitle && e.originalTitle !== e.title ? `<p class="muted dt-orig">${esc(e.originalTitle)}</p>` : ""}
          <div class="dt-meta">${typeBadge(e.mediaType)} ${score} ${upcomingBadge(e)} ${runtimeTxt ? `<span class="muted">${esc(runtimeTxt)}</span>` : ""}</div>
          ${genresTxt}
          <div class="dt-services">${servicesCell(e.services)}</div>
        </div>
      </div>
      ${e.overview ? `<p class="dt-overview">${esc(e.overview)}</p>` : `<p class="muted">No synopsis available.</p>`}
      ${crew}${castTxt}
      ${links.length ? `<div class="dt-links">${links.join("")}</div>` : ""}
    </div>`;
  document.body.appendChild(el);
  const close = () => { document.removeEventListener("keydown", onKey); el.remove(); };
  const onKey = (ev) => { if (ev.key === "Escape") close(); };
  el.addEventListener("click", (ev) => { if (ev.target === el) close(); });
  el.querySelector(".dt-x").addEventListener("click", close);
  document.addEventListener("keydown", onKey);
}

// ---- Tabs ----
// ---- Navigation ----
// Single source of truth for the nav. Rendered as inline tabs on desktop and a
// slide-in hamburger drawer on mobile (same markup, CSS switches the layout).
// `tab` items switch an in-page .tabpage; `href` items are external links.
const NAV_ITEMS = [
  { tab: "dashboard", label: "Dashboard" },
  { tab: "requests", label: "Requests" },
  { tab: "settings", label: "Settings" },
  { href: "/docs", label: "Documentation and API", external: true },
  { tab: "about", label: "About" },
];

function switchTab(tab) {
  document.querySelectorAll("nav.tabs [data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tabpage").forEach((p) => p.classList.toggle("active", p.id === `tab-${tab}`));
  // Lazy-load per-tab data.
  if (tab === "requests") loadHistory(true);
  if (tab === "about") loadAbout();
}

function closeNavDrawer() {
  $("navMenu").classList.remove("open");
  const scrim = $("navScrim");
  if (scrim) scrim.hidden = true;
  const t = $("navToggle");
  if (t) t.setAttribute("aria-expanded", "false");
}
function openNavDrawer() {
  $("navMenu").classList.add("open");
  const scrim = $("navScrim");
  if (scrim) scrim.hidden = false;
  const t = $("navToggle");
  if (t) t.setAttribute("aria-expanded", "true");
}

function renderNav() {
  const nav = $("navMenu");
  nav.innerHTML = NAV_ITEMS.map((it) => {
    if (it.href) {
      const ext = it.external ? ` target="_blank" rel="noopener" class="nav-ext"` : "";
      return `<a href="${it.href}"${ext}>${esc(it.label)}</a>`;
    }
    return `<button data-tab="${it.tab}"${it.tab === "dashboard" ? ' class="active"' : ""}>${esc(it.label)}</button>`;
  }).join("") + `<button id="btnLogout" title="Sign out">Sign out</button>`;

  nav.querySelectorAll("[data-tab]").forEach((btn) =>
    btn.addEventListener("click", () => { switchTab(btn.dataset.tab); closeNavDrawer(); }));
  nav.querySelectorAll("a").forEach((a) => a.addEventListener("click", closeNavDrawer));

  const toggle = $("navToggle");
  if (toggle) toggle.addEventListener("click", () =>
    nav.classList.contains("open") ? closeNavDrawer() : openNavDrawer());
  const scrim = $("navScrim");
  if (scrim) scrim.addEventListener("click", closeNavDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeNavDrawer(); });

  // "View all →" buttons that jump to a tab (e.g. dashboard recent -> requests).
  document.querySelectorAll("[data-goto]").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.goto)));
}

// ---- Status ----
function stat(label, value) {
  return `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div></div>`;
}
async function loadStatus() {
  const s = await api("/api/status");
  $("stats").innerHTML = [
    stat("Country", (s.country || "—").toUpperCase()),
    stat("Services", String((s.services || []).length)),
    stat("Requests logged", String(s.history.total)),
    stat("Failed", String(s.history.failed)),
  ].join("");
  const b = s.backends;
  const pills = [pill(s.configured.apiKey, "Streaming API")];
  pills.push(pill(s.requestReady, `Provider: ${s.requestProvider === "seerr" ? "Seerr" : "Radarr/Sonarr"}`));
  if (s.requestProvider === "seerr") pills.push(pill(s.configured.seerr, "Seerr"));
  pills.push(b.radarr.configured ? pill(b.radarr.ok, `Radarr${b.radarr.ok ? " · queue " + b.radarr.queue : ""}`) : pill(null, "Radarr"));
  pills.push(b.sonarr.configured ? pill(b.sonarr.ok, `Sonarr${b.sonarr.ok ? " · queue " + b.sonarr.queue : ""}`) : pill(null, "Sonarr"));
  $("backends").innerHTML = pills.join(" ");
  renderQuota(s.quota);
}

function renderQuota(q) {
  const el = $("quota");
  if (!el) return;
  if (!q || !q.granted) { el.style.display = "none"; return; }
  const used = q.used ?? 0, granted = q.granted;
  const pct = Math.min(100, Math.round((used / granted) * 100));
  const remaining = Math.max(0, granted - used);
  const cls = pct >= 90 ? "err" : pct >= 70 ? "warn" : "ok";
  let resets = "";
  if (q.resetAt) {
    const d = new Date(q.resetAt);
    if (!isNaN(d)) resets = ` · resets ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  }
  el.style.display = "";
  el.innerHTML = `
    <div class="quota-head">
      <span class="conn-label">Streaming API quota</span>
      <span class="quota-nums"><b>${used.toLocaleString()}</b> / ${granted.toLocaleString()} <span class="muted">(${remaining.toLocaleString()} left${resets})</span></span>
    </div>
    <div class="quota-bar"><span class="quota-fill ${cls}" style="width:${pct}%"></span></div>`;
}

// ---- History (paginated, instant render, lazy status) ----
// Requests view uses true paging (Prev/Next) with a selectable page size and
// a title search. Defaults: 20 per page on desktop, 10 on mobile.
const isNarrow = () => window.matchMedia("(max-width:720px)").matches;
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
let historyPageSize = isNarrow() ? 10 : 20;
let historyPage = 0;        // zero-based current page
let historyTotal = 0;       // total rows matching the current search
let historyQuery = "";      // current title search

function statusCellHtml(st) {
  if (!st) return spinnerInline("");
  // Live download activity takes priority — shows real-time grab progress.
  if (st.downloading) {
    const p = st.downloadProgress ?? 0;
    return `<span class="pill dl">⬇ downloading ${p}%</span><div class="bar"><span class="bar-dl" style="width:${p}%"></span></div>`;
  }
  if (st.upToDate) return pill(true, "up to date");
  if (st.inLibrary) return `${pill(false, (st.percentComplete ?? 0) + "%")}<div class="bar"><span style="width:${st.percentComplete ?? 0}%"></span></div>`;
  return pill(null, "not in library");
}

// Request cell: a plain "requested" pill, or a clickable "failed" pill that
// reveals retry/remove actions only when pressed.
function requestCellHtml(r) {
  if (r.ok) return pill(true, "requested");
  return `<div class="req-fail" data-id="${esc(r.id || "")}">
      <button type="button" class="pill err failbtn" title="Show actions">● failed ▾</button>
      <div class="fail-actions" style="display:none">
        <button type="button" class="mini retry">↻ Retry</button>
        <button type="button" class="mini remove">✕ Remove</button>
      </div>
    </div>`;
}

function historyRowHtml(r, idPrefix = "hist") {
  const seasonsTxt = r.mediaType === "tv"
    ? (r.seasons === "all" ? "all" : Array.isArray(r.seasons) ? r.seasons.map((n) => "S" + n).join(", ") : "—")
    : "—";
  const rowId = `${idPrefix}-${r.mediaType}-${r.tmdbId}-${r.requestedAt.replace(/[^0-9]/g, "")}`;
  historyById[rowId] = r;
  return `<tr id="${rowId}">
    <td class="c-poster poster-cell"><span class="detail-open" data-row="${rowId}" role="button" tabindex="0">${posterCell(r)}</span></td>
    <td class="c-title"><span class="detail-open title-link" data-row="${rowId}" role="button" tabindex="0">${esc(r.title)}</span>${r.year ? ` <span class="muted yr-inline">(${r.year})</span>` : ""}</td>
    <td data-label="Type">${typeBadge(r.mediaType)}</td>
    <td data-label="Rating" class="rating-cell">${scoreBadge(historyRating(r))}</td>
    <td data-label="Seasons" class="muted">${esc(seasonsTxt)}</td>
    <td data-label="On" class="svc-cell" data-services="${esc((r.services || []).join(","))}">${servicesCell(r.services)}</td>
    <td data-label="Request" class="req-cell">${requestCellHtml(r)}</td>
    <td data-label="Library" class="lib-cell">${statusCellHtml(r.status)}</td>
    <td data-label="When" class="muted">${new Date(r.requestedAt).toLocaleString()}</td>
  </tr>`;
}
const historyById = {};
function wireHistoryDetails() {
  document.querySelectorAll("#histBody .detail-open").forEach((n) => {
    if (n.dataset.wiredD) return; n.dataset.wiredD = "1";
    const open = () => openDetailsModal(historyById[n.dataset.row]);
    n.addEventListener("click", open);
    n.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } });
  });
}

// Build the controls bar: search box + "Show N" page-size selector.
function historyControlsHtml() {
  const opts = PAGE_SIZE_OPTIONS
    .map((n) => `<option value="${n}"${n === historyPageSize ? " selected" : ""}>${n}</option>`)
    .join("");
  return `<div class="hist-controls">
    <div class="hist-search">
      <input type="search" id="histSearch" placeholder="Search title…" aria-label="Search requests by title" value="${esc(historyQuery)}" />
    </div>
    <label class="hist-pagesize">Show
      <select id="histPageSize" aria-label="Rows per page">${opts}</select>
    </label>
  </div>`;
}

// Fetch and render the current page. `opts.resetPage` jumps back to page 0
// (used by search / page-size changes); otherwise the current page is kept.
async function loadHistory(resetPage = true) {
  if (resetPage === true) historyPage = 0;
  const offset = historyPage * historyPageSize;
  // Show a spinner for a fresh load (not for background status re-fetches).
  if (resetPage === true) spinnerCenter("historyWrap", "Loading requests…");
  let data;
  try {
    data = await api(`/api/history?limit=${historyPageSize}&offset=${offset}&q=${encodeURIComponent(historyQuery)}&status=false`);
  } catch { return; }
  historyTotal = data.total;

  // Empty states: distinguish "no requests at all" from "no search matches".
  if (!data.records.length) {
    const empty = historyQuery
      ? `<span class="muted">No requests match “${esc(historyQuery)}”.</span>`
      : `<span class="muted">No requests yet. Check for new titles and submit to populate history.</span>`;
    $("historyWrap").innerHTML = `${historyControlsHtml()}${empty}`;
    wireHistoryControls();
    renderHistoryPager();
    return;
  }

  const rowsHtml = data.records.map((r) => historyRowHtml(r)).join("");
  $("historyWrap").innerHTML = `
    ${historyControlsHtml()}
    <table class="data">
      <thead><tr><th></th><th>Title</th><th>Type</th><th>Rating</th><th>Seasons</th><th>On</th><th>Request</th><th>Library</th><th>When</th></tr></thead>
      <tbody id="histBody">${rowsHtml}</tbody>
    </table>
    <div class="hist-pager" id="histPager"></div>`;

  wireHistoryControls();
  renderHistoryPager();
  wireFailActions();
  wireHistoryDetails();

  // Lazily fetch status for just this page and patch the Library cells.
  patchHistoryStatus(offset, historyPageSize);
}

function wireHistoryControls() {
  const search = $("histSearch");
  if (search && !search.dataset.wired) {
    search.dataset.wired = "1";
    let t;
    search.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const v = search.value.trim();
        if (v === historyQuery) return;
        historyQuery = v;
        historyPage = 0;
        loadHistory(false).then(() => { const s = $("histSearch"); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } });
      }, 250);
    });
  }
  const size = $("histPageSize");
  if (size && !size.dataset.wired) {
    size.dataset.wired = "1";
    size.addEventListener("change", () => {
      historyPageSize = Number(size.value) || historyPageSize;
      historyPage = 0;
      loadHistory(false);
    });
  }
}

function renderHistoryPager() {
  const el = $("histPager");
  if (!el) return;
  const pageCount = Math.max(1, Math.ceil(historyTotal / historyPageSize));
  const start = historyTotal ? historyPage * historyPageSize + 1 : 0;
  const end = Math.min(historyTotal, (historyPage + 1) * historyPageSize);
  el.innerHTML = `
    <button id="histPrev" ${historyPage <= 0 ? "disabled" : ""}>← Prev</button>
    <span class="muted">${start}–${end} of ${historyTotal} · page ${historyPage + 1}/${pageCount}</span>
    <button id="histNext" ${historyPage >= pageCount - 1 ? "disabled" : ""}>Next →</button>`;
  const prev = $("histPrev"), next = $("histNext");
  if (prev) prev.addEventListener("click", () => { if (historyPage > 0) { historyPage--; loadHistory(false); } });
  if (next) next.addEventListener("click", () => { if (historyPage < pageCount - 1) { historyPage++; loadHistory(false); } });
}

// Wire the clickable "failed" badges -> reveal retry/remove, and their actions.
function wireFailActions() {
  document.querySelectorAll(".req-fail").forEach((wrap) => {
    if (wrap.dataset.wired) return;
    wrap.dataset.wired = "1";
    const id = wrap.dataset.id;
    const actions = wrap.querySelector(".fail-actions");
    const failBtn = wrap.querySelector(".failbtn");
    failBtn.addEventListener("click", () => {
      actions.style.display = actions.style.display === "none" ? "flex" : "none";
    });
    wrap.querySelector(".retry").addEventListener("click", async () => {
      actions.innerHTML = spinnerInline("Retrying…");
      try {
        const r = await api("/api/history/retry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
        toast(r.ok ? "Retry succeeded" : "Retry failed");
        await loadHistory(true); await loadStatus();
      } catch (err) { actions.innerHTML = `<span class="muted">${esc(err.message)}</span>`; }
    });
    wrap.querySelector(".remove").addEventListener("click", async () => {
      try {
        await api("/api/history/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
        toast("Removed"); await loadHistory(true); await loadStatus();
      } catch (err) { actions.innerHTML = `<span class="muted">${esc(err.message)}</span>`; }
    });
  });
}

async function patchHistoryStatus(offset, pageSize = historyPageSize) {
  try {
    const data = await api(`/api/history?limit=${pageSize}&offset=${offset}&q=${encodeURIComponent(historyQuery)}&status=true`);
    for (const r of data.records) {
      const rowId = `hist-${r.mediaType}-${r.tmdbId}-${r.requestedAt.replace(/[^0-9]/g, "")}`;
      const row = document.getElementById(rowId);
      if (!row) continue;
      const cell = row.querySelector(".lib-cell");
      if (cell) cell.innerHTML = statusCellHtml(r.status);
      // Patch in the TMDB poster once resolved.
      if (r.poster) {
        const pc = row.querySelector(".poster-cell");
        if (pc) pc.innerHTML = posterCell(r);
      }
      // Patch the rating with the live TMDB score (fills in titles the
      // Streaming Availability API returned 0/unrated for).
      const rc = row.querySelector(".rating-cell");
      if (rc) rc.innerHTML = scoreBadge(historyRating(r));
    }
  } catch { /* leave placeholders if status/poster fetch fails */ }
}

// Re-render history "On" cells once service logo metadata is available
// (history can render before loadCountries() populates serviceMeta).
function refreshHistoryServiceLogos() {
  document.querySelectorAll("#histBody .svc-cell, #recentBody .svc-cell").forEach((cell) => {
    const ids = (cell.dataset.services || "").split(",").filter(Boolean);
    cell.innerHTML = servicesCell(ids);
  });
}

// ---- Dashboard "Recent requests" preview (last 5, with live status) ----
async function loadRecent() {
  const wrap = $("recentWrap");
  if (!wrap) return;
  spinnerCenter(wrap, "Loading…");
  // 5 most-recent on mobile, 10 on desktop.
  const n = isNarrow() ? 5 : 10;
  // Keep the panel heading description in sync with the count/device.
  const desc = $("recentDesc");
  if (desc) desc.textContent = `The last ${n} titles toprr requested, with live library status.`;
  let data;
  try {
    data = await api(`/api/history?limit=${n}&offset=0&status=true`);
  } catch { return; }
  if (!data.records.length) {
    wrap.innerHTML = `<span class="muted">No requests yet. Check for new titles and submit to populate history.</span>`;
    return;
  }
  const rowsHtml = data.records.map((r) => historyRowHtml(r, "recent")).join("");
  wrap.innerHTML = `
    <table class="data">
      <thead><tr><th></th><th>Title</th><th>Type</th><th>Rating</th><th>Seasons</th><th>On</th><th>Request</th><th>Library</th><th>When</th></tr></thead>
      <tbody id="recentBody">${rowsHtml}</tbody>
    </table>`;
  // Wire detail-open handlers on the preview rows.
  wrap.querySelectorAll(".detail-open").forEach((n) => {
    const open = () => openDetailsModal(historyById[n.dataset.row]);
    n.addEventListener("click", open);
    n.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } });
  });
}

// ---- About page (version + changelog) ----
const CHANGELOG = [
  {
    version: "1.0.1", date: "2026-10",
    changes: [
      "Upcoming titles: the feed now includes announced, not-yet-streaming shows (via the Changes API), clearly marked with an “UPCOMING” badge and release date when known.",
      "TMDB: accept either the v3 API key or the v4 Read Access Token, with Test-key buttons for the Streaming Availability and TMDB keys in Settings.",
      "Static files (docs, OpenAPI) now require authentication; login-screen assets stay public.",
      "Fixes: Requests page posters/library status now load; mobile hamburger drawer covers the full screen; centered modal close button.",
    ],
  },
  {
    version: "1.0.0", date: "2026-10",
    changes: [
      "Mobile navigation: hamburger drawer with Dashboard, Requests, Settings, Documentation and API, and About.",
      "Requests split into its own section with search, selectable page size and Prev/Next paging; dashboard shows a recent-requests preview.",
      "Mobile plan sorting via a field dropdown + direction toggle; fixed card year/checkbox overlap.",
      "About page with app info, version and changelog.",
      "Web GUI: sortable dry-run plan, per-show season picker, live Radarr/Sonarr status, TMDB enrichment.",
      "First-run setup wizard, session auth and API keys for programmatic access.",
    ],
  },
];
let aboutLoaded = false;
async function loadAbout() {
  // Render the (static) changelog once.
  const cl = $("changelog");
  if (cl && !cl.dataset.rendered) {
    cl.dataset.rendered = "1";
    cl.innerHTML = CHANGELOG.map((e) => `
      <div class="cl-entry">
        <div><span class="cl-ver">v${esc(e.version)}</span><span class="cl-date">${esc(e.date)}</span></div>
        <ul>${e.changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
      </div>`).join("");
  }
  if (aboutLoaded) return;
  aboutLoaded = true;
  // Version comes from the authed /api/status (sourced from package.json).
  try {
    const s = await api("/api/status");
    const v = $("aboutVersion");
    if (v) v.textContent = s.version ? `v${s.version}` : "—";
  } catch { /* leave placeholder */ }
}


// ---- Config / Settings ----
async function loadConfig() {
  const c = await api("/api/config");
  $("country").dataset.current = c.country;
  $("limit").value = c.limit;
  $("seerrUrl").value = c.seerr.url || "";
  $("radarrUrl").value = c.radarr.url || "";
  $("sonarrUrl").value = c.sonarr.url || "";
  const hint = (m) => (m && m.set ? `current: ${m.hint}` : "not set");
  $("apiKeyHint").textContent = hint(c.apiKey);
  $("tmdbKeyHint").textContent = hint(c.tmdbApiKey);
  $("seerrKeyHint").textContent = hint(c.seerr.apiKey);
  $("radarrKeyHint").textContent = hint(c.radarr.apiKey);
  $("sonarrKeyHint").textContent = hint(c.sonarr.apiKey);
  if (c.auth) {
    if ($("acUser")) $("acUser").value = c.auth.username || "";
    if ($("apiKeyState")) $("apiKeyState").textContent = c.auth.apiKeySet
      ? "An API key is configured (shown only once when generated)."
      : "No API key configured.";
  }
  // Request provider + saved profile/root choices.
  if ($("requestProvider")) {
    $("requestProvider").value = c.requestProvider || "arr";
    toggleProviderUI();
  }
  savedProfiles = {
    radarr: { profile: c.radarr.qualityProfileId, root: c.radarr.rootFolder },
    sonarr: { profile: c.sonarr.qualityProfileId, root: c.sonarr.rootFolder },
  };
  selectedServices = new Set(c.services || []);
  // Fetch the live profile/root options for the dropdowns (best-effort).
  loadArrOptions();
  return c;
}

function toggleProviderUI() {
  const p = $("requestProvider") ? $("requestProvider").value : "arr";
  const seerr = $("seerrFields");
  if (seerr) seerr.style.display = p === "seerr" ? "" : "none";
  document.querySelectorAll(".arr-opts").forEach((el) => { el.style.display = p === "arr" ? "" : "none"; });
}

async function loadArrOptions() {
  try {
    const o = await api("/api/arr-options");
    fillOpts("radarr", o.radarr);
    fillOpts("sonarr", o.sonarr);
  } catch { /* backends may be unset; ignore */ }
}
function fillOpts(kind, data) {
  const profSel = $(`${kind}Profile`), rootSel = $(`${kind}Root`);
  if (!profSel || !rootSel) return;
  if (!data || data.error) {
    profSel.innerHTML = `<option value="">${data && data.error ? "unavailable" : "—"}</option>`;
    rootSel.innerHTML = `<option value="">${data && data.error ? "unavailable" : "—"}</option>`;
    return;
  }
  const saved = savedProfiles[kind] || {};
  profSel.innerHTML = `<option value="">— choose —</option>` +
    (data.profiles || []).map((p) => `<option value="${p.id}" ${p.id === saved.profile ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  rootSel.innerHTML = `<option value="">— choose —</option>` +
    (data.rootFolders || []).map((r) => `<option value="${esc(r.path)}" ${r.path === saved.root ? "selected" : ""}>${esc(r.path)}</option>`).join("");
}
async function loadCountries() {
  try {
    const { countries } = await api("/api/countries");
    allCountries = countries;
    // Build id -> {logo,name} map across all countries for use everywhere.
    for (const c of countries) {
      for (const s of c.services) {
        if (!serviceMeta[s.id]) serviceMeta[s.id] = { name: s.name, logo: s.logo || null };
      }
    }
    const cur = $("country").dataset.current || "us";
    $("country").innerHTML = countries.map((c) => `<option value="${c.code}" ${c.code === cur ? "selected" : ""}>${esc(c.name)} (${c.code})</option>`).join("");
    renderServices();
    // Re-render the plan so the "On" column can show logos once meta is loaded.
    if (currentPlan.length) renderPlan();
    // Re-apply service logos to any already-rendered history rows.
    refreshHistoryServiceLogos();
  } catch (err) {
    $("country").innerHTML = `<option>${esc(err.message)}</option>`;
    $("services").innerHTML = `<span class="muted">${esc(err.message)}</span>`;
  }
}
function serviceLogo(id, cls) {
  const m = serviceMeta[id];
  if (m && m.logo) return `<img class="svc-logo ${cls || ""}" src="${m.logo}" alt="${esc(m.name || id)}" title="${esc(m.name || id)}" />`;
  return `<span class="svc-text">${esc(m ? m.name : id)}</span>`;
}
function servicesCell(ids) {
  if (!ids || !ids.length) return "—";
  return `<span class="svc-list">${ids.map((id) => serviceLogo(id)).join("")}</span>`;
}
function renderServices() {
  const country = allCountries.find((c) => c.code === $("country").value);
  if (!country) return;
  $("services").innerHTML = country.services.map((s) => {
    const inner = s.logo
      ? `<img class="svc-logo" src="${s.logo}" alt="${esc(s.name)}" /> <span>${esc(s.name)}</span>`
      : esc(s.name);
    return `<span class="chip chip-svc ${selectedServices.has(s.id) ? "on" : ""}" data-id="${s.id}">${inner}</span>`;
  }).join("");
  $("services").querySelectorAll(".chip").forEach((el) => el.addEventListener("click", () => {
    const id = el.dataset.id;
    selectedServices.has(id) ? selectedServices.delete(id) : selectedServices.add(id);
    el.classList.toggle("on");
    autoSaveFeed();
  }));
}
async function save() {
  const btnId = arguments[0] || "btnSave";
  const msgId = arguments[1] || "saveMsg";
  const btn = $(btnId); const setMsg = (t) => { const m = $(msgId); if (m) m.textContent = t; };
  if (btn) btn.disabled = true; setMsg("Saving…");
  try {
    const numOrUndef = (v) => (v ? Number(v) : undefined);
    const body = {
      apiKey: $("apiKey").value, tmdbApiKey: $("tmdbKey").value,
      country: $("country").value, limit: Number($("limit").value) || 10,
      services: [...selectedServices],
      requestProvider: $("requestProvider") ? $("requestProvider").value : undefined,
      seerr: { url: $("seerrUrl").value, apiKey: $("seerrKey").value },
      radarr: {
        url: $("radarrUrl").value, apiKey: $("radarrKey").value,
        qualityProfileId: numOrUndef($("radarrProfile") && $("radarrProfile").value),
        rootFolder: ($("radarrRoot") && $("radarrRoot").value) || undefined,
      },
      sonarr: {
        url: $("sonarrUrl").value, apiKey: $("sonarrKey").value,
        qualityProfileId: numOrUndef($("sonarrProfile") && $("sonarrProfile").value),
        rootFolder: ($("sonarrRoot") && $("sonarrRoot").value) || undefined,
      },
    };
    await api("/api/config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    $("apiKey").value = $("tmdbKey").value = $("seerrKey").value = $("radarrKey").value = $("sonarrKey").value = "";
    setMsg(""); toast("Settings saved");
    await Promise.all([loadConfig(), loadStatus()]); await loadCountries();
  } catch (err) { setMsg(err.message); }
  finally { if (btn) btn.disabled = false; }
}

// Lightweight auto-save for the Feed panel (country / items / services) — no
// button, no heavy reload. Debounced so rapid chip toggles coalesce.
let feedSaveTimer = null;
let feedSaveSeq = 0;
function autoSaveFeed() {
  const note = $("saveFeedMsg");
  if (note) note.textContent = "Saving…";
  clearTimeout(feedSaveTimer);
  feedSaveTimer = setTimeout(async () => {
    const seq = ++feedSaveSeq;
    try {
      await api("/api/config", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          country: $("country").value,
          limit: Number($("limit").value) || 10,
          services: [...selectedServices],
        }),
      });
      if (seq !== feedSaveSeq) return; // a newer save superseded this one
      if (note) note.textContent = "Saved ✓";
      loadStatus(); // refresh the "Services" stat + connections
    } catch (err) {
      if (note) note.textContent = err.message;
    }
  }, 450);
}

// ---- Plan table (sortable) ----
function entryKey(e) { return `${e.mediaType}:${e.tmdbId ?? "?"}`; }

// Subtle, on-brand media-type badge with an embedded icon + label.
function typeBadge(mediaType) {
  const tv = mediaType === "tv";
  const icon = tv
    ? `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M8 3l4 3 4-3"/></svg>`
    : `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="10" width="18" height="10" rx="1.5"/><path d="M2.6 7 L19.8 4.3 L20.3 7.3 L3.1 10 Z"/><path d="M7.4 6.3 L6.1 9.6"/><path d="M12 5.5 L10.7 8.9"/><path d="M16.6 4.8 L15.3 8.2"/></svg>`;
  return `<span class="typebadge ${tv ? "tv" : "movie"}">${icon}${tv ? "TV" : "Movie"}</span>`;
}

// Badge shown next to a title that is an upcoming (not-yet-streaming) release.
function upcomingBadge(e) {
  if (!e || !e.upcoming) return "";
  let when = "coming soon";
  if (typeof e.availableAt === "number") {
    const d = new Date(e.availableAt * 1000);
    if (!isNaN(d)) when = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  return ` <span class="pill upcoming" title="Not yet streaming — ${esc(when)}">UPCOMING · ${esc(when)}</span>`;
}

function scoreBadge(v) {
  if (typeof v !== "number" || v <= 0) return `<span class="muted">—</span>`;
  const cls = v >= 7 ? "ok" : v >= 5 ? "warn" : "err";
  return `<span class="pill ${cls}">★ ${v.toFixed(1)}</span>`;
}
// Best available 0–10 score for a history row: live TMDB score first, then the
// stored Streaming Availability score (0–100 -> /10). 0/missing -> unrated.
function historyRating(r) {
  if (typeof r.tmdbScore === "number" && r.tmdbScore > 0) return r.tmdbScore;
  if (typeof r.rating === "number" && r.rating > 0) return r.rating / 10;
  return null;
}
function posterCell(e) {
  if (e.poster) return `<img class="poster" src="${e.poster}" alt="poster" loading="lazy" />`;
  return `<div class="poster poster-ph" title="No poster">${e.mediaType === "tv" ? "📺" : "🎬"}</div>`;
}

// Per-title season selection, keyed by entryKey. Value: "all" | number[].
// Default for TV is [1] (season 1 only) so old multi-season shows don't pull
// everything by accident.
const seasonSel = {};
function defaultSeasons(e) {
  return e.mediaType === "tv" ? [1] : "all";
}
function getSel(e) {
  const k = entryKey(e);
  if (!(k in seasonSel)) seasonSel[k] = defaultSeasons(e);
  return seasonSel[k];
}
function selLabel(sel, total) {
  if (sel === "all") return `All${total ? ` (${total})` : ""}`;
  if (sel.length === 1) return `S${sel[0]}`;
  if (total && sel.length === total) return `All (${total})`;
  return `${sel.length} seasons`;
}

// A compact season control for TV rows. The button opens a modal picker
// (built on demand) with click-outside / Escape / Done to close — no scroll.
function seasonsCell(e) {
  if (e.mediaType !== "tv") return `<span class="muted">—</span>`;
  const list = Array.isArray(e.seasonList) ? e.seasonList : null;
  const total = e.seasonCount ?? (list ? list.length : null);
  const key = entryKey(e);
  const sel = getSel(e);

  // Single-season shows: nothing to choose.
  if (total === 1 || (list && list.length === 1)) {
    return `<span class="muted">1 season</span>`;
  }
  const label = selLabel(sel, total);
  return `<button type="button" class="seasontoggle" data-key="${key}">${esc(label)} ▾</button>`;
}

// Index plan entries by key so the modal can look up a title's season list.
function planByKey(key) {
  return currentPlan.find((e) => entryKey(e) === key);
}

// Build and open the season picker modal for a given title.
function openSeasonModal(key) {
  const e = planByKey(key);
  if (!e) return;
  const list = Array.isArray(e.seasonList) ? e.seasonList : null;
  const total = e.seasonCount ?? (list ? list.length : null);
  const sel = getSel(e);

  const grid = list
    ? list.map((s) => {
        const checked = sel === "all" || (Array.isArray(sel) && sel.includes(s.seasonNumber));
        return `<label class="seasonbox ${checked ? "on" : ""}">
            <input type="checkbox" class="seasoncb" data-key="${key}" data-sn="${s.seasonNumber}" ${checked ? "checked" : ""}/>
            <span class="sn">S${s.seasonNumber}</span><span class="muted ep">${s.episodeCount}ep</span>
          </label>`;
      }).join("")
    : `<p class="muted" style="margin:0">Season details need a TMDB key. Choose all or season 1 only.</p>`;

  const el = document.createElement("div");
  el.className = "modal-backdrop";
  el.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <strong>${esc(e.title)} — seasons</strong>
        <button type="button" class="modal-x" aria-label="Close">✕</button>
      </div>
      <div class="modal-row">
        <button type="button" class="mini" data-act="all" data-key="${key}">All${total ? ` (${total})` : ""}</button>
        <button type="button" class="mini" data-act="none" data-key="${key}">None</button>
        <button type="button" class="mini" data-act="s1" data-key="${key}">S1 only</button>
      </div>
      <div class="seasongrid">${grid}</div>
      <div class="modal-foot">
        <span class="muted" id="modalSel"></span>
        <button type="button" class="primary modal-done">Done</button>
      </div>
    </div>`;
  document.body.appendChild(el);

  const refreshModalLabel = () => {
    const m = seasonSel[key];
    el.querySelector("#modalSel").textContent = selLabel(m, total);
    el.querySelectorAll(".seasonbox").forEach((b) => b.classList.toggle("on", b.querySelector("input").checked));
  };
  const close = () => {
    document.removeEventListener("keydown", onKey);
    el.remove();
    renderPlan(); // reflect the new label in the row
  };
  const onKey = (ev) => { if (ev.key === "Escape") close(); };

  el.addEventListener("click", (ev) => { if (ev.target === el) close(); }); // click outside
  el.querySelector(".modal-x").addEventListener("click", close);
  el.querySelector(".modal-done").addEventListener("click", close);
  el.querySelectorAll(".seasoncb").forEach((cb) => cb.addEventListener("change", () => { syncSeasonSelFromBoxes(key); refreshModalLabel(); }));
  el.querySelectorAll(".mini").forEach((btn) => btn.addEventListener("click", () => {
    const act = btn.dataset.act;
    el.querySelectorAll(`.seasoncb`).forEach((b) => {
      if (act === "all") b.checked = true;
      else if (act === "none") b.checked = false;
      else if (act === "s1") b.checked = Number(b.dataset.sn) === 1;
    });
    // No TMDB list -> no checkboxes: set selection directly.
    if (!list) seasonSel[key] = act === "all" ? "all" : [1];
    else syncSeasonSelFromBoxes(key);
    refreshModalLabel();
  }));
  document.addEventListener("keydown", onKey);
  refreshModalLabel();
}

const COLUMNS = [
  { key: "pick", label: "", sortable: false },
  { key: "poster", label: "", sortable: false },
  { key: "title", label: "Title", sortable: true, get: (e) => (e.title || "").toLowerCase() },
  { key: "type", label: "Type", sortable: true, get: (e) => e.mediaType },
  { key: "year", label: "Year", sortable: true, get: (e) => e.year ?? 0 },
  { key: "score", label: "TMDB", sortLabel: "TMDB Rating", sortable: true, get: (e) => e.tmdbScore ?? -1 },
  { key: "lang", label: "Lang", sortLabel: "Language", sortable: true, get: (e) => e.originalLanguage ?? "" },
  { key: "seasons", label: "Seasons", sortable: true, get: (e) => (e.mediaType === "tv" ? e.seasonCount ?? 0 : -1) },
  { key: "genres", label: "Genres", sortable: true, get: (e) => (e.genres || []).join(",") },
  { key: "services", label: "On", sortLabel: "Services", sortable: true, get: (e) => (e.services || []).join(",") },
];

function sortedPlan() {
  const col = COLUMNS.find((c) => c.key === sortKey);
  if (!col || !col.get) return currentPlan;
  return [...currentPlan].sort((a, b) => {
    const av = col.get(a), bv = col.get(b);
    if (av < bv) return -1 * sortDir;
    if (av > bv) return 1 * sortDir;
    return 0;
  });
}

// Mobile sort bar — shown only on narrow screens (CSS). Reuses the same COLUMNS
// registry as the desktop headers so the two never drift. Fields with a `get`
// are sortable.
function sortBarHtml() {
  const opts = COLUMNS.filter((c) => c.sortable && c.get)
    .map((c) => `<option value="${c.key}"${c.key === sortKey ? " selected" : ""}>${esc(c.sortLabel || c.label)}</option>`)
    .join("");
  const dirLabel = sortDir === 1 ? "Ascending" : "Descending";
  return `<div class="sortbar">
    <div class="sort-field">
      <label for="sortField">Sort by</label>
      <select id="sortField" aria-label="Sort field">${opts}</select>
    </div>
    <button type="button" class="sort-dir" id="sortDir" aria-label="Toggle sort direction (${dirLabel})" aria-pressed="${sortDir === 1}" title="${dirLabel}">${sortDir === 1 ? "▲" : "▼"}</button>
  </div>`;
}
function wireSortBar() {
  const field = $("sortField");
  if (field) field.addEventListener("change", () => {
    const k = field.value;
    if (k !== sortKey) { sortKey = k; sortDir = (k === "title" || k === "lang" || k === "genres" || k === "services" || k === "type") ? 1 : -1; }
    renderPlan();
  });
  const dir = $("sortDir");
  if (dir) dir.addEventListener("click", () => { sortDir *= -1; renderPlan(); });
}

function renderPlan(plan) {
  if (plan !== undefined) currentPlan = plan || [];
  if (!currentPlan.length) {
    $("planWrap").innerHTML = `<span class="muted">Nothing new — everything in the Top 10 is already in Seerr/your library.</span>`;
    $("btnSubmit").disabled = true;
    return;
  }
  $("btnSubmit").disabled = false;
  const head = COLUMNS.map((c) => {
    if (c.key === "pick") return `<th><label class="chk" title="Select all"><input type="checkbox" id="pickAll" /><span class="chk-box"></span></label></th>`;
    if (!c.sortable) return `<th></th>`;
    const sorted = c.key === sortKey;
    const arrow = sorted ? (sortDir === 1 ? "▲" : "▼") : "▲";
    return `<th class="sortable ${sorted ? "sorted" : ""}" data-sort="${c.key}">${c.label} <span class="arrow">${arrow}</span></th>`;
  }).join("");

  const rows = sortedPlan().map((e) => {
    const title = e.tmdbId
      ? `<a class="title-link" href="${tmdbUrl(e.mediaType, e.tmdbId)}" target="_blank" rel="noopener">${esc(e.title)}</a>`
      : `<span class="title-link">${esc(e.title)}</span>`;
    const overview = e.overview ? ` title="${esc(e.overview)}"` : "";
    return `<tr${overview}>
      <td class="c-pick"><label class="chk"><input type="checkbox" class="pick" data-key="${entryKey(e)}" /><span class="chk-box"></span></label></td>
      <td class="c-poster"><span class="detail-open" data-key="${entryKey(e)}" role="button" tabindex="0">${posterCell(e)}</span></td>
      <td class="c-title"><span class="detail-open title-link" data-key="${entryKey(e)}" role="button" tabindex="0">${esc(e.title)}</span>${e.year ? ` <span class="muted yr-inline">(${e.year})</span>` : ""}${upcomingBadge(e)}</td>
      <td data-label="Type">${typeBadge(e.mediaType)}</td>
      <td data-label="Year">${e.year ?? "—"}</td>
      <td data-label="TMDB">${scoreBadge(e.tmdbScore)}</td>
      <td data-label="Lang" class="lang">${e.originalLanguage ? esc(e.originalLanguage) : "—"}</td>
      <td data-label="Seasons">${seasonsCell(e)}</td>
      <td data-label="Genres" class="muted">${esc((e.genres || []).join(", "))}</td>
      <td data-label="On" class="muted">${servicesCell(e.services)}</td>
    </tr>`;
  }).join("");

  $("planWrap").innerHTML = `<p class="muted">${currentPlan.length} new title(s). Hover a row for the overview. <b>Tick the titles you want</b>, then Submit requests.</p>
    ${sortBarHtml()}
    <table class="data plan"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;

  wireSortBar();

  $("pickAll").addEventListener("change", (ev) => {
    document.querySelectorAll(".pick").forEach((cb) => { cb.checked = ev.target.checked; });
    updateSubmitCount();
  });
  document.querySelectorAll(".pick").forEach((cb) => cb.addEventListener("change", updateSubmitCount));
  document.querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.sort;
    if (k === sortKey) sortDir *= -1; else { sortKey = k; sortDir = (k === "title" || k === "lang" || k === "genres" || k === "services" || k === "type") ? 1 : -1; }
    renderPlan();
  }));
  document.querySelectorAll(".seasontoggle").forEach((btn) =>
    btn.addEventListener("click", () => openSeasonModal(btn.dataset.key)));
  $("planWrap").querySelectorAll(".detail-open").forEach((n) => {
    const open = () => { const e = currentPlan.find((x) => entryKey(x) === n.dataset.key); openDetailsModal(e); };
    n.addEventListener("click", open);
    n.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } });
  });
  updateSubmitCount();
}

// Recompute a title's season selection from its (modal) checkboxes.
function syncSeasonSelFromBoxes(key) {
  const boxes = [...document.querySelectorAll(`.seasoncb[data-key="${CSS.escape(key)}"]`)];
  const picked = boxes.filter((b) => b.checked).map((b) => Number(b.dataset.sn)).sort((a, b) => a - b);
  const total = boxes.length;
  seasonSel[key] = total && picked.length === total ? "all" : picked;
}

function selectedKeys() { return [...document.querySelectorAll(".pick:checked")].map((cb) => cb.dataset.key); }
function seasonsPayload() {
  // Only include selections for currently-checked TV titles.
  const out = {};
  for (const k of selectedKeys()) {
    if (k in seasonSel && k.startsWith("tv:")) out[k] = seasonSel[k];
  }
  return out;
}
function updateSubmitCount() {
  const boxes = [...document.querySelectorAll(".pick")];
  const n = boxes.filter((cb) => cb.checked).length;
  $("btnSubmit").textContent = n ? `Submit ${n} request${n === 1 ? "" : "s"}` : "Submit requests";
  $("btnSubmit").disabled = n === 0;
  // Keep the select-all box in sync: checked (all), indeterminate (some), empty (none).
  const all = $("pickAll");
  if (all) {
    const box = all.nextElementSibling; // the .chk-box span
    all.checked = n > 0 && n === boxes.length;
    if (box) box.classList.toggle("indet", n > 0 && n < boxes.length);
  }
}

// Subtle submit confirmation: summarizes the selected titles and shows the
// per-backend default quality/root, with an optional override. Primary action
// proceeds with the defaults.
async function openSubmitModal() {
  const keys = new Set(selectedKeys());
  const chosen = currentPlan.filter((e) => keys.has(entryKey(e)));
  if (!chosen.length) return;
  const hasMovies = chosen.some((e) => e.mediaType === "movie");
  const hasTv = chosen.some((e) => e.mediaType === "tv");

  // Resolve provider + default profile/root (+ names) for the summary.
  let cfg, opts = {};
  try {
    [cfg, opts] = await Promise.all([api("/api/config"), api("/api/arr-options").catch(() => ({}))]);
  } catch { cfg = null; }
  const provider = cfg ? cfg.requestProvider : "arr";

  const profName = (kind, id) => {
    const list = (opts[kind] && opts[kind].profiles) || [];
    const m = list.find((p) => String(p.id) === String(id));
    return m ? m.name : (id ? `#${id}` : "server default");
  };

  function overrideBlock(kind, label, cfgArr) {
    if (provider !== "arr") return "";
    const list = (opts[kind] && opts[kind].profiles) || [];
    const roots = (opts[kind] && opts[kind].rootFolders) || [];
    const curProf = cfgArr.qualityProfileId;
    const curRoot = cfgArr.rootFolder;
    return `<div class="sm-arr">
      <div class="sm-arr-head">${label}</div>
      <div class="grid2">
        <div class="field"><label>Quality</label>
          <select class="sm-prof" data-kind="${kind}">${list.map((p) => `<option value="${p.id}" ${String(p.id) === String(curProf) ? "selected" : ""}>${esc(p.name)}</option>`).join("") || `<option value="">server default</option>`}</select></div>
        <div class="field"><label>Root folder</label>
          <select class="sm-root" data-kind="${kind}">${roots.map((r) => `<option value="${esc(r.path)}" ${r.path === curRoot ? "selected" : ""}>${esc(r.path)}</option>`).join("") || `<option value="">server default</option>`}</select></div>
      </div>
    </div>`;
  }

  const list = chosen.slice(0, 12).map((e) =>
    `<li>${typeBadge(e.mediaType)} ${esc(e.title)}${e.year ? ` <span class="muted">(${e.year})</span>` : ""}</li>`
  ).join("");
  const more = chosen.length > 12 ? `<li class="muted">…and ${chosen.length - 12} more</li>` : "";

  const el = document.createElement("div");
  el.className = "modal-backdrop";
  el.innerHTML = `
    <div class="modal sm-modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <strong>Request ${chosen.length} title${chosen.length === 1 ? "" : "s"}?</strong>
        <button type="button" class="modal-x" aria-label="Close">✕</button>
      </div>
      <p class="muted" style="margin:0 0 10px">Via ${provider === "seerr" ? "Overseerr/Jellyseerr" : "Radarr/Sonarr"} · defaults shown below — adjust only if you want to.</p>
      <ul class="sm-list">${list}${more}</ul>
      <details class="sm-advanced" ${provider === "arr" ? "" : "style=display:none"}>
        <summary>Quality &amp; root folder <span class="muted">(optional)</span></summary>
        ${hasMovies ? overrideBlock("radarr", "Movies → Radarr", (cfg && cfg.radarr) || {}) : ""}
        ${hasTv ? overrideBlock("sonarr", "TV → Sonarr", (cfg && cfg.sonarr) || {}) : ""}
      </details>
      <div class="modal-foot">
        <button type="button" class="ghost sm-cancel">Cancel</button>
        <button type="button" class="primary sm-go">Request ${chosen.length} title${chosen.length === 1 ? "" : "s"}</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  const close = () => { document.removeEventListener("keydown", onKey); el.remove(); };
  const onKey = (ev) => { if (ev.key === "Escape") close(); };
  el.addEventListener("click", (ev) => { if (ev.target === el) close(); });
  el.querySelector(".modal-x").addEventListener("click", close);
  el.querySelector(".sm-cancel").addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  el.querySelector(".sm-go").addEventListener("click", async () => {
    el.querySelector(".sm-go").disabled = true;
    // If the user changed any override, persist it to config before submitting.
    const patch = {};
    el.querySelectorAll(".sm-prof").forEach((s) => {
      const k = s.dataset.kind; patch[k] = patch[k] || {};
      if (s.value) patch[k].qualityProfileId = Number(s.value);
    });
    el.querySelectorAll(".sm-root").forEach((s) => {
      const k = s.dataset.kind; patch[k] = patch[k] || {};
      if (s.value) patch[k].rootFolder = s.value;
    });
    try {
      if (Object.keys(patch).length) {
        await api("/api/config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      }
    } catch { /* non-fatal: fall back to saved defaults */ }
    close();
    runSync(true);
  });
}

async function runSync(submit) {
  const btn = submit ? $("btnSubmit") : $("btnDry");
  btn.disabled = true; $("syncMsg").innerHTML = spinnerInline(submit ? "Submitting…" : "Checking…");
  try {
    const only = submit ? selectedKeys() : undefined;
    const payload = submit
      ? { submit: true, only, seasonsByKey: seasonsPayload() }
      : { submit: false };
    const r = await api("/api/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (r.dryRun) {
      $("syncMsg").textContent = `${r.uniqueCount} unique · ${r.skippedExisting} already exist · ${r.plan.length} new`;
      renderPlan(r.plan);
      // The dry run just hit the Streaming API — refresh the quota meter with
      // the fresh snapshot returned in the response (no extra round-trip).
      if (r.quota !== undefined) renderQuota(r.quota);
    } else {
      $("syncMsg").textContent = `Requested ${r.requested}, failed ${r.failed.length}, skipped ${r.skippedExisting}`;
      await loadHistory(); await loadRecent(); await loadStatus(); toast(`Submitted ${r.requested} request(s)`);
      await runSync(false);
    }
  } catch (err) { $("syncMsg").textContent = err.message; }
  finally { if (!submit) btn.disabled = false; }
}

$("country").addEventListener("change", () => { renderServices(); autoSaveFeed(); });
$("limit").addEventListener("change", autoSaveFeed);
$("btnSave").addEventListener("click", () => save());
if ($("btnSaveKeys")) $("btnSaveKeys").addEventListener("click", () => save("btnSaveKeys", "saveKeysMsg"));
$("btnDry").addEventListener("click", () => runSync(false));
$("btnSubmit").addEventListener("click", () => openSubmitModal());
if ($("requestProvider")) $("requestProvider").addEventListener("change", toggleProviderUI);
if ($("btnRefreshOpts")) $("btnRefreshOpts").addEventListener("click", (e) => { e.preventDefault(); loadArrOptions(); toast("Refreshed options"); });

// Settings connection-test buttons (reuses /api/test-connection).
document.querySelectorAll(".btn-verify").forEach((btn) => btn.addEventListener("click", async (e) => {
  e.preventDefault();
  const kind = btn.dataset.kind;
  const msg = $(`${kind}Verify`);
  const url = ($(`${kind}Url`) || {}).value || "";
  // The Streaming Availability key input is #apiKey (not #streamingKey); every
  // other kind follows the #{kind}Key convention.
  const keyInputId = kind === "streaming" ? "apiKey" : `${kind}Key`;
  const key = ($(keyInputId) || {}).value || "";
  msg.innerHTML = spinnerInline("Verifying…"); msg.className = "verify-msg";
  try {
    const r = await api("/api/test-connection", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, url, apiKey: key }),
    });
    msg.textContent = r.message;
    msg.className = "verify-msg " + (r.ok ? "ok" : "err");
    // For arr backends, populate the profile/root dropdowns from the result.
    if (r.ok && (kind === "radarr" || kind === "sonarr")) {
      fillOpts(kind, { profiles: r.profiles || [], rootFolders: r.rootFolders || [] });
    }
  } catch (err) { msg.textContent = err.message; msg.className = "verify-msg err"; }
}));

// ---- Account & API key management ----
function bindAccountControls() {
  const u = $("btnUsername");
  if (u) u.addEventListener("click", async () => {
    $("userMsg").textContent = "…";
    try {
      await api("/api/auth/username", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: $("acUser").value }) });
      $("userMsg").textContent = "Updated."; toast("Username updated");
    } catch (err) { $("userMsg").textContent = err.message; }
  });
  const p = $("btnPassword");
  if (p) p.addEventListener("click", async () => {
    $("passMsg").textContent = "…";
    try {
      await api("/api/auth/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: $("acCurPass").value, newPassword: $("acNewPass").value }) });
      toast("Password changed — please sign in again");
      setTimeout(() => location.reload(), 1200);
    } catch (err) { $("passMsg").textContent = err.message; }
  });
  const rot = $("btnRotateKey");
  if (rot) rot.addEventListener("click", async () => {
    $("keyMsg").textContent = "…";
    try {
      const r = await api("/api/auth/apikey", { method: "POST" });
      $("apiKeyReveal").innerHTML = `<div class="keybox"><code>${esc(r.apiKey)}</code><button id="copyKey">Copy</button></div><p class="hint">Copy it now — it won't be shown again.</p>`;
      $("keyMsg").textContent = "";
      $("apiKeyState").textContent = "An API key is configured (shown only once when generated).";
      const cp = $("copyKey");
      if (cp) cp.addEventListener("click", () => { navigator.clipboard?.writeText(r.apiKey); toast("Copied"); });
    } catch (err) { $("keyMsg").textContent = err.message; }
  });
  const rev = $("btnRevokeKey");
  if (rev) rev.addEventListener("click", async () => {
    try {
      await api("/api/auth/apikey", { method: "DELETE" });
      $("apiKeyReveal").innerHTML = ""; $("apiKeyState").textContent = "No API key configured."; toast("API key revoked");
    } catch (err) { $("keyMsg").textContent = err.message; }
  });
}
bindAccountControls();

// ---- Auth gate (login / first-run setup) ----
function showAuthGate(mode) {
  const setup = mode === "setup";
  if (setup) return showWizard();
  document.body.innerHTML = `
    <div class="authwrap">
      <form class="authcard" id="authForm">
        <img class="brand" src="/logo.png" alt="toprr" />
        <h1>Sign in</h1>
        <p class="muted">Enter your credentials to continue.</p>
        <label>Username</label>
        <input id="auUser" autocomplete="username" required />
        <label>Password</label>
        <input id="auPass" type="password" autocomplete="current-password" required />
        <button class="primary" type="submit">Sign in</button>
        <p class="authmsg" id="auMsg"></p>
      </form>
    </div>`;
  document.getElementById("authForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const username = document.getElementById("auUser").value;
    const password = document.getElementById("auPass").value;
    const msg = document.getElementById("auMsg");
    msg.innerHTML = spinnerInline("Signing in…");
    try {
      await api("/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      location.reload();
    } catch (err) { msg.textContent = err.message; }
  });
}

// ---- First-run setup wizard ----
// A guided, multi-step stepper: admin account -> streaming key -> Radarr ->
// Sonarr -> Seerr (optional) -> done. Each backend step verifies reachability
// (and pulls quality profiles / root folders to choose defaults) before Next.
function showWizard() {
  const state = {
    step: 0,
    // collected values
    streamingKey: "", tmdbKey: "",
    radarr: { url: "", key: "", profileId: "", root: "", profiles: [], roots: [], verified: false },
    sonarr: { url: "", key: "", profileId: "", root: "", profiles: [], roots: [], verified: false },
    seerr: { url: "", key: "", verified: false, skipped: false },
    accountDone: false,
  };
  const steps = ["Account", "Streaming API", "Radarr", "Sonarr", "Seerr", "Done"];

  document.body.innerHTML = `
    <div class="wizwrap">
      <div class="wizcard">
        <img class="brand" src="/logo.png" alt="toprr" />
        <div class="wizsteps" id="wizSteps"></div>
        <div class="wizbody" id="wizBody"></div>
        <p class="authmsg" id="wizMsg"></p>
        <div class="wiznav">
          <button id="wizBack" class="ghost">Back</button>
          <button id="wizNext" class="primary">Next</button>
        </div>
      </div>
    </div>`;

  const el = (id) => document.getElementById(id);
  function renderSteps() {
    el("wizSteps").innerHTML = steps.map((s, i) =>
      `<span class="wizstep ${i === state.step ? "active" : ""} ${i < state.step ? "done" : ""}"><span class="wizbubble">${i < state.step ? "✓" : i + 1}</span><em>${s}</em></span>`
    ).join("");
  }

  function setMsg(t, err) { const m = el("wizMsg"); m.textContent = t || ""; m.classList.toggle("ok-msg", !err && !!t); }

  async function verify(kind, url, key) {
    setMsg("Verifying…");
    try {
      const r = await api("/api/test-connection", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, url, apiKey: key }),
      });
      setMsg(r.message, !r.ok);
      return r;
    } catch (e) { setMsg(e.message, true); return { ok: false, message: e.message }; }
  }

  function body() {
    const s = state.step;
    if (s === 0) return `
      <h1>Welcome to toprr</h1>
      <p class="muted">Create your admin account. You'll configure the rest next.</p>
      <label>Username</label><input id="wUser" autocomplete="username" placeholder="≥3 characters" />
      <label>Password</label><input id="wPass" type="password" autocomplete="new-password" placeholder="≥8 characters" />`;
    if (s === 1) return `
      <h1>Streaming Availability API</h1>
      <p class="muted">Required. Get a free key at movieofthenight.com. This powers the Top 10 feed.</p>
      <label>API key</label><input id="wStream" value="${esc(state.streamingKey)}" placeholder="motn-key-..." />
      <label>TMDB API key <span class="muted">(optional — posters &amp; ratings)</span></label>
      <input id="wTmdb" value="${esc(state.tmdbKey)}" placeholder="(optional)" />`;
    if (s === 2 || s === 3) {
      const which = s === 2 ? "radarr" : "sonarr";
      const d = state[which];
      const label = s === 2 ? "Radarr (movies)" : "Sonarr (TV)";
      return `
        <h1>${label}</h1>
        <p class="muted">Enter the URL and API key, verify, then choose a default quality profile and root folder.</p>
        <label>URL</label><input id="wUrl" value="${esc(d.url)}" placeholder="https://${which}.example.com" />
        <label>API key</label><input id="wKey" type="password" value="${esc(d.key)}" placeholder="API key" />
        <button type="button" class="ghost wverify">Verify &amp; load options</button>
        <div class="wopts" style="${d.verified ? "" : "display:none"}">
          <label>Default quality profile</label>
          <select id="wProfile">${d.profiles.map((p) => `<option value="${p.id}" ${String(p.id) === String(d.profileId) ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select>
          <label>Default root folder</label>
          <select id="wRoot">${d.roots.map((r) => `<option value="${esc(r.path)}" ${r.path === d.root ? "selected" : ""}>${esc(r.path)}</option>`).join("")}</select>
        </div>`;
    }
    if (s === 4) return `
      <h1>Seerr <span class="muted">(optional)</span></h1>
      <p class="muted">Overseerr/Jellyseerr is optional. Leave blank to request directly via Radarr/Sonarr, or configure it and switch the provider later in Settings.</p>
      <label>URL</label><input id="wUrl" value="${esc(state.seerr.url)}" placeholder="https://seerr.example.com (optional)" />
      <label>API key</label><input id="wKey" type="password" value="${esc(state.seerr.key)}" placeholder="(optional)" />
      <button type="button" class="ghost wverify">Verify</button>`;
    return `
      <h1>You're all set 🎉</h1>
      <p class="muted">toprr is configured. Click Finish to open your dashboard.</p>`;
  }

  function render() {
    renderSteps();
    el("wizBody").innerHTML = body();
    el("wizBack").style.visibility = state.step === 0 ? "hidden" : "visible";
    el("wizNext").textContent = state.step === steps.length - 1 ? "Finish" : (state.step === 4 && !state.seerr.key ? "Skip & continue" : "Next");
    setMsg("");
    const vbtn = el("wizBody").querySelector(".wverify");
    if (vbtn) vbtn.addEventListener("click", onVerify);
  }

  async function onVerify() {
    const s = state.step;
    if (s === 2 || s === 3) {
      const which = s === 2 ? "radarr" : "sonarr";
      const d = state[which];
      d.url = el("wUrl").value.trim(); d.key = el("wKey").value.trim();
      const r = await verify(which, d.url, d.key);
      if (r.ok) {
        d.verified = true; d.profiles = r.profiles || []; d.roots = r.rootFolders || [];
        if (!d.profileId && d.profiles[0]) d.profileId = d.profiles[0].id;
        if (!d.root && d.roots[0]) d.root = d.roots[0].path;
        render();
      }
    } else if (s === 4) {
      state.seerr.url = el("wUrl").value.trim(); state.seerr.key = el("wKey").value.trim();
      if (!state.seerr.url && !state.seerr.key) { setMsg("Left blank — Seerr will be skipped."); return; }
      const r = await verify("seerr", state.seerr.url, state.seerr.key);
      state.seerr.verified = r.ok;
    }
  }

  async function next() {
    const s = state.step;
    const nextBtn = el("wizNext");
    try {
      nextBtn.disabled = true;
      if (s === 0) {
        const username = el("wUser").value.trim(), password = el("wPass").value;
        if (username.length < 3 || password.length < 8) { setMsg("Username ≥3 chars, password ≥8 chars.", true); return; }
        if (!state.accountDone) {
          await api("/api/auth/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
          state.accountDone = true; // session cookie now set
        }
      } else if (s === 1) {
        state.streamingKey = el("wStream").value.trim();
        state.tmdbKey = el("wTmdb").value.trim();
        if (!state.streamingKey) { setMsg("A Streaming Availability key is required.", true); return; }
        const r = await verify("streaming", "", state.streamingKey);
        if (!r.ok) return;
        await api("/api/config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: state.streamingKey, tmdbApiKey: state.tmdbKey }) });
      } else if (s === 2 || s === 3) {
        const which = s === 2 ? "radarr" : "sonarr";
        const d = state[which];
        if (el("wUrl")) { d.url = el("wUrl").value.trim(); d.key = el("wKey").value.trim(); }
        if (!d.verified) { setMsg("Verify the connection first.", true); return; }
        if (el("wProfile")) d.profileId = el("wProfile").value;
        if (el("wRoot")) d.root = el("wRoot").value;
        await api("/api/config", { method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [which]: { url: d.url, apiKey: d.key, qualityProfileId: Number(d.profileId) || undefined, rootFolder: d.root || undefined } }) });
      } else if (s === 4) {
        if (el("wUrl")) { state.seerr.url = el("wUrl").value.trim(); state.seerr.key = el("wKey").value.trim(); }
        if (state.seerr.url && state.seerr.key) {
          await api("/api/config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seerr: { url: state.seerr.url, apiKey: state.seerr.key } }) });
        }
      } else if (s === 5) {
        location.reload(); return;
      }
      state.step = Math.min(state.step + 1, steps.length - 1);
      render();
    } catch (e) { setMsg(e.message, true); }
    finally { nextBtn.disabled = false; }
  }

  el("wizNext").addEventListener("click", next);
  el("wizBack").addEventListener("click", () => { if (state.step > 0) { state.step--; render(); } });
  render();
}

async function logout() {
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  location.reload();
}

(async function init() {
  // Full-page boot spinner while we determine auth state.
  const boot = document.createElement("div");
  boot.className = "authwrap";
  boot.id = "bootSpin";
  boot.innerHTML = `<span class="spin-slot"></span>`;
  document.body.appendChild(boot);
  const bootSp = new Spinner(boot.querySelector(".spin-slot"), "Starting toprr…").start();

  // Determine auth state before loading the app shell's data.
  let status;
  try {
    const res = await fetch("/api/auth/status", { credentials: "same-origin" });
    status = await res.json();
  } catch {
    bootSp.fail("Server unreachable.");
    return;
  }
  boot.remove();
  if (status.needsSetup) return showAuthGate("setup");
  if (!status.authenticated) return showAuthGate("login");

  // Authenticated: render nav, wire logout + load data.
  renderNav();
  const lo = document.getElementById("btnLogout");
  if (lo) lo.addEventListener("click", logout);
  await loadConfig();
  await Promise.all([loadStatus(), loadRecent(), loadCountries()]);
  // loadCountries() made a Streaming API call that captured the quota headers;
  // refresh status once so the quota meter reflects the latest snapshot.
  loadStatus();
})();
