"use strict";
// Tagged web UI client. Talks to the JSON API under <prefix>api/v2/.

// The prefix and build id ride in on <meta> tags rather than an inline script,
// so the Content-Security-Policy can forbid inline script outright.
function metaValue(name, fallback) {
  const el = document.querySelector(`meta[name="${name}"]`);
  return (el && el.content) || fallback;
}
const PREFIX = metaValue("tt-prefix", "/");
// Build id, injected into every page. Assets are requested as ?v=<VERSION> so a
// new build never reuses the previous one's cached JS/CSS.
const VERSION = metaValue("tt-version", "");
const API = PREFIX + "api/v2/";
const TOKEN_KEY = "tt_webtoken";
const USER_KEY = "tt_username";
const ACTAS_KEY = "tt_actas"; // controller: username currently being viewed ("" = self)

// Categorical palette for tags (matches the macOS app's accent-first scheme).
const PALETTE = ["#DEAA22", "#4C82F7", "#2FB79E", "#E5484D", "#E9913C", "#3BA55D", "#EB459E", "#5865F2"];
const OTHER = "Other";
const OTHER_COLOR = "#A66CFF";

const DAILY_GOAL_KEY = "tagged_web_daily_goal";
const WEEKLY_GOAL_KEY = "tagged_web_weekly_goal";
const WEEK_START_KEY = "tagged_web_week_start";
const WORKDAYS_KEY = "tagged_web_workdays";
const TIMEZONE_KEY = "tagged_web_timezone";
const LANGUAGE_KEY = "tagged_web_language";

// ---- Translations -----------------------------------------------------------
// The static HTML arrives already translated: the server rewrites every
// data-i18n element before sending it, keyed off the tt_lang cookie, so a page
// never paints in English and then flips. What is left for the client is
// everything app.js renders at runtime -- and repairing the static markup when
// the cookie is absent or stale (a first visit, or a shared browser where the
// previous user's language is still set).
//
// Division of labour: the cookie decides what gets *rendered*; the per-user
// synced setting decides what the cookie should *be*. It has to be that way
// round, because page loads carry no auth token -- it lives in localStorage and
// only rides API calls -- so at render time the cookie is all the server knows.
const LANG_COOKIE = "tt_lang";
const I18N_CACHE_KEY = "tagged_web_i18n";     // {code, rev, strings}
const LANG_OWNER_KEY = "tagged_web_lang_user"; // whose language the cookie holds
let I18N = { code: "en", strings: {} };

function getCookie(name) {
  const hit = document.cookie.split("; ").find((c) => c.startsWith(name + "="));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : "";
}

function setLangCookie(code) {
  // A year, path-scoped to the app so a prefixed install does not leak it, and
  // deliberately not HttpOnly: the client is what writes it. It holds no
  // secret, and keeping it across logout means the login page arrives already
  // translated.
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${LANG_COOKIE}=${encodeURIComponent(code)}; Path=${PREFIX}; Max-Age=31536000; SameSite=Lax${secure}`;
}

// normKey mirrors the Go extractor's NormalizeKey exactly. If these two ever
// disagree, a routine HTML reformat silently orphans a page's translations.
function normKey(s) {
  return String(s == null ? "" : s)
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split(/\s+/).filter(Boolean).join(" ");
}

// t translates one string. The key is the English source text, so an
// untranslated key returns correct English rather than a placeholder.
//
// The first argument must be a string literal: the build-time extractor scans
// for t("...") call sites, and a computed argument would never make it into the
// catalog. TestNoDynamicT enforces this.
function t(key, vars) {
  const m = I18N.strings[normKey(key)];
  let out = key;
  if (typeof m === "string" && m) out = m;
  else if (m && typeof m === "object" && m.one) out = m.one;
  return vars ? interpolate(out, vars) : out;
}

// tn picks the singular or plural form. Two forms cover English and most of
// western Europe; languages with richer plural systems (Polish, Russian,
// Arabic) would need real ICU categories, which this deliberately is not.
function tn(one, other, n, vars) {
  const m = I18N.strings[normKey(one)];
  // Both English forms are passed in, because the key is only the singular and
  // English plurals are not derivable from it -- "entry" becomes "entries", not
  // "entrys". Without the second argument an untranslated UI renders "64 user".
  let out = n === 1 ? one : other;
  if (m && typeof m === "object") out = (n === 1 ? m.one : m.other) || out;
  else if (typeof m === "string" && m) out = m;
  return interpolate(out, Object.assign({ n }, vars || {}));
}

// interpolate fills {name} placeholders. Translations use named placeholders so
// a translator can reorder them, which positional ones would not survive.
function interpolate(s, vars) {
  return s.replace(/\{(\w+)\}/g, (whole, k) => (k in vars ? String(vars[k]) : whole));
}

// tEmph translates a sentence that needs emphasis inside it, and returns HTML.
//
// The catalog must never contain HTML. If a key were
// "In GitHub, open <strong>Settings</strong>", a translator would have to
// hand-copy tags correctly (they will not), and trusting a translation as HTML
// would hand an admin an injection point into every page.
//
// So the catalog carries a lightweight convention instead: *emphasis* and
// `code`. The translated text is escaped first, and only the marker pairs
// become tags afterwards -- markup can therefore only ever come from the
// markers, never from the translation's own characters. Translators can move
// the markers to wherever their grammar needs them.
// tKey translates a key held in a variable, for the handful of places where the
// string is declared in one of the i18n*Strings blocks and passed around as
// data. Keeping the dynamic call in one named helper means the "t() needs a
// literal" guard stays strict everywhere else.
function tKey(key) { return t(key); } // i18n-dynamic: caller's key is declared elsewhere

function tEmph(key, vars) {
  return escapeHtml(t(key, vars))  // i18n-dynamic: this is the helper
    .replace(/\*([^*]+)\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

// applyI18n translates the marked-up static markup in root. It is a no-op in
// the common case where the server already did it, and the repair path when the
// cookie was missing or wrong.
function applyI18n(root = document) {
  if (I18N.code === "en") return;
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    const v = t(el.getAttribute("data-i18n")); // i18n-dynamic: key came from the markup, already extracted
    if (v && el.textContent.trim() !== v) el.textContent = v;
  });
  const attrs = [["placeholder", "placeholder"], ["title", "title"], ["aria-label", "aria-label"], ["alt", "alt"]];
  for (const [attr, suffix] of attrs) {
    root.querySelectorAll(`[data-i18n-${suffix}]`).forEach((el) => {
      const v = t(el.getAttribute(`data-i18n-${suffix}`)); // i18n-dynamic: as above
      if (v) el.setAttribute(attr, v);
    });
  }
  document.documentElement.lang = I18N.code;
}

// loadCatalog fetches the active language's strings, serving from localStorage
// first so there is no blocking round-trip on every page load.
//
// The cache is keyed by the catalog revision, not by the asset version: the
// build id hashes only the embedded files, so it cannot see an admin's edit. If
// this keyed off ?v= instead, a changed translation would not appear until a
// hard refresh.
async function loadCatalog(code) {
  if (!code || code === "en") { I18N = { code: "en", strings: {} }; return; }
  try {
    const cached = JSON.parse(localStorage.getItem(I18N_CACHE_KEY) || "null");
    if (cached && cached.code === code) I18N = cached; // may be stale; revalidated below
  } catch (e) { /* ignore a corrupt cache */ }
  try {
    const r = await fetch(API + "i18n/" + encodeURIComponent(code) + ".json");
    if (!r.ok) { if (I18N.code !== code) I18N = { code: "en", strings: {} }; return; }
    const d = await r.json();
    I18N = { code: d.code, rev: d.rev, strings: d.strings || {} };
    localStorage.setItem(I18N_CACHE_KEY, JSON.stringify(I18N));
  } catch (e) { /* offline: whatever was cached still applies */ }
}

// initI18n runs before anything renders. It trusts the cookie, because that is
// what the server already rendered against; reconciling it with the user's
// actual setting happens later, in revealChrome.
async function initI18n() {
  const code = getCookie(LANG_COOKIE) || "en";
  await loadCatalog(code);
  applyI18n();
}

// reconcileLang makes the cookie agree with the signed-in user's stored
// preference, and is why the cookie can be trusted at render time.
//
// It runs from revealChrome rather than loadSettings: loadSettings is called
// from inside seven page initialisers and never runs at all on the roles,
// oauth, settings or groups pages, so it cannot be the reconciliation point.
// revealChrome runs on every authenticated page.
//
// The cookie is per-browser but the setting is per-user, so a shared browser
// would otherwise show the previous user their predecessor's language. Pairing
// the cookie with the username it was set for detects that; the cost is one
// reload on the first page after a user switch.
async function reconcileLang() {
  const me = localStorage.getItem(USER_KEY) || "";
  if (!me) return;
  if (localStorage.getItem(LANG_OWNER_KEY) === me) return; // already settled

  let want = "en";
  try {
    const r = await apiFetch("settings");
    if (!r.ok) return;
    const hit = ((await r.json()).settings || []).find((s) => s.key === LANGUAGE_KEY);
    if (hit && hit.value) want = String(hit.value);
  } catch (e) { return; } // leave the cookie alone rather than guess

  localStorage.setItem(LANG_OWNER_KEY, me);
  if (want === (getCookie(LANG_COOKIE) || "en")) return;
  setLangCookie(want);
  reloadForLang();
}

// reloadForLang re-fetches the page so the server can render it in the new
// language. The sessionStorage guard is what stops a reload loop if the cookie
// and the setting somehow never converge.
function reloadForLang() {
  const guard = "tagged_web_lang_reloaded";
  if (sessionStorage.getItem(guard)) return;
  sessionStorage.setItem(guard, "1");
  location.reload();
}

// User preferences (synced via the settings API). weekStart is a JS weekday
// index (0=Sun..6=Sat); workdays is a set of those indices.
function detectTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) { return "UTC"; }
}
const WORKDAY_PRESETS = {
  "mon-fri": [1, 2, 3, 4, 5],
  "mon-sat": [1, 2, 3, 4, 5, 6],
  "sun-thu": [0, 1, 2, 3, 4],
  "everyday": [0, 1, 2, 3, 4, 5, 6],
};
let PREFS = { weekStart: 1, workdays: "mon-fri", timezone: detectTimezone(), language: "en" };
// Offset (0..6) of date d from the configured start of its week.
function weekStartOffset(d) { return (d.getDay() - PREFS.weekStart + 7) % 7; }

// Tag colors use the TimeTagger-compatible settings format ("taginfo #tag" ->
// {color: ...}), so they sync with the macOS Tagged app.
const TAGINFO_PREFIX = "taginfo #";

function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setSession(token, username) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, username);
}
function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem(ACTAS_KEY);
}
// getActAs returns the username a controller is currently viewing, or "" for self.
function getActAs() { return localStorage.getItem(ACTAS_KEY) || ""; }
function logout() { clearSession(); location.href = PREFIX + "login"; }

function showMsg(el, text, kind) {
  el.textContent = text;
  el.className = "msg" + (kind ? " " + kind : "");
  // Successful writes also surface as a toast at the top of the page, so the
  // confirmation is visible even when the inline slot is scrolled away or the
  // panel it belongs to is behind a modal.
  if (kind === "ok" && text) toast(text, "ok");
}


// ---- Toasts -----------------------------------------------------------------
// One fixed host per page, created on first use so no template has to carry the
// markup. Toasts stack downwards and fade themselves out.

function toastHost() {
  let host = document.getElementById("toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast-host";
    host.className = "toast-host";
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
  }
  return host;
}

// toast shows a transient message. kind is "ok" | "error" | "" (neutral).
function toast(text, kind = "", ms = 3200) {
  if (!text) return;
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.innerHTML = '<span class="dot"></span>';
  const span = document.createElement("span");
  span.textContent = text;
  el.appendChild(span);
  toastHost().appendChild(el);
  requestAnimationFrame(() => el.classList.add("in"));
  const drop = () => {
    el.classList.remove("in");
    setTimeout(() => el.remove(), 200);
  };
  const timer = setTimeout(drop, ms);
  el.addEventListener("click", () => { clearTimeout(timer); drop(); });
}

// ---- Confirm / prompt sheets ------------------------------------------------
// Replacements for window.confirm and window.prompt that match the app's own
// modals. They build their DOM on demand and append it to <body>, so every page
// gets them without repeating markup in each template.

// modalSheet returns an empty .sheet inside a fresh overlay. Escape and clicks
// on the backdrop both run `cancel`. Call overlay.close() to tear it down.
function modalSheet(extraClass, cancel) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const sheet = document.createElement("div");
  sheet.className = "sheet" + (extraClass ? " " + extraClass : "");
  overlay.appendChild(sheet);
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) cancel(); });
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); cancel(); } };
  document.addEventListener("keydown", onKey);
  overlay.close = () => { document.removeEventListener("keydown", onKey); overlay.remove(); };
  document.body.appendChild(overlay);
  return { overlay, sheet };
}

// confirmModal asks a yes/no question. Resolves true only when the confirm
// button is pressed. Pass danger:false for a non-destructive action (the
// confirm button then uses the normal accent style).
//   await confirmModal({title, body, confirmLabel, danger})
function confirmModal(opts) {
  const o = typeof opts === "string" ? { body: opts } : (opts || {});
  return new Promise((resolve) => {
    let ui = null, done = false;
    const finish = (v) => { if (done) return; done = true; ui.overlay.close(); resolve(v); };
    ui = modalSheet("confirm", () => finish(false));
    const danger = o.danger !== false;
    ui.sheet.innerHTML = `
      <div class="sheet-title">${escapeHtml(o.title || "Are you sure?")}</div>
      <div class="sheet-section"><div class="confirm-body"></div></div>
      <div class="sheet-actions">
        <div class="spacer"></div>
        <button class="secondary" type="button" data-a="no">${escapeHtml(o.cancelLabel || "Cancel")}</button>
        <button type="button" data-a="yes"${danger ? ' class="danger-btn"' : ""}>${escapeHtml(o.confirmLabel || "Delete")}</button>
      </div>`;
    ui.sheet.querySelector(".confirm-body").textContent = o.body || "";
    ui.sheet.querySelector('[data-a="no"]').addEventListener("click", () => finish(false));
    const yes = ui.sheet.querySelector('[data-a="yes"]');
    yes.addEventListener("click", () => finish(true));
    yes.focus();
  });
}



async function apiFetch(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  const token = getToken();
  if (token) headers["authtoken"] = token;
  const actas = getActAs();
  if (actas) headers["actasuser"] = actas;
  const resp = await fetch(API + path, Object.assign({}, opts, { headers }));
  if (resp.status === 401) { logout(); throw new Error("unauthorized"); }
  return resp;
}

// ---- Time / date helpers ----------------------------------------------------

function pad(n) { return String(n).padStart(2, "0"); }
function fmtHM(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return t("{h}h {m}m", { h, m: pad(m) });
}
function clock(epoch) { const d = new Date(epoch * 1000); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
// Month and weekday names go through the catalog rather than being fixed
// arrays. They are looked up per call, not once at load: these constants are
// evaluated before the catalog arrives, so a baked-in translation would always
// be the English one.
//
// Short forms are separate keys, never a substring of the long name.
// "January".slice(0, 3) happens to read correctly in English and produces
// nonsense in most other languages -- German "Mär", Finnish "tammi" and so on
// are not prefixes of anything useful.
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_SHORT_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]; // indexed by getDay()
const DOW_EN = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];                                   // indexed by getDay()

function monthName(i) { return t(MONTHS_EN[i]); }        // i18n-dynamic: declared in i18nDateStrings
function monthShort(i) { return t(MONTHS_SHORT_EN[i]); } // i18n-dynamic: declared in i18nDateStrings
function weekdayName(i) { return t(WEEKDAY_EN[i]); }     // i18n-dynamic: declared in i18nDateStrings
function dowShort(i) { return t(DOW_EN[i]); }            // i18n-dynamic: declared in i18nDateStrings

// Never called. It exists so the extractor catalogs the date names, since the
// lookups above pass computed keys.
function i18nDateStrings() {
  t("January"); t("February"); t("March"); t("April"); t("May"); t("June");
  t("July"); t("August"); t("September"); t("October"); t("November"); t("December");
  t("Jan"); t("Feb"); t("Mar"); t("Apr"); t("May"); t("Jun");
  t("Jul"); t("Aug"); t("Sep"); t("Oct"); t("Nov"); t("Dec");
  t("Sunday"); t("Monday"); t("Tuesday"); t("Wednesday"); t("Thursday"); t("Friday"); t("Saturday");
  t("SUN"); t("MON"); t("TUE"); t("WED"); t("THU"); t("FRI"); t("SAT");
  t("{h}h {m}m"); t("{d} {month}"); t("{weekday}, {month} {d}"); t("{weekday}, {month} {d} {year}");
  t("{month} {year}"); t("{d} {month} {year}");
  t("{month} {from} – {to}, {year}"); t("{fromMonth} {from} – {toMonth} {to}, {year}");
  t("{month} {d}"); t("{weekday}, {d} {month} {year}");
}
// Short weekday labels ordered starting from the configured week start.
function orderedDOW() { return Array.from({ length: 7 }, (_, i) => dowShort((PREFS.weekStart + i) % 7)); }

function midnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function dayKey(d) { return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate(); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function dayRange(d) { const s = midnight(d).getTime() / 1000; return [s, s + 86400]; }
function relDay(epoch) {
  const d = midnight(new Date(epoch * 1000));
  const today = midnight(new Date());
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return "Today";
  if (diff === -1) return "Yesterday";
  return t("{d} {month}", { d: d.getDate(), month: monthShort(d.getMonth()) });
}

// ---- Records ----------------------------------------------------------------

// Tags are grouped case-insensitively (so "#Work" and "#work" are one tag),
// keyed by the lowercased name and displayed with the first-seen casing.
const OTHER_KEY = "other";

// A valid tag is "#" followed by one or more of: letters, digits, "-", "_", "/",
// or any non-ASCII char (code point > 127). This mirrors the upstream TimeTagger
// rules (utils.is_valid_tag_charcode / get_tags_and_parts_from_string) that the
// macOS app follows, so a tag the app sends matches an existing one here instead
// of duplicating. A tag ends at the first character outside this set (a space,
// punctuation like "." or ",", another "#", etc.).
const TAG_CLASS = "0-9A-Za-z_/\\u0080-\\uFFFF-";
const RE_TAG_G = new RegExp("#[" + TAG_CLASS + "]+", "g"); // all tags (with "#")
const RE_TAG_1 = new RegExp("#[" + TAG_CLASS + "]+");      // first tag (with "#")
const RE_NON_TAG_CHAR = new RegExp("[^" + TAG_CLASS + "]", "g");

function tagKeyOf(ds) { const m = (ds || "").match(RE_TAG_1); return m ? m[0].slice(1).toLowerCase() : OTHER_KEY; }
function rawTagOf(ds) { const m = (ds || "").match(RE_TAG_1); return m ? m[0].slice(1) : OTHER; }
function recDur(r) { return Math.max(0, r.t2 - r.t1); }

let ALL = [];          // all records
let COLORS = {};       // tag key -> auto-assigned color (fallback)
let LABELS = {};       // tag key -> display label
let TAGCOLORS = {};    // tag key -> stored color (from settings, wins over auto)
let TAGINFO_RAW = {};  // tag key -> full taginfo object (preserved when saving)
let GOALS = { daily: 8, weekly: 40 };

function allTagsOf(ds) { return (ds || "").match(RE_TAG_G) || []; }

function buildTagMeta(records) {
  LABELS = { [OTHER_KEY]: OTHER };
  const totals = {};       // primary-tag duration (drives color ordering)
  const keys = new Set();  // every distinct tag, so multi-tag entries all get a color
  for (const r of records) {
    const primary = tagKeyOf(r.ds);
    if (!(primary in LABELS)) LABELS[primary] = rawTagOf(r.ds);
    if (primary !== OTHER_KEY) totals[primary] = (totals[primary] || 0) + recDur(r);
    for (const raw of allTagsOf(r.ds)) {
      const k = raw.slice(1).toLowerCase();
      keys.add(k);
      if (!(k in LABELS)) LABELS[k] = raw.slice(1);
    }
  }
  const sorted = Array.from(keys).sort((a, b) => (totals[b] || 0) - (totals[a] || 0));
  COLORS = {};
  sorted.forEach((k, i) => { COLORS[k] = PALETTE[i % PALETTE.length]; });
}
// SAFE_COLOR_RE matches the only colour forms this UI ever produces: a hex
// literal or a CSS variable reference.
const SAFE_COLOR_RE = /^(#[0-9a-fA-F]{3,8}|var\(--[a-zA-Z0-9-]+\))$/;

// safeColor gates a colour before it reaches markup. Colours arrive from a
// user's own settings, which the settings API stores verbatim and which a
// controller or admin renders when viewing that user's data — so a colour is
// untrusted input, not a constant. Every sink interpolates it into a style
// attribute, where an unfiltered value escapes the attribute and becomes an
// event handler. Anything that is not a plain colour is dropped.
function safeColor(c, fallback = OTHER_COLOR) {
  const s = String(c == null ? "" : c).trim();
  return SAFE_COLOR_RE.test(s) ? s : fallback;
}

function colorFor(key) {
  if (key === OTHER_KEY) return OTHER_COLOR;
  return safeColor(TAGCOLORS[key] || COLORS[key] || OTHER_COLOR);
}
function labelFor(key) {
  if (LABELS[key]) return LABELS[key];
  if (key === OTHER_KEY) return OTHER;
  const info = TAGINFO_RAW[key];
  return (info && info.title) || key;
}

function sumInRange(t1, t2) {
  let s = 0;
  for (const r of ALL) if (r.t1 >= t1 && r.t1 < t2) s += recDur(r);
  return s;
}

// ---- Login / Register -------------------------------------------------------

// initSetup drives the first-run wizard: pick the storage backend (unless the
// operator pinned it) and create the first admin account.
async function initSetup() {
  const msg = document.getElementById("msg");
  const choice = document.getElementById("backend-choice");
  const pgField = document.getElementById("pg-field");
  const lockedNote = document.getElementById("backend-locked-note");

  try {
    const r = await fetch(API + "setup_status");
    if (r.ok) {
      const d = await r.json();
      if (!d.setup_required) { location.href = PREFIX + "login"; return; }
      if (d.backend_locked) {
        choice.hidden = true;
        const nice = d.backend === "postgres" ? "Performance Server (PostgreSQL)" : "Simple Server (SQLite)";
        lockedNote.textContent = "Storage backend is fixed by the server configuration: " + nice + ".";
        lockedNote.hidden = false;
      }
    }
  } catch (e) { /* proceed; the submit still validates server-side */ }

  document.querySelectorAll('input[name="backend"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      const sel = document.querySelector('input[name="backend"]:checked');
      pgField.hidden = !sel || sel.value !== "postgres";
    });
  });

  document.getElementById("setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;
    const password2 = document.getElementById("password2").value;
    if (password !== password2) { showMsg(msg, "Passwords do not match", "error"); return; }
    const sel = document.querySelector('input[name="backend"]:checked');
    const backend = sel ? sel.value : "sqlite";
    const dbUrl = document.getElementById("db_url").value.trim();
    const choosingPg = !choice.hidden && backend === "postgres";
    if (choosingPg && !dbUrl) { showMsg(msg, "Enter a PostgreSQL connection URL", "error"); return; }
    showMsg(msg, choosingPg ? "Connecting and creating admin…" : "Creating admin…", "");
    try {
      const resp = await fetch(API + "setup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend, db_url: dbUrl, username, password }),
      });
      if (!resp.ok) { showMsg(msg, (await resp.text()) || "Setup failed", "error"); return; }
      const data = await resp.json();
      setSession(data.token, data.username || username);
      location.href = PREFIX;
    } catch (err) { showMsg(msg, t("Network error"), "error"); }
  });
}

// handleOAuthFragment consumes a "#token=…&user=…" (success) or "#oauth_error=…"
// fragment left by the OAuth callback redirect. Returns true when it took over
// the page (a successful sign-in redirect), so the caller stops initializing.
function handleOAuthFragment(msg) {
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  if (!hash) return false;
  const p = new URLSearchParams(hash);
  const token = p.get("token");
  const err = p.get("oauth_error");
  // Clear the fragment so a reload / bookmark doesn't replay it.
  history.replaceState(null, "", location.pathname + location.search);
  if (token) {
    setSession(token, p.get("user") || "");
    location.href = PREFIX;
    return true;
  }
  if (err && msg) showMsg(msg, err, "error");
  return false;
}

// oauthIcon returns an inline brand SVG for a provider id, falling back to a
// generic key glyph. Brand marks keep their own colors; the fallback uses
// currentColor so it inherits the button text color.
function oauthIcon(id) {
  switch ((id || "").toLowerCase()) {
    case "google":
      return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
        '<path fill="#4285F4" d="M23.52 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.57-5.17 3.57-8.87z"/>' +
        '<path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.95-2.91l-3.88-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.28v3.09A12 12 0 0 0 12 24z"/>' +
        '<path fill="#FBBC05" d="M5.27 14.29a7.2 7.2 0 0 1 0-4.58V6.62H1.28a12 12 0 0 0 0 10.76l3.99-3.09z"/>' +
        '<path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.44-3.44C17.95 1.19 15.23 0 12 0A12 12 0 0 0 1.28 6.62l3.99 3.09C6.22 6.86 8.87 4.75 12 4.75z"/></svg>';
    case "github":
      return '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.94c.58.1.79-.25.79-.56v-1.95c-3.2.7-3.88-1.54-3.88-1.54-.53-1.34-1.3-1.7-1.3-1.7-1.06-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.73 1.27 3.4.97.1-.75.4-1.27.73-1.56-2.56-.29-5.26-1.28-5.26-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.4-5.28 5.69.42.36.79 1.07.79 2.16v3.2c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5z"/></svg>';
    default:
      return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M10.85 12.15 21 2"/><path d="M18 5l2 2"/><path d="M15 8l2 2"/></svg>';
  }
}

// loadOAuthButtons fetches the enabled providers and renders a "Continue with …"
// button for each, which starts the flow via the server redirect endpoint.
async function loadOAuthButtons() {
  const section = document.getElementById("oauth-section");
  const host = document.getElementById("oauth-buttons");
  if (!section || !host) return;
  try {
    const r = await fetch(API + "oauth/providers");
    if (!r.ok) return;
    const providers = (await r.json()).providers || [];
    if (!providers.length) return;
    host.innerHTML = "";
    for (const p of providers) {
      const a = document.createElement("a");
      a.className = "oauth-btn";
      a.href = API + "oauth/login/" + encodeURIComponent(p.id);
      const ic = document.createElement("span");
      ic.className = "oauth-ic";
      ic.innerHTML = oauthIcon(p.id);
      const label = document.createElement("span");
      label.textContent = "Continue with " + p.name;
      a.appendChild(ic);
      a.appendChild(label);
      host.appendChild(a);
    }
    section.hidden = false;
  } catch (e) { /* ignore */ }
}

// ---- WebAuthn / passkeys ----------------------------------------------------

// WebAuthn transfers binary values as base64url strings; the browser API wants
// ArrayBuffers. These helpers convert between the two.
function b64urlToBuf(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s + pad);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
function bufToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function prepRequestOptions(o) {
  o.challenge = b64urlToBuf(o.challenge);
  (o.allowCredentials || []).forEach((c) => { c.id = b64urlToBuf(c.id); });
  return o;
}

// credToJSON serializes a PublicKeyCredential (registration or assertion) into
// the base64url JSON the server parses.
function credToJSON(cred) {
  const r = cred.response;
  const out = { id: cred.id, rawId: bufToB64url(cred.rawId), type: cred.type, response: {} };
  if (cred.authenticatorAttachment) out.authenticatorAttachment = cred.authenticatorAttachment;
  if (r.attestationObject !== undefined) { // registration
    out.response.attestationObject = bufToB64url(r.attestationObject);
    out.response.clientDataJSON = bufToB64url(r.clientDataJSON);
    if (typeof r.getTransports === "function") {
      try { out.response.transports = r.getTransports(); } catch (e) { /* ignore */ }
    }
  } else { // assertion
    out.response.authenticatorData = bufToB64url(r.authenticatorData);
    out.response.clientDataJSON = bufToB64url(r.clientDataJSON);
    out.response.signature = bufToB64url(r.signature);
    out.response.userHandle = r.userHandle ? bufToB64url(r.userHandle) : null;
  }
  return out;
}

// passkeyLogin runs the passwordless assertion flow for username and, on success,
// stores the session and redirects to the app.
async function passkeyLogin(username, msg, finish) {
  if (!window.PublicKeyCredential) { showMsg(msg, "This browser does not support passkeys", "error"); return; }
  showMsg(msg, "Waiting for your passkey…", "");
  let options;
  try {
    const r = await fetch(API + "webauthn/login/begin", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username }),
    });
    if (!r.ok) { showMsg(msg, (await r.text()) || "No passkey for this account", "error"); return; }
    options = prepRequestOptions((await r.json()).publicKey);
  } catch (e) { showMsg(msg, t("Network error"), "error"); return; }
  let assertion;
  try { assertion = await navigator.credentials.get({ publicKey: options }); }
  catch (e) { showMsg(msg, "Passkey sign-in was cancelled", "error"); return; }
  try {
    const r = await fetch(API + "webauthn/login/finish", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(credToJSON(assertion)),
    });
    if (!r.ok) { showMsg(msg, (await r.text()) || "Passkey verification failed", "error"); return; }
    const d = await r.json();
    finish(d.token, d.username);
  } catch (e) { showMsg(msg, t("Network error"), "error"); }
}

function initLogin() {
  const form = document.getElementById("login-form");
  const mfaForm = document.getElementById("mfa-form");
  const msg = document.getElementById("msg");
  const alt = document.getElementById("login-alt");
  const passkeyBtn = document.getElementById("passkey-login");
  let creds = null; // {username, password} held between the two login steps

  // OAuth handoff: the provider callback redirects back here with the web-token
  // in the URL fragment (never sent to the server / logs), or an error message.
  if (handleOAuthFragment(msg)) return;
  loadOAuthButtons();

  // Offer passkey sign-in when the browser supports WebAuthn.
  if (passkeyBtn && window.PublicKeyCredential) {
    passkeyBtn.hidden = false;
    passkeyBtn.addEventListener("click", () => {
      const username = document.getElementById("username").value.trim();
      if (!username) { showMsg(msg, "Enter your username first", "error"); document.getElementById("username").focus(); return; }
      passkeyLogin(username, msg, finish);
    });
  }

  // First run (no accounts yet): send the operator to the setup wizard. Also
  // hide the "create one" link when self-registration is disabled.
  fetch(API + "setup_status")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d) return;
      if (d.setup_required) { location.href = PREFIX + "setup"; return; }
      if (d.registration_open === false && alt) alt.style.display = "none";
    })
    .catch(() => {});

  async function authenticate(username, password, totp) {
    const payload = { method: "usernamepassword", username, password };
    if (totp) payload.totp = totp;
    return fetch(API + "bootstrap_authentication", { method: "POST", body: btoa(JSON.stringify(payload)) });
  }

  function finish(token, username) { setSession(token, username); location.href = PREFIX; }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;
    showMsg(msg, "Logging in…", "");
    try {
      const resp = await authenticate(username, password, null);
      if (!resp.ok) { showMsg(msg, (await resp.text()) || "Login failed", "error"); return; }
      const data = await resp.json();
      if (data.mfa_required) {
        creds = { username, password };
        form.hidden = true; alt.hidden = true; mfaForm.hidden = false;
        if (passkeyBtn) passkeyBtn.hidden = true;
        showMsg(msg, "Enter the code from your authenticator app.", "");
        document.getElementById("mfa-code").focus();
        return;
      }
      finish(data.token, username);
    } catch (err) { showMsg(msg, t("Network error"), "error"); }
  });

  mfaForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!creds) return;
    const code = document.getElementById("mfa-code").value.trim();
    showMsg(msg, "Verifying…", "");
    try {
      const resp = await authenticate(creds.username, creds.password, code);
      if (!resp.ok) { showMsg(msg, (await resp.text()) || "Invalid code", "error"); return; }
      const data = await resp.json();
      if (!data.token) { showMsg(msg, "Invalid code", "error"); return; }
      finish(data.token, creds.username);
    } catch (err) { showMsg(msg, t("Network error"), "error"); }
  });

  document.getElementById("mfa-back").addEventListener("click", (e) => {
    e.preventDefault();
    creds = null;
    mfaForm.hidden = true; form.hidden = false; alt.hidden = false;
    if (passkeyBtn && window.PublicKeyCredential) passkeyBtn.hidden = false;
    document.getElementById("mfa-code").value = "";
    showMsg(msg, "", "");
  });
}

function initRegister() {
  const form = document.getElementById("register-form");
  const msg = document.getElementById("msg");

  // Reflect the server's self-registration switch: disable the form when closed.
  fetch(API + "setup_status")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d && d.registration_open === false) {
        form.querySelectorAll("input, button").forEach((el) => { el.disabled = true; });
        showMsg(msg, "Self-registration is disabled on this server.", "error");
      }
    })
    .catch(() => {});

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;
    const password2 = document.getElementById("password2").value;
    if (password !== password2) { showMsg(msg, "Passwords do not match", "error"); return; }
    showMsg(msg, "Creating account…", "");
    try {
      const resp = await fetch(API + "register", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!resp.ok) { showMsg(msg, (await resp.text()) || "Registration failed", "error"); return; }
      showMsg(msg, "Account created! Redirecting to login…", "ok");
      setTimeout(() => { location.href = PREFIX + "login"; }, 900);
    } catch (err) { showMsg(msg, t("Network error"), "error"); }
  });
}

// ---- Shared sidebar ---------------------------------------------------------

function fillSidebar() {
  const user = localStorage.getItem(USER_KEY) || "";
  const nameEl = document.getElementById("side-user");
  const avEl = document.getElementById("avatar");
  // First paint from localStorage; revealChrome upgrades this to the profile
  // name and picture once whoami answers.
  if (nameEl) nameEl.textContent = user;
  if (avEl) avEl.textContent = initials(user);
  const lo = document.getElementById("logout");
  if (lo) lo.addEventListener("click", logout);
  setupSidebarTimer();
  revealChrome();
}

// NAV_CAP maps each Admin nav entry (by its page) to the capability that unlocks
// it, mirroring adminRouteCap on the server. The Roles page can take any of these
// away from a role, so the menu is built from capabilities, not from the role.
const NAV_CAP = {
  users: "users.manage",
  roles: "roles.manage",
  groups: "groups.manage",
  settings: "server.manage",
  oauth: "oauth.manage",
  translations: "translations.manage",
  // The whole Skills section defines the catalogue, so all three take the same
  // capability. Users reach skills through My Skills in the main menu, which
  // only lets them pick from what is defined here.
  skills: "skills.manage",
  skillcats: "skills.manage",
  skilllevels: "skills.manage",
};

// NAV_MODULE maps a single nav entry to the optional module that must be
// switched on for it to lead anywhere. Off by default, so these stay hidden
// until an admin enables them on the Settings page.
const NAV_MODULE = {
  "nav-shifts": "shifts",
  "nav-my-skills": "skills",
};

// NAV_SECTION_MODULE does the same for a whole nav section, so the Skills
// heading disappears with its entries rather than sitting above nothing.
const NAV_SECTION_MODULE = {
  "nav-skills-section": "skills",
};

// revealChrome makes one whoami call to reveal role-specific UI: the Admin nav
// section (per capability) and the user switcher for controllers.
async function revealChrome() {
  try {
    const r = await apiFetch("whoami");
    if (!r.ok) return;
    const d = await r.json();
    window.TT_IS_ADMIN = !!d.is_admin;
    window.TT_IS_CONTROLLER = !!d.is_controller;
    window.TT_USER = d.username;
    window.TT_CAPS = d.caps || [];
    window.TT_MODULES = d.modules || [];
    const can = (c) => window.TT_CAPS.includes(c);
    reconcileLang(); // not awaited: nav reveal must not wait on a settings fetch

    // Module pages start hidden in the markup and are revealed only where the
    // server says the module is on; its page 404s otherwise.
    for (const [id, key] of Object.entries(NAV_MODULE)) {
      const a = document.getElementById(id);
      if (a && window.TT_MODULES.includes(key)) a.style.display = "";
    }

    // Show the signed-in user by name and picture once whoami answers; the
    // sidebar starts with the username and initials from localStorage.
    const nameEl = document.getElementById("side-user");
    if (nameEl) nameEl.textContent = displayName(d.username, d.profile);
    const avEl = document.getElementById("avatar");
    if (avEl) {
      if (d.avatar) {
        avEl.classList.add("has-img");
        avEl.innerHTML = `<img src="${escapeHtml(d.avatar)}" alt="">`;
      } else {
        avEl.textContent = initials(d.username, d.profile);
      }
    }

    // Every nav section resolves the same way: a section tied to an optional
    // module disappears wholesale when the module is off, and inside it each
    // entry survives only if the viewer holds the capability it needs. A section
    // left with nothing reachable is hidden too, so a heading never sits above
    // an empty list.
    //
    // Entries with no capability in NAV_CAP (the Skills page itself) are open,
    // and count towards keeping their section visible.
    document.querySelectorAll(".nav-section").forEach((sec) => {
      const mod = NAV_SECTION_MODULE[sec.id];
      if (mod && !window.TT_MODULES.includes(mod)) {
        sec.style.display = "none";
        return;
      }
      let any = false;
      sec.querySelectorAll("a").forEach((a) => {
        const page = a.getAttribute("href").split("/").filter(Boolean).pop();
        const cap = NAV_CAP[page];
        const entryMod = NAV_MODULE[a.id];
        const reachable = (!cap || can(cap)) && (!entryMod || window.TT_MODULES.includes(entryMod));
        if (!reachable) { a.style.display = "none"; return; }
        a.style.display = "";
        any = true;
      });
      sec.style.display = any ? "" : "none";
    });
    if (can("users.actas")) setupSwitcher();
  } catch (e) { /* ignore */ }
}

// ---- Sidebar timer ----------------------------------------------------------
// A live stopwatch pinned above the user footer on every page: the sidebar shows
// just the running clock and a Start/Stop button. Clicking Start opens a modal
// (like the new-entry sheet) to pick the description, tags, and start time — now
// or a chosen "already started" moment. The running flag, start time, and the
// captured description/tags persist in localStorage so they survive page
// navigation (each nav is a full reload) and a resumed tab. Stopping writes a
// normal record via putRecord, so tracked time lands in the same store as
// manually-added entries and respects the controller's actas view.
const TIMER_KEY = "tagged_web_timer";
let timerState = { running: false, startEpoch: 0, desc: "", tags: [] };
let timerTick = null;
let tkmWhen = "now"; // start-time mode in the modal: "now" | "past"

function loadTimerState() {
  try {
    const s = JSON.parse(localStorage.getItem(TIMER_KEY) || "null");
    if (s && typeof s === "object") {
      timerState = {
        running: !!s.running,
        startEpoch: Number(s.startEpoch) || 0,
        desc: typeof s.desc === "string" ? s.desc : "",
        tags: Array.isArray(s.tags) ? s.tags.filter((t) => typeof t === "string") : [],
      };
    }
  } catch (e) { /* keep defaults */ }
  if (timerState.running && !timerState.startEpoch) timerState.running = false;
}
function saveTimerState() { localStorage.setItem(TIMER_KEY, JSON.stringify(timerState)); }

// fmtHMS splits a duration into padded [hours, minutes, seconds] strings.
function fmtHMS(sec) {
  sec = Math.max(0, Math.floor(sec));
  return [pad(Math.floor(sec / 3600)), pad(Math.floor((sec % 3600) / 60)), pad(sec % 60)];
}

function renderTimerClock() {
  const hEl = document.getElementById("tmr-h");
  if (!hEl) return;
  const elapsed = timerState.running ? (Date.now() / 1000 - timerState.startEpoch) : 0;
  const [h, m, s] = fmtHMS(elapsed);
  hEl.textContent = h;
  document.getElementById("tmr-m").textContent = m;
  document.getElementById("tmr-s").textContent = s;
}

// ---- Timer modal: description, tags, and start-time picker ----

function renderTimerTags() {
  const host = document.getElementById("tkm-tags");
  if (!host) return;
  host.innerHTML = timerState.tags.length
    ? timerState.tags.map((t) => {
        const c = colorFor(t);
        return `<span class="em-tag-chip" style="background:${c}26;color:${c}">${escapeHtml(labelFor(t) || ("#" + t))}<button class="x" data-t="${escapeHtml(t)}" type="button" aria-label="Remove">×</button></span>`;
      }).join("")
    : `<span class="em-none">${escapeHtml(t("No tags yet."))}</span>`;
  host.querySelectorAll(".x").forEach((b) => b.addEventListener("click", () => {
    timerState.tags = timerState.tags.filter((x) => x !== b.dataset.t);
    saveTimerState();
    renderTimerTags();
  }));
}

// renderTimerTagMenu fills the "＋ Add" dropdown with saved tags not already on
// the timer, followed by a "New Tag…" action (mirrors the entry modal).
function renderTimerTagMenu() {
  const menu = document.getElementById("tkm-tag-menu");
  const avail = allTagKeys().filter((t) => !timerState.tags.includes(t));
  const items = avail.map((t) => {
    const c = colorFor(t);
    return `<button type="button" class="em-tag-opt" data-t="${escapeHtml(t)}"><span class="dot" style="background:${c}"></span>${escapeHtml(labelFor(t) || ("#" + t))}</button>`;
  }).join("");
  menu.innerHTML =
    (items || `<div class="em-tag-empty">${escapeHtml(t("No saved tags"))}</div>`) +
    '<div class="em-tag-sep"></div>' +
    `<button type="button" class="em-tag-new">＋ ${escapeHtml(t("New tag…"))}</button>`;

  menu.querySelectorAll(".em-tag-opt").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    addTimerTag(b.dataset.t);
    closeAllMenus();
  }));
  menu.querySelector(".em-tag-new").addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllMenus();
    const wrap = document.getElementById("tkm-add-wrap");
    wrap.hidden = false;
    const inp = document.getElementById("tkm-tag-input");
    inp.value = "";
    inp.focus();
  });
}

function addTimerTag(raw) {
  const tag = normalizeTag(raw);
  if (tag && !timerState.tags.includes(tag)) { timerState.tags.push(tag); saveTimerState(); }
  const wrap = document.getElementById("tkm-add-wrap");
  const inp = document.getElementById("tkm-tag-input");
  if (inp) inp.value = "";
  if (wrap) wrap.hidden = true;
  renderTimerTags();
}

function tkmError(text) { const el = document.getElementById("tkm-msg"); if (el) el.textContent = text || ""; }

// setTkmWhen toggles between "Start now" and "Already started"; the latter reveals
// the date/time inputs so a past start moment can be entered.
function setTkmWhen(when) {
  tkmWhen = when;
  document.querySelectorAll("#timer-modal .tkm-when-opt").forEach((b) => b.classList.toggle("active", b.dataset.when === when));
  const row = document.getElementById("tkm-start-row");
  if (row) row.hidden = when !== "past";
}

function openTimerModal() {
  // Each run starts from a clean draft; the modal is where it's filled in.
  timerState.desc = "";
  timerState.tags = [];
  document.getElementById("tkm-desc").value = "";
  document.getElementById("tkm-add-wrap").hidden = true;
  tkmError("");
  closeAllMenus();
  setTkmWhen("now");
  const now = Math.floor(Date.now() / 1000);
  document.getElementById("tkm-start-date").value = dateInputVal(now);
  document.getElementById("tkm-start-time").value = timeInputVal(now);
  renderTimerTags();
  document.getElementById("timer-modal").hidden = false;
  document.getElementById("tkm-desc").focus();
}

function closeTimerModal() { document.getElementById("timer-modal").hidden = true; }

// confirmStartTimer captures the modal's fields and starts the running clock.
function confirmStartTimer() {
  timerState.desc = document.getElementById("tkm-desc").value.trim();
  let startEpoch;
  if (tkmWhen === "past") {
    startEpoch = combineDT(document.getElementById("tkm-start-date").value, document.getElementById("tkm-start-time").value);
    if (isNaN(startEpoch)) { tkmError("Enter a valid start date and time."); return; }
    if (startEpoch > Math.floor(Date.now() / 1000) + 60) { tkmError("Start time can't be in the future."); return; }
  } else {
    startEpoch = Math.floor(Date.now() / 1000);
  }
  timerState.running = true;
  timerState.startEpoch = startEpoch;
  saveTimerState();
  closeTimerModal();
  timerTickStart();
  updateTimerUI();
}

// timerComposeDs builds the record description: free text followed by #tags.
function timerComposeDs() {
  const desc = (timerState.desc || "").trim();
  const tags = timerState.tags.map((t) => "#" + t).join(" ");
  return (desc + " " + tags).trim();
}

function timerTickStart() { if (!timerTick) timerTick = setInterval(renderTimerClock, 1000); }
function timerTickStop() { if (timerTick) { clearInterval(timerTick); timerTick = null; } }

async function stopTimer() {
  const t1 = timerState.startEpoch;
  const t2 = Math.floor(Date.now() / 1000);
  const ds = timerComposeDs();
  timerState.running = false;
  timerState.startEpoch = 0;
  timerTickStop();
  // Only persist spans of at least a second; a mis-click Start/Stop records nothing.
  if (t1 && t2 > t1) {
    const ok = await putRecord({ key: randomKey(), mt: Math.floor(Date.now() / 1000), t1, t2, ds });
    if (ok) {
      timerState.desc = "";
      timerState.tags = [];
      await refreshAfterTimer();
    }
  }
  saveTimerState();
  updateTimerUI();
}

// The timer lives in the sidebar, so it can finish a record on any page, but
// only the pages that display records care. Rather than the timer knowing which
// those are, they say so: a page that shows records registers how to redraw
// itself, and the timer just calls whatever registered.
//
// This is the one place the shared chrome reached into a specific page, and it
// is why the dashboard and entries renderers had to travel with every page.
let refreshHook = null;

// registerRefresh is called by a page that renders records, so a timer stopped
// from the sidebar shows up without a reload.
function registerRefresh(fn) { refreshHook = fn; }

// refreshAfterTimer reloads records and re-renders the current page, so a freshly
// tracked entry shows up immediately on the dashboard or entries view.
async function refreshAfterTimer() {
  if (!refreshHook) return; // a page that shows no records has nothing to redraw
  try {
    await loadAll();
    refreshHook();
  } catch (e) { /* ignore refresh failures; the record is already saved */ }
}

const TMR_ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const TMR_ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

function updateTimerUI() {
  renderTimerClock();
  const btn = document.getElementById("tmr-start");
  const root = document.getElementById("side-timer");
  if (btn) btn.innerHTML = (timerState.running ? TMR_ICON_STOP : TMR_ICON_PLAY) + "<span>" + (timerState.running ? "Stop" : "Start") + "</span>";
  if (root) root.classList.toggle("running", timerState.running);
}

// injectTimerModal appends the start-timer sheet to the page once and wires it.
function injectTimerModal() {
  if (document.getElementById("timer-modal")) return;
  const modal = document.createElement("div");
  modal.className = "modal-overlay";
  modal.id = "timer-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="sheet">
      <div class="sheet-title">Start timer</div>
      <div class="sheet-section">
        <div class="sheet-label">Description</div>
        <input id="tkm-desc" class="em-input" type="text" placeholder="What are you working on?" autocomplete="off">
      </div>
      <div class="sheet-section">
        <div class="sheet-section-head">
          <span class="sheet-label">Tags</span>
          <div class="em-add-anchor">
            <button id="tkm-add-tag" class="link-accent" type="button">＋ Add</button>
            <div class="menu-pop em-tag-menu" id="tkm-tag-menu"></div>
          </div>
        </div>
        <div class="em-tags" id="tkm-tags"></div>
        <div id="tkm-add-wrap" hidden>
          <div class="em-add-row">
            <input id="tkm-tag-input" type="text" placeholder="New tag name" autocomplete="off">
            <button id="tkm-tag-add-btn" class="btn-sm" type="button">Add</button>
          </div>
        </div>
      </div>
      <div class="sheet-section">
        <div class="sheet-label" style="margin-bottom:12px">Start</div>
        <div class="tkm-when">
          <button type="button" class="tkm-when-opt active" data-when="now">Start now</button>
          <button type="button" class="tkm-when-opt" data-when="past">Already started</button>
        </div>
        <div class="time-row tkm-start-row" id="tkm-start-row" hidden>
          <span class="tr-label">Started at</span>
          <div class="tr-inputs"><input type="date" id="tkm-start-date"><input type="time" id="tkm-start-time"></div>
        </div>
      </div>
      <div class="em-msg" id="tkm-msg"></div>
      <div class="sheet-actions">
        <div class="spacer"></div>
        <button id="tkm-cancel" class="secondary" type="button">Cancel</button>
        <button id="tkm-start-btn" type="button">Start</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  document.getElementById("tkm-cancel").addEventListener("click", closeTimerModal);
  document.getElementById("tkm-start-btn").addEventListener("click", confirmStartTimer);
  document.getElementById("tkm-desc").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); confirmStartTimer(); }
  });
  modal.querySelectorAll(".tkm-when-opt").forEach((b) => b.addEventListener("click", () => setTkmWhen(b.dataset.when)));
  document.getElementById("tkm-add-tag").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = document.getElementById("tkm-tag-menu");
    const wasOpen = menu.classList.contains("open");
    closeAllMenus();
    if (!wasOpen) { renderTimerTagMenu(); menu.classList.add("open"); }
  });
  document.getElementById("tkm-tag-add-btn").addEventListener("click", () => addTimerTag(document.getElementById("tkm-tag-input").value));
  document.getElementById("tkm-tag-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addTimerTag(e.target.value); }
  });
  // Close when clicking the dimmed backdrop.
  modal.addEventListener("click", (e) => { if (e.target === modal) closeTimerModal(); });
}

// setupSidebarTimer injects the clock + Start button above the user footer and
// wires the start-timer modal. No-op without a sidebar or if already injected.
function setupSidebarTimer() {
  const sidebar = document.querySelector(".sidebar");
  const foot = sidebar && sidebar.querySelector(".side-foot");
  if (!sidebar || !foot || document.getElementById("side-timer")) return;
  loadTimerState();

  const el = document.createElement("div");
  el.className = "side-timer";
  el.id = "side-timer";
  el.innerHTML = `
    <div class="tmr-clock">
      <span class="tmr-seg" id="tmr-h">00</span><span class="tmr-u">h</span>
      <span class="tmr-seg" id="tmr-m">00</span><span class="tmr-u">m</span>
      <span class="tmr-seg" id="tmr-s">00</span><span class="tmr-u">s</span>
    </div>
    <button class="tmr-start" id="tmr-start" type="button"></button>`;
  sidebar.insertBefore(el, foot);
  injectTimerModal();

  document.getElementById("tmr-start").addEventListener("click", () => {
    if (timerState.running) stopTimer(); else openTimerModal();
  });
  document.addEventListener("click", () => closeAllMenus());

  // Load saved tags for the picker on pages that don't otherwise fetch settings
  // (e.g. Import/Export, About), so the "＋ Add" menu is populated everywhere.
  if (allTagKeys().length === 0) { loadSettings().then(renderTimerTags).catch(() => {}); }

  if (timerState.running) timerTickStart();
  updateTimerUI();
}

// setupSwitcher builds the controller's "view as user" dropdown in the sidebar
// and, when a target is active, an impersonation banner atop the content area.
async function setupSwitcher() {
  const sidebar = document.querySelector(".sidebar");
  if (!sidebar || document.getElementById("tt-switcher")) return;

  let users = [];
  try {
    const r = await apiFetch("controller/users");
    if (r.ok) users = (await r.json()).users || [];
  } catch (e) { /* ignore */ }

  // With no groups to control there is nobody to switch to, so skip the picker
  // rather than show one holding only "You".
  if (users.length === 0) {
    localStorage.removeItem(ACTAS_KEY);
    return;
  }

  const current = getActAs();
  const wrap = document.createElement("div");
  wrap.className = "switcher";
  const opts = ['<option value="">You</option>']
    .concat(users.map((u) => `<option value="${escapeHtml(u.username)}">${escapeHtml(u.username)}</option>`))
    .join("");
  wrap.innerHTML = `<label class="switcher-label">View as</label>
    <select id="tt-switcher" class="switcher-select">${opts}</select>`;
  const nav = sidebar.querySelector(".nav");
  if (nav) sidebar.insertBefore(wrap, nav); else sidebar.appendChild(wrap);

  const sel = wrap.querySelector("#tt-switcher");
  // If the stored target is no longer switchable, fall back to self.
  if (current && !users.some((u) => u.username === current)) {
    localStorage.removeItem(ACTAS_KEY);
  } else {
    sel.value = current;
  }
  sel.addEventListener("change", () => {
    const v = sel.value;
    if (v) localStorage.setItem(ACTAS_KEY, v); else localStorage.removeItem(ACTAS_KEY);
    location.reload();
  });

  renderActAsBanner();
}

// renderActAsBanner shows a bar at the top of the content when viewing another
// user's data, with an Exit control that returns to the controller's own data.
function renderActAsBanner() {
  const target = getActAs();
  if (!target) return;
  const content = document.querySelector(".content");
  if (!content || document.getElementById("actas-banner")) return;
  const bar = document.createElement("div");
  bar.id = "actas-banner";
  bar.className = "actas-banner";
  bar.innerHTML = `<span>Viewing <strong>${escapeHtml(target)}</strong>'s data</span>
    <button type="button" id="actas-exit" class="actas-exit">Exit</button>`;
  content.insertBefore(bar, content.firstChild);
  bar.querySelector("#actas-exit").addEventListener("click", () => {
    localStorage.removeItem(ACTAS_KEY);
    location.reload();
  });
}

// ---- Settings (goals) -------------------------------------------------------

async function loadSettings() {
  TAGCOLORS = {};
  TAGINFO_RAW = {};
  try {
    const resp = await apiFetch("settings");
    const data = await resp.json();
    for (const s of (data.settings || [])) {
      if (s.key === DAILY_GOAL_KEY) { GOALS.daily = Number(s.value) || GOALS.daily; continue; }
      if (s.key === WEEKLY_GOAL_KEY) { GOALS.weekly = Number(s.value) || GOALS.weekly; continue; }
      if (s.key === WEEK_START_KEY) { const n = Number(s.value); if (n === 0 || n === 1 || n === 6) PREFS.weekStart = n; continue; }
      if (s.key === WORKDAYS_KEY) { if (WORKDAY_PRESETS[s.value]) PREFS.workdays = s.value; continue; }
      if (s.key === TIMEZONE_KEY) { if (s.value) PREFS.timezone = String(s.value); continue; }
      if (s.key === LANGUAGE_KEY) { if (s.value) PREFS.language = String(s.value); continue; }
      if (typeof s.key === "string" && s.key.startsWith(TAGINFO_PREFIX)) {
        const tag = s.key.slice(TAGINFO_PREFIX.length).toLowerCase();
        const info = (s.value && typeof s.value === "object") ? s.value : {};
        TAGINFO_RAW[tag] = info;
        if (info.color) TAGCOLORS[tag] = info.color;
      }
    }
  } catch (e) { /* keep defaults */ }
}

// saveTagColor writes a tag's color as a TimeTagger-compatible taginfo setting,
// preserving any other fields already stored for that tag.
async function saveTagColor(tagKey, hex) {
  const info = Object.assign({}, TAGINFO_RAW[tagKey] || {});
  if (hex) info.color = hex; else delete info.color;
  const resp = await apiFetch("settings", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ key: TAGINFO_PREFIX + tagKey, mt: Math.floor(Date.now() / 1000), value: info }]),
  });
  if (resp.ok) {
    TAGINFO_RAW[tagKey] = info;
    if (hex) TAGCOLORS[tagKey] = hex; else delete TAGCOLORS[tagKey];
  }
  return resp.ok;
}


// ---- Dashboard --------------------------------------------------------------

let selDate = midnight(new Date());

// donutSVG builds the ring's contents for a 0 0 42 42 viewBox: a track circle
// plus one arc per segment, drawn with stroke-dasharray on a 100-unit
// circumference so a segment's length is its percentage. Segments are {sec,
// color}; `total` is what the parts sum to. Returns markup so any panel can host
// a ring -- the dashboard writes it into #donut, the Skills page into its own.
function donutSVG(segments, total) {
  const CX = 21, CY = 21, R = 15.915, SW = 5;
  let parts = `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="var(--surface-raised)" stroke-width="${SW}"/>`;
  if (total > 0) {
    let cum = 0;
    const segs = segments.map((s) => {
      const pct = (s.sec / total) * 100;
      if (pct <= 0) return "";
      const c = `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${s.color}" stroke-width="${SW}" stroke-dasharray="${pct.toFixed(3)} ${(100 - pct).toFixed(3)}" stroke-dashoffset="${(-cum).toFixed(3)}"/>`;
      cum += pct;
      return c;
    });
    parts += `<g transform="rotate(-90 ${CX} ${CY})">${segs.join("")}</g>`;
  }
  return parts;
}


function badge(key) {
  const c = colorFor(key);
  return `<span class="badge" style="background:${c}26;color:${c}">${escapeHtml(labelFor(key))}</span>`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}



async function loadAll() {
  const resp = await apiFetch("records?timerange=0-4102444800");
  ALL = ((await resp.json()).records || []).filter((r) => !(r.ds || "").startsWith("HIDDEN"));
  buildTagMeta(ALL);
}

// ---- Live sync --------------------------------------------------------------
// The server has no push channel, but /updates?since=<t> is a cheap delta feed:
// when the database is untouched it returns an empty set after just an mtime
// check. We poll it and merge only what changed, so other apps' edits show up
// within a few seconds without re-fetching the whole history.
let lastSync = 0;          // server_time of our most recent successful sync

// mergeRecords upserts incoming records into ALL by key (HIDDEN = removed) and
// returns whether anything actually changed.
function mergeRecords(incoming) {
  let changed = false;
  const byKey = new Map(ALL.map((r) => [r.key, r]));
  for (const r of incoming) {
    if ((r.ds || "").startsWith("HIDDEN")) {
      if (byKey.delete(r.key)) changed = true;
      continue;
    }
    const ex = byKey.get(r.key);
    if (!ex || ex.mt !== r.mt || ex.t1 !== r.t1 || ex.t2 !== r.t2 || ex.ds !== r.ds) {
      byKey.set(r.key, r);
      changed = true;
    }
  }
  if (changed) { ALL = Array.from(byKey.values()); buildTagMeta(ALL); }
  return changed;
}

// syncUpdates pulls the delta since lastSync and invokes onChange() if the local
// data changed. Errors are swallowed so a transient failure doesn't kill polling.
async function syncUpdates(onChange) {
  try {
    const resp = await apiFetch("updates?since=" + encodeURIComponent(lastSync));
    if (!resp.ok) return;
    const d = await resp.json();
    let changed = false;
    if (d.reset) {
      await loadAll();
      changed = true;
    } else {
      changed = mergeRecords(d.records || []);
      if ((d.settings || []).length) { await loadSettings(); changed = true; }
    }
    if (typeof d.server_time === "number") lastSync = d.server_time;
    if (changed && onChange) onChange();
  } catch (e) { /* offline / transient: try again next tick */ }
}



// ---- Account ----------------------------------------------------------------










// ---- Time entries page ------------------------------------------------------


function weekStartOf(d) { return midnight(addDays(d, -weekStartOffset(d))); }
function weekTitle(start) {
  const end = addDays(start, 6);
  const mS = monthShort(start.getMonth());
  const mE = monthShort(end.getMonth());
  // Two patterns rather than one: a week inside a single month names it once,
  // and both need to be reorderable -- "13.-19. Juli 2026" puts the month last.
  if (start.getMonth() === end.getMonth()) {
    return t("{month} {from} – {to}, {year}",
      { month: mS, from: start.getDate(), to: end.getDate(), year: end.getFullYear() });
  }
  return t("{fromMonth} {from} – {toMonth} {to}, {year}",
    { fromMonth: mS, from: start.getDate(), toMonth: mE, to: end.getDate(), year: end.getFullYear() });
}

async function putRecord(obj) {
  const resp = await apiFetch("records", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify([obj]),
  });
  return resp.ok;
}


// ---- Entry details panel ----------------------------------------------------







// ---- Timeline state ---------------------------------------------------------






function closeAllMenus() { document.querySelectorAll(".menu-pop.open").forEach((p) => p.classList.remove("open")); }



// ---- Entry editor modal -----------------------------------------------------


function normalizeTag(s) {
  s = (s || "").trim().replace(/^#+/, "").toLowerCase().replace(RE_NON_TAG_CHAR, "");
  return s.length >= 2 ? s : "";
}
function dateInputVal(epoch) { const d = new Date(epoch * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function timeInputVal(epoch) { const d = new Date(epoch * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function combineDT(dateStr, timeStr) {
  if (!dateStr || !timeStr) return NaN;
  const [y, mo, da] = dateStr.split("-").map(Number);
  const [h, mi] = timeStr.split(":").map(Number);
  return Math.floor(new Date(y, mo - 1, da, h, mi, 0).getTime() / 1000);
}
function allTagKeys() {
  const set = new Set();
  for (const r of ALL) for (const raw of allTagsOf(r.ds)) set.add(raw.slice(1).toLowerCase());
  for (const k of Object.keys(TAGCOLORS)) set.add(k);
  return Array.from(set).sort();
}

// randomKey generates an 8-char record key (same shape as the client's uids).
function randomKey() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}










// ---- Report -----------------------------------------------------------------







function downloadBlob(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.style.display = "none";
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvCell(s) {
  s = String(s == null ? "" : s);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}








// ---- Admin: user management -------------------------------------------------

function fmtDate(epoch) {
  if (!epoch) return "—";
  const d = new Date(epoch * 1000);
  return t("{d} {month} {year}", { d: d.getDate(), month: monthShort(d.getMonth()), year: d.getFullYear() });
}


// initials derives up to two avatar letters from a profile name, falling back to
// the username / email.
function initials(username, profile) {
  const full = fullName(profile);
  if (full) {
    const parts = full.split(/\s+/).filter(Boolean);
    const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : full.slice(0, 2);
    return letters.toUpperCase();
  }
  const name = (username || "").split("@")[0];
  const parts = name.split(/[.\-_ ]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return (letters || "?").toUpperCase();
}

// ---- Profiles ---------------------------------------------------------------
// Directory details (name, job, contact) and the profile picture. Every account
// owns its own; admins edit anyone's from the Users page. A picture is a data
// URI the browser produced from a square-cropped 256px JPEG.

const AVATAR_PX = 256;      // stored picture edge length
const AVATAR_QUALITY = 0.85;

function fullName(profile) {
  if (!profile) return "";
  return [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim();
}

// displayName is what to call this account in the UI: their name if they have
// one, otherwise the username they log in with.
function displayName(username, profile) {
  return fullName(profile) || username;
}

// avatarHtml renders a picture when one is set and the initials circle when not.
// cls adds modifiers (e.g. "lg") to the shared .um-avatar styling.
function avatarHtml(username, profile, avatar, cls = "") {
  const c = `um-avatar${cls ? " " + cls : ""}`;
  if (avatar) {
    return `<span class="${c} has-img"><img src="${escapeHtml(avatar)}" alt=""></span>`;
  }
  return `<span class="${c}">${escapeHtml(initials(username, profile))}</span>`;
}

// resizeAvatar center-crops an image file to a square and scales it to
// AVATAR_PX, returning a JPEG data URI. Doing this in the browser keeps the
// stored picture small and predictable, so the server only has to validate it.
function resizeAvatar(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      if (!side) { reject(new Error("That image looks empty")); return; }
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = AVATAR_PX;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(
        img,
        (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side,
        0, 0, AVATAR_PX, AVATAR_PX,
      );
      resolve(canvas.toDataURL("image/jpeg", AVATAR_QUALITY));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file is not a readable image")); };
    img.src = url;
  });
}

// pickAvatar opens the given file input and resolves with the resized data URI,
// or null if the visitor cancelled.
function pickAvatar(input) {
  return new Promise((resolve, reject) => {
    input.value = ""; // so re-picking the same file still fires "change"
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) { resolve(null); return; }
      try { resolve(await resizeAvatar(file)); } catch (e) { reject(e); }
    };
    input.click();
  });
}

// PROFILE_FIELDS drives both profile forms: [draft key, input id suffix, label].
const PROFILE_FIELDS = [
  ["first_name", "first"],
  ["last_name", "last"],
  ["job", "job"],
  ["department", "dept"],
  ["email", "email"],
  ["phone", "phone"],
  ["mobile", "mobile"],
];





// ---- Admin actions (shared by the details panel and the row menu) -----------







// ---- Row "⋯" menu -----------------------------------------------------------



// ---- Details panel ----------------------------------------------------------



// udRow renders one label/value line inside a details card.
function udRow(label, value, cls = "") {
  return `<div class="ud-field"><span class="k">${escapeHtml(label)}</span>
    <span class="v ${cls}">${value}</span></div>`;
}

// udCard wraps a titled section with an optional action button in its header.
function udCard(title, body, action = "") {
  return `<div class="ud-card">
    <div class="ud-card-head"><span class="ud-card-title">${escapeHtml(title)}</span>${action}</div>
    ${body}
  </div>`;
}







// ---- Edit profile modal -----------------------------------------------------





// ---- Manage groups modal ----------------------------------------------------







// ---- Manage roles modal -----------------------------------------------------








// ---- Add-user modal ---------------------------------------------------------


// requireCap sends the visitor home unless they hold cap, so an admin page never
// renders as a wall of 403s. The server enforces the same capability on every
// route the page calls; this is only to keep the UI honest.
async function requireCap(cap) {
  try {
    const who = await apiFetch("whoami");
    if (!who.ok) return false;
    const caps = (await who.json()).caps || [];
    if (!caps.includes(cap)) { location.href = PREFIX; return false; }
    return true;
  } catch (e) { return false; }
}



// ---- Roles page -------------------------------------------------------------








// ---- New / edit role modal --------------------------------------------------










// ---- Groups page ------------------------------------------------------------













// ---- Manage members / controllers modal -------------------------------------










// ---- Edit group modal -------------------------------------------------------





// ---- Duplicate group modal --------------------------------------------------









// ---- Own profile (Account page) ---------------------------------------------

// ---- Tag manager ------------------------------------------------------------



// ---- Tag editor modal -------------------------------------------------------











// ---- Bulk add tags ----------------------------------------------------------








// ---- Dispatch ---------------------------------------------------------------

// ---- Import / Export --------------------------------------------------------










// ---- About ------------------------------------------------------------------



// ---- Admin · Servers --------------------------------------------------------


// ---- Email (SMTP) -----------------------------------------------------------

// ---- Modules ----------------------------------------------------------------








// ---- Theme-aware favicon ----------------------------------------------------

// applyFavicon selects the light or dark favicon set from the browser's color
// scheme, replacing any existing icon links. Runs immediately (the script tag is
// at the end of <body>, so document.head already exists) and again whenever the
// OS/browser theme changes, so the tab icon updates live without a reload.
function applyFavicon() {
  if (!window.matchMedia) return;
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const base = PREFIX + "images/" + (dark ? "favicon_dark" : "favicon_light") + "/";
  // These links are built here rather than in the HTML, so they have to carry
  // the build version themselves to get the same cache treatment.
  const v = VERSION ? "?v=" + encodeURIComponent(VERSION) : "";
  document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]').forEach((l) => l.remove());
  const add = (rel, href, type, sizes) => {
    const l = document.createElement("link");
    l.rel = rel; l.href = href;
    if (type) l.type = type;
    if (sizes) l.sizes = sizes;
    document.head.appendChild(l);
  };
  add("icon", base + "favicon-32x32.png" + v, "image/png", "32x32");
  add("icon", base + "favicon-16x16.png" + v, "image/png", "16x16");
  add("icon", base + "favicon.ico" + v, "image/x-icon");
  add("apple-touch-icon", base + "apple-touch-icon.png" + v);
}
applyFavicon();
if (window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyFavicon);
}

// ---- Shift planner ----------------------------------------------------------





// ---- API ------------------------------------------------------------------

// ---- Tiles ----------------------------------------------------------------

// ---- Filter row -----------------------------------------------------------

// ---- The grid --------------------------------------------------------------


// ---- Details side panel ----------------------------------------------------







// ---- Day notes (local) -----------------------------------------------------

// ---- Shift editor ----------------------------------------------------------







// ---- Skill icons ------------------------------------------------------------
// A skill's badge is a Font Awesome icon, chosen from a picker that browses the
// whole bundled set rather than a hand-picked shortlist.
//
// The icon list is read from the stylesheet itself (all.min.css maps every name
// to a codepoint via a --fa custom property), so it stays correct if the Font
// Awesome build is ever upgraded -- there is no second list here to fall out of
// date with the fonts actually shipped.
//
// Which face an icon exists in is a harder question: the stylesheet maps names
// to codepoints but says nothing about whether a given codepoint is drawn by the
// solid, regular or brands font. Rendering a brands glyph as solid produces an
// empty box, so the styles are probed rather than guessed -- see probeIconStyle.
//
// Light and duotone are deliberately absent: they are Font Awesome Pro styles
// with no webfont in this bundle, so offering them would only ever yield blanks.

const FA_FAMILY_FREE = '"Font Awesome 7 Free"';
const FA_FAMILY_BRANDS = '"Font Awesome 7 Brands"';

// FA_STYLES is what the bundled Free build can actually draw, in the order the
// picker lists them.
const FA_STYLES = [
  { key: "solid", label: "Solid", font: `900 24px ${FA_FAMILY_FREE}` },
  { key: "regular", label: "Regular", font: `400 24px ${FA_FAMILY_FREE}` },
  { key: "brands", label: "Brands", font: `400 24px ${FA_FAMILY_BRANDS}` },
];

let FA_ICONS = null;      // [{name, cp, styles:[...]}] once loaded
let FA_LOADING = null;    // in-flight load, so two opens do not parse twice

// parseIconCss pulls every icon name and codepoint out of the stylesheet.
// Rules come in alias groups (".fa-try,.fa-turkish-lira{--fa:'\e2bb'}"), and
// each alias is kept: people search for the name they know, not the canonical
// one, and they all render identically.
function parseIconCss(css) {
  const out = new Map();
  const rule = /([^{}]+)\{--fa:"\\([0-9a-f]+)"\}/g;
  let m;
  while ((m = rule.exec(css)) !== null) {
    const cp = String.fromCodePoint(parseInt(m[2], 16));
    for (const sel of m[1].split(",")) {
      const name = sel.trim().match(/^\.fa-([a-z0-9-]+)$/);
      if (name) out.set(name[1], cp);
    }
  }
  return out;
}

// probeIconStyles works out which faces actually contain a glyph by measuring
// it. A codepoint the font does not define falls back to the browser's notdef,
// whose width differs from any real glyph in these fonts -- so measuring an
// unassigned private-use codepoint once gives a reliable "missing" baseline to
// compare against. It is the only way to tell solid from brands here, since the
// stylesheet does not say.
function probeIconStyles(icons) {
  const ctx = document.createElement("canvas").getContext("2d");
  const MISSING = ""; // private use, never assigned by Font Awesome
  const baseline = {};
  for (const st of FA_STYLES) {
    ctx.font = st.font;
    baseline[st.key] = ctx.measureText(MISSING).width;
  }
  for (const icon of icons) {
    icon.styles = [];
    for (const st of FA_STYLES) {
      ctx.font = st.font;
      if (ctx.measureText(icon.cp).width !== baseline[st.key]) icon.styles.push(st.key);
    }
  }
  // An icon no face can draw is not offerable. This also filters the v4
  // compatibility aliases, which map to codepoints the shipped fonts dropped.
  return icons.filter((i) => i.styles.length);
}

// loadIcons fetches and classifies the set, once per page. The fonts must be
// ready first: measuring before they load compares one fallback against
// another and classifies everything as missing.
function loadIcons() {
  if (FA_ICONS) return Promise.resolve(FA_ICONS);
  if (FA_LOADING) return FA_LOADING;
  FA_LOADING = (async () => {
    const resp = await fetch(`${PREFIX}css/all.min.css?v=${encodeURIComponent(VERSION || "")}`);
    const css = await resp.text();
    // Loading each face explicitly, rather than trusting document.fonts.ready,
    // because a face with no glyph painted yet may not have been requested.
    await Promise.all(FA_STYLES.map((st) => document.fonts.load(st.font, "").catch(() => {})));
    const parsed = [...parseIconCss(css)].map(([name, cp]) => ({ name, cp }));
    parsed.sort((a, b) => a.name.localeCompare(b.name));
    FA_ICONS = probeIconStyles(parsed);
    return FA_ICONS;
  })();
  return FA_LOADING;
}

// faClass is the class pair that renders one icon. Kept in one place so every
// render site agrees on how a stored (name, style) becomes markup.
function faClass(name, style) {
  const st = FA_STYLES.some((s) => s.key === style) ? style : "solid";
  return `fa-${st} fa-${name}`;
}


// ---- the picker -------------------------------------------------------------

let IP_PICK = null;        // {name, style} chosen in the modal, before Apply
let IP_STYLE = "";         // style filter, "" = all
let IP_SHOWN = 0;          // how many cards are drawn; the rest load on scroll
const IP_PAGE = 180;       // cards per batch: enough to fill the grid twice over

// IP_CATS is optional. Font Awesome's category metadata is a separate file from
// the CSS and is not part of this bundle, so the section only appears if one is
// dropped in at css/icon-categories.json ({"Business": ["briefcase", ...]}).
let IP_CATS = null;
let IP_CAT = "";

function ipEls() {
  return {
    modal: document.getElementById("icon-modal"),
    search: document.getElementById("ip-search"),
    styles: document.getElementById("ip-styles"),
    cats: document.getElementById("ip-cats"),
    catsHead: document.getElementById("ip-cats-head"),
    grid: document.getElementById("ip-grid"),
    count: document.getElementById("ip-count"),
    more: document.getElementById("ip-more"),
    chip: document.getElementById("ip-chip"),
    apply: document.getElementById("ip-apply"),
  };
}

// ipMatches expands the icon list into one entry per (icon, style) pair, which
// is what the grid shows: the same name in solid and regular are different
// choices and both need to be pickable.
function ipMatches() {
  const q = (ipEls().search.value || "").trim().toLowerCase();
  const out = [];
  for (const icon of FA_ICONS || []) {
    if (q && !icon.name.includes(q) && !icon.name.replace(/-/g, " ").includes(q)) continue;
    if (IP_CAT && !(IP_CATS[IP_CAT] || []).includes(icon.name)) continue;
    for (const st of icon.styles) {
      if (IP_STYLE && st !== IP_STYLE) continue;
      out.push({ name: icon.name, style: st });
    }
  }
  return out;
}

function renderIpFilters() {
  const el = ipEls();
  const all = FA_ICONS || [];
  const countFor = (key) => all.reduce((n, i) => n + (i.styles.includes(key) ? 1 : 0), 0);
  const total = all.reduce((n, i) => n + i.styles.length, 0);

  const row = (key, label, count, active) => `
    <button type="button" class="ip-filter${active ? " on" : ""}" data-k="${escapeHtml(key)}">
      <span class="ip-filter-label">${escapeHtml(label)}</span>
      <span class="ip-filter-count">${count.toLocaleString()}</span>
    </button>`;

  el.styles.innerHTML =
    row("", "All styles", total, IP_STYLE === "") +
    FA_STYLES.map((st) => row(st.key, st.label, countFor(st.key), IP_STYLE === st.key)).join("");
  el.styles.querySelectorAll(".ip-filter").forEach((b) => b.addEventListener("click", () => {
    IP_STYLE = b.dataset.k;
    renderIpFilters();
    renderIpGrid(true);
  }));

  if (!IP_CATS) { el.catsHead.hidden = true; el.cats.innerHTML = ""; return; }
  el.catsHead.hidden = false;
  const names = Object.keys(IP_CATS).sort();
  el.cats.innerHTML =
    row("", "All categories", all.length, IP_CAT === "") +
    names.map((n) => row(n, n, (IP_CATS[n] || []).length, IP_CAT === n)).join("");
  el.cats.querySelectorAll(".ip-filter").forEach((b) => b.addEventListener("click", () => {
    IP_CAT = b.dataset.k;
    renderIpFilters();
    renderIpGrid(true);
  }));
}

// renderIpGrid draws a batch at a time. Two thousand icons across three styles
// is several thousand cards; rendering them all costs a visible freeze, and
// nobody scrolls that far before searching.
function renderIpGrid(reset) {
  const el = ipEls();
  const matches = ipMatches();
  if (reset) { IP_SHOWN = 0; el.grid.scrollTop = 0; }
  IP_SHOWN = Math.min(matches.length, IP_SHOWN + IP_PAGE);
  const page = matches.slice(0, IP_SHOWN);

  el.count.textContent = `${matches.length.toLocaleString()} icons`;
  el.grid.innerHTML = page.length
    ? page.map((m) => {
        const on = IP_PICK && IP_PICK.name === m.name && IP_PICK.style === m.style;
        return `<button type="button" class="ip-card${on ? " on" : ""}" data-n="${escapeHtml(m.name)}" data-s="${escapeHtml(m.style)}">
          ${on ? `<span class="ip-card-tick"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m5 13 4 4L19 7"/></svg></span>` : ""}
          <i class="${faClass(escapeHtml(m.name), m.style)}"></i>
          <span class="ip-card-name">${escapeHtml(m.name)}</span>
          <span class="ip-card-style">${escapeHtml(m.style)}</span>
        </button>`;
      }).join("")
    : `<p class="muted um-note">No icons match your search.</p>`;

  el.more.hidden = IP_SHOWN >= matches.length;
  el.more.textContent = el.more.hidden ? "" : `Showing ${IP_SHOWN.toLocaleString()} of ${matches.length.toLocaleString()} — keep scrolling for more`;

  el.grid.querySelectorAll(".ip-card").forEach((b) => b.addEventListener("click", () => {
    IP_PICK = { name: b.dataset.n, style: b.dataset.s };
    renderIpGrid(false);
    renderIpChip();
  }));
}

function renderIpChip() {
  const el = ipEls();
  if (!IP_PICK) {
    el.chip.className = "ip-chip-empty muted";
    el.chip.textContent = "None";
    el.apply.disabled = true;
    return;
  }
  el.chip.className = "ip-chip";
  el.chip.innerHTML = `<i class="${faClass(escapeHtml(IP_PICK.name), IP_PICK.style)}"></i>
    <span>${escapeHtml(IP_PICK.name)} (${escapeHtml(IP_PICK.style)})</span>
    <button type="button" class="ip-chip-x" id="ip-chip-clear" aria-label="Clear">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>`;
  el.apply.disabled = false;
  document.getElementById("ip-chip-clear").addEventListener("click", () => { IP_PICK = null; renderIpGrid(false); renderIpChip(); });
}

// IP_TARGET is what the picker is currently editing: the same modal serves the
// skill sheet and the group editor, so the caller supplies how to read the
// starting value, how to write the result back, and which sheet to hide while
// the full-screen picker is up.
let IP_TARGET = null;

// openIconPickerFor opens the shared picker against a target:
//   { get: () => ({name, style}), set: (name, style) => {}, sheet: elId|null }
async function openIconPickerFor(target) {
  IP_TARGET = target;
  const el = ipEls();
  // Hide the sheet the picker was opened from rather than dimming it: two
  // stacked dialogs read as a mistake, and the grid wants the whole window.
  if (target.sheet) document.getElementById(target.sheet).hidden = true;
  el.modal.hidden = false;
  el.grid.innerHTML = `<p class="muted um-note">Loading icons…</p>`;

  // Start from whatever the form already holds, so reopening shows the current
  // choice rather than a blank slate.
  const cur = target.get() || {};
  IP_PICK = cur.name ? { name: cur.name, style: cur.style || "solid" } : null;
  IP_STYLE = "";
  IP_CAT = "";
  el.search.value = "";

  await loadIcons();
  if (IP_CATS === null) {
    // Absent metadata is the normal case, not an error: the section simply
    // does not appear.
    IP_CATS = await fetch(`${PREFIX}css/icon-categories.json`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  renderIpFilters();
  renderIpGrid(true);
  renderIpChip();
  el.search.focus();
}

// closeIconPicker always hands the user back to the sheet they came from, so
// cancelling never loses the half-filled form behind it.
function closeIconPicker() {
  ipEls().modal.hidden = true;
  if (IP_TARGET && IP_TARGET.sheet) document.getElementById(IP_TARGET.sheet).hidden = false;
}

// applyIconPick writes the choice back through the target and closes.
function applyIconPick() {
  if (IP_TARGET) IP_TARGET.set(IP_PICK ? IP_PICK.name : "", IP_PICK ? IP_PICK.style : "");
  closeIconPicker();
}

// iconField renders one icon-trigger button into its preview and label. Shared
// by the skill sheet and the group editor, which have identically-shaped
// controls under different id prefixes.
function iconField(prefix, name, style) {
  const preview = document.getElementById(`${prefix}-icon-preview`);
  const label = document.getElementById(`${prefix}-icon-name`);
  document.getElementById(`${prefix}-icon`).value = name || "";
  document.getElementById(`${prefix}-icon-style`).value = name ? (style || "solid") : "";
  preview.innerHTML = name ? `<i class="${faClass(escapeHtml(name), style)}"></i>` : "?";
  label.textContent = name ? `${name.replace(/-/g, " ")} (${style || "solid"})` : "Choose an icon";
  label.classList.toggle("muted", !name);
}


// iconTarget builds a picker target for a set of `<prefix>-icon*` controls that
// follow the shared shape: a hidden name, a hidden style, a preview and a label.
function iconTarget(prefix, sheet) {
  return {
    sheet,
    get: () => ({
      name: document.getElementById(`${prefix}-icon`).value,
      style: document.getElementById(`${prefix}-icon-style`).value,
    }),
    set: (name, style) => iconField(prefix, name, style),
  };
}

// wireIconField binds one icon control to the picker, and its colour well (if
// any) to the live preview tint. Called once per sheet that has one.
function wireIconField(prefix, sheet, colorId) {
  const btn = document.getElementById(`${prefix}-icon-btn`);
  if (!btn) return;
  btn.addEventListener("click", () => openIconPickerFor(iconTarget(prefix, sheet)));
  if (colorId) {
    const color = document.getElementById(colorId);
    if (color) color.addEventListener("input", () => {
      document.getElementById(`${prefix}-icon-preview`).style.setProperty("--c", color.value);
    });
  }
}

// wireIconPicker binds the shared modal chrome once, plus the skill sheet's own
// icon field. Group pages wire their field separately via wireIconField.
function wireIconPicker() {
  const el = ipEls();
  if (!el.modal) return;
  document.getElementById("ip-close").addEventListener("click", closeIconPicker);
  document.getElementById("ip-cancel").addEventListener("click", closeIconPicker);
  el.apply.addEventListener("click", applyIconPick);
  el.search.addEventListener("input", () => renderIpGrid(true));
  // Near the bottom, draw the next batch. 240px of lead time so the grid is
  // already filled by the time the reader gets there.
  el.grid.addEventListener("scroll", () => {
    if (el.grid.scrollTop + el.grid.clientHeight >= el.grid.scrollHeight - 240) renderIpGrid(false);
  });
  el.modal.addEventListener("click", (e) => { if (e.target === el.modal) closeIconPicker(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el.modal.hidden) closeIconPicker();
  });
  wireIconField("new-skill", "add-skill-modal", "new-skill-color");
}

// ---- Skills -----------------------------------------------------------------



















// ---- Skills · assignment modal ----------------------------------------------





// ---- Skills · server calls --------------------------------------------------















// ---- My Skills --------------------------------------------------------------
















// ---- picking from the catalogue ---------------------------------------------









// ---- load -------------------------------------------------------------------




// ---- Admin · Skill setup ----------------------------------------------------









// ---- create / edit modal ----------------------------------------------------














// ---- Admin · Translations ---------------------------------------------------




















// ---- Page registry ----------------------------------------------------------
// Each page ships its own script (shifts.js, skills.js, ...) which registers the
// element that identifies it and the initialiser to run. Only one page file is
// ever loaded, so at most one registration can match.
//
// This replaced a hardcoded if-chain naming every initialiser in the app. That
// chain was what kept app.js from being split: it referenced functions from
// every page, so every page had to ship all of them -- 412KB, including on the
// login screen.
const TT_PAGES = [];

// registerPage records a page's entry point. `id` is an element that appears on
// that page and nowhere else. preAuth marks the pages that render before anyone
// is signed in, so they run before the token check rather than being redirected.
function registerPage(id, init, opts = {}) {
  TT_PAGES.push({ id, init, preAuth: !!opts.preAuth });
}

function matchPage(preAuth) {
  for (const p of TT_PAGES) {
    if (p.preAuth === preAuth && document.getElementById(p.id)) return p;
  }
  return null;
}

registerPage("setup-form", initSetup, { preAuth: true });
registerPage("login-form", initLogin, { preAuth: true });
registerPage("register-form", initRegister, { preAuth: true });

document.addEventListener("DOMContentLoaded", async () => {
  // Before any page initialiser renders anything, so runtime strings and the
  // static markup agree. On the common path the server already translated the
  // HTML and this only loads the catalog for t().
  await initI18n();
  const pre = matchPage(true);
  if (pre) return pre.init();
  if (!getToken()) { location.href = PREFIX + "login"; return; }
  fillSidebar();
  const page = matchPage(false);
  if (page) return page.init();
});
