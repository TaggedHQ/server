"use strict";
// Tagged web UI client. Talks to the JSON API under <prefix>api/v2/.

const PREFIX = window.TT_PREFIX || "/";
// Build id, injected into every page. Assets are requested as ?v=<VERSION> so a
// new build never reuses the previous one's cached JS/CSS.
const VERSION = window.TT_V || "";
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
const ENTRIES_VIEW_KEY = "tagged_web_entries_view";  // "list" | "timeline"

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
function workdaySet() { return new Set(WORKDAY_PRESETS[PREFS.workdays] || WORKDAY_PRESETS["mon-fri"]); }
// Offset (0..6) of date d from the configured start of its week.
function weekStartOffset(d) { return (d.getDay() - PREFS.weekStart + 7) % 7; }

// Tag colors use the TimeTagger-compatible settings format ("taginfo #tag" ->
// {color: ...}), so they sync with the macOS Tagged app.
const TAGINFO_PREFIX = "taginfo #";
const TAG_PRESETS = ["#DEAA22", "#E5484D", "#E9913C", "#3BA55D", "#2FB79E", "#4C82F7", "#5865F2", "#A66CFF", "#EB459E", "#8A8F98"];

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
  return h + "h " + pad(m) + "m";
}
function clock(epoch) { const d = new Date(epoch * 1000); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const DOW_BY_DAY = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]; // indexed by getDay()
// Short weekday labels ordered starting from the configured week start.
function orderedDOW() { return Array.from({ length: 7 }, (_, i) => DOW_BY_DAY[(PREFS.weekStart + i) % 7]); }

function midnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function dayKey(d) { return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate(); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function dayRange(d) { const s = midnight(d).getTime() / 1000; return [s, s + 86400]; }
function weekRange(d) {
  const off = weekStartOffset(d);
  const s = midnight(addDays(d, -off)).getTime() / 1000;
  return [s, s + 7 * 86400];
}
function relDay(epoch) {
  const d = midnight(new Date(epoch * 1000));
  const today = midnight(new Date());
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return "Today";
  if (diff === -1) return "Yesterday";
  return d.getDate() + " " + MONTHS[d.getMonth()].slice(0, 3);
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
function colorFor(key) {
  if (key === OTHER_KEY) return OTHER_COLOR;
  return TAGCOLORS[key] || COLORS[key] || OTHER_COLOR;
}
function labelFor(key) {
  if (LABELS[key]) return LABELS[key];
  if (key === OTHER_KEY) return OTHER;
  const info = TAGINFO_RAW[key];
  return (info && info.title) || key;
}

function tagTotalsInRange(t1, t2) {
  const totals = {};
  for (const r of ALL) {
    if (r.t1 < t1 || r.t1 >= t2) continue;
    const k = tagKeyOf(r.ds);
    totals[k] = (totals[k] || 0) + recDur(r);
  }
  return totals;
}
function sumInRange(t1, t2) {
  let s = 0;
  for (const r of ALL) if (r.t1 >= t1 && r.t1 < t2) s += recDur(r);
  return s;
}
function countInRange(t1, t2) {
  let n = 0;
  for (const r of ALL) if (r.t1 >= t1 && r.t1 < t2) n++;
  return n;
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
    } catch (err) { showMsg(msg, "Network error", "error"); }
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

// prepCreationOptions / prepRequestOptions decode the base64url fields of the
// server's options into ArrayBuffers for navigator.credentials.
function prepCreationOptions(o) {
  o.challenge = b64urlToBuf(o.challenge);
  o.user.id = b64urlToBuf(o.user.id);
  (o.excludeCredentials || []).forEach((c) => { c.id = b64urlToBuf(c.id); });
  return o;
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
  } catch (e) { showMsg(msg, "Network error", "error"); return; }
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
  } catch (e) { showMsg(msg, "Network error", "error"); }
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
    } catch (err) { showMsg(msg, "Network error", "error"); }
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
    } catch (err) { showMsg(msg, "Network error", "error"); }
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
    } catch (err) { showMsg(msg, "Network error", "error"); }
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
};

// NAV_MODULE maps a nav entry to the optional module that must be switched on for
// it to lead anywhere. Off by default, so these stay hidden until an admin
// enables them on the Settings page.
const NAV_MODULE = {
  "nav-shifts": "shifts",
  "nav-skills": "skills",
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
    window.TT_CAPS = d.caps || [];
    window.TT_MODULES = d.modules || [];
    const can = (c) => window.TT_CAPS.includes(c);

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

    // The Admin section is hidden by default; reveal it (falling back to the
    // .nav-section stylesheet display) once we know at least one entry is
    // allowed, then drop the entries this role cannot reach.
    const na = document.getElementById("nav-admin");
    if (na) {
      let any = false;
      na.querySelectorAll("a").forEach((a) => {
        const page = a.getAttribute("href").split("/").filter(Boolean).pop();
        const cap = NAV_CAP[page];
        if (cap && !can(cap)) a.style.display = "none";
        else if (cap) any = true;
      });
      if (any) na.style.display = "";
    }
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
    : '<span class="em-none">No tags yet.</span>';
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
    (items || '<div class="em-tag-empty">No saved tags</div>') +
    '<div class="em-tag-sep"></div>' +
    '<button type="button" class="em-tag-new">＋ New Tag…</button>';

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
  const t = normalizeTag(raw);
  if (t && !timerState.tags.includes(t)) { timerState.tags.push(t); saveTimerState(); }
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

// refreshAfterTimer reloads records and re-renders the current page, so a freshly
// tracked entry shows up immediately on the dashboard or entries view.
async function refreshAfterTimer() {
  try {
    if (document.getElementById("cal-grid")) { await loadAll(); renderDashboard(); }
    else if (document.getElementById("week-days")) { await loadAll(); renderEntriesPage(); }
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
async function saveGoals(daily, weekly) {
  const mt = Math.floor(Date.now() / 1000);
  const resp = await apiFetch("settings", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify([
      { key: DAILY_GOAL_KEY, mt, value: daily },
      { key: WEEKLY_GOAL_KEY, mt, value: weekly },
    ]),
  });
  return resp.ok;
}

// savePref persists a single preference key and updates PREFS locally.
async function savePref(key, prop, value) {
  const resp = await apiFetch("settings", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ key, mt: Math.floor(Date.now() / 1000), value }]),
  });
  if (resp.ok) PREFS[prop] = value;
  return resp.ok;
}

// ---- Dashboard --------------------------------------------------------------

let selDate = midnight(new Date());
let calMonth = midnight(new Date());

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

function renderDonut(segments, totalSec) {
  document.getElementById("donut").innerHTML = donutSVG(segments, totalSec);
}

function badge(key) {
  const c = colorFor(key);
  return `<span class="badge" style="background:${c}26;color:${c}">${escapeHtml(labelFor(key))}</span>`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function renderDashboard() {
  const [ds, de] = dayRange(selDate);
  const dayRecs = ALL.filter((r) => r.t1 >= ds && r.t1 < de);
  const dayTotal = dayRecs.reduce((a, r) => a + recDur(r), 0);
  const isToday = dayKey(selDate) === dayKey(new Date());

  // Header date control
  document.getElementById("today-btn").textContent = isToday ? "Today" : (selDate.getDate() + " " + MONTHS[selDate.getMonth()].slice(0, 3));
  document.getElementById("tile-scope").textContent = isToday ? "today" : "day";

  // Tile: total + daily goal
  const dailyGoalSec = GOALS.daily * 3600;
  document.getElementById("tile-total").textContent = fmtHM(dayTotal);
  document.getElementById("tile-total-goal").textContent = "Goal " + fmtHM(dailyGoalSec);
  document.getElementById("tile-total-bar").style.width = Math.min(100, dailyGoalSec ? (dayTotal / dailyGoalSec) * 100 : 0) + "%";

  // Tile: entries + delta vs previous day
  const [ps] = dayRange(addDays(selDate, -1));
  const prevCount = countInRange(ps, ds);
  const delta = dayRecs.length - prevCount;
  document.getElementById("tile-entries").textContent = dayRecs.length;
  const deltaEl = document.getElementById("tile-entries-delta");
  deltaEl.textContent = (delta >= 0 ? "+" : "") + delta + " vs. previous day";
  deltaEl.className = "sub" + (delta > 0 ? " pos" : "");

  // Tile: longest block
  let longest = null;
  for (const r of dayRecs) if (!longest || recDur(r) > recDur(longest)) longest = r;
  document.getElementById("tile-longest").textContent = longest ? fmtHM(recDur(longest)) : "0h 00m";
  document.getElementById("tile-longest-range").textContent = longest && recDur(longest) > 0 ? clock(longest.t1) + " – " + clock(longest.t2) : "—";

  // Time allocation (donut + legend) + tags card
  const totals = tagTotalsInRange(ds, de);
  const segs = Object.keys(totals)
    .map((k) => ({ key: k, tag: labelFor(k), sec: totals[k], color: colorFor(k) }))
    .sort((a, b) => b.sec - a.sec);
  renderDonut(segs, dayTotal);
  document.getElementById("donut-total").textContent = fmtHM(dayTotal);

  const legend = document.getElementById("alloc-legend");
  const tagsList = document.getElementById("tags-list");
  if (segs.length === 0) {
    legend.innerHTML = '<div class="legend-row" style="color:var(--text-3)">No entries for this day</div>';
    tagsList.innerHTML = '<div class="tag-row" style="color:var(--text-3)">No tags</div>';
  } else {
    legend.innerHTML = segs.map((s) => {
      const pct = dayTotal ? Math.round((s.sec / dayTotal) * 100) : 0;
      return `<div class="legend-row"><span class="dot" style="background:${s.color}"></span><span class="legend-name">${escapeHtml(s.tag)}</span><span class="legend-dur">${fmtHM(s.sec)}</span><span class="legend-pct">${pct}%</span></div>`;
    }).join("");
    tagsList.innerHTML = segs.map((s) =>
      `<div class="tag-row"><span class="dot" style="background:${s.color}"></span><span class="tag-name">${escapeHtml(s.tag)}</span><span class="tag-dur">${fmtHM(s.sec)}</span></div>`
    ).join("");
  }

  // Tile: most active tag (update in place so the id/handles survive re-render)
  const top = segs[0];
  const ttEl = document.getElementById("tile-toptag");
  if (top) {
    const c = top.color;
    ttEl.textContent = top.tag;
    ttEl.style.background = c + "26";
    ttEl.style.color = c;
  } else {
    ttEl.textContent = "—";
    ttEl.style.background = "var(--accent-dim)";
    ttEl.style.color = "var(--accent)";
  }
  document.getElementById("tile-toptag-dur").textContent = top ? fmtHM(top.sec) : "0h 00m";
  document.getElementById("tile-toptag-pct").textContent = top && dayTotal ? Math.round((top.sec / dayTotal) * 100) + "%" : "0%";

  // Entries of the selected day (most recent first, up to 5)
  const dayEntries = dayRecs.slice().sort((a, b) => b.t1 - a.t1).slice(0, 5);
  document.getElementById("entries-list").innerHTML = dayEntries.length ? dayEntries.map((r) => {
    const k = tagKeyOf(r.ds);
    return `<div class="entry"><div class="e-time"><div class="t1">${clock(r.t1)}</div><div class="t2">${clock(r.t2)}</div></div><div class="e-desc">${escapeHtml(r.ds || "(no description)")}</div>${badge(k)}<div class="e-dur">${fmtHM(recDur(r))}</div></div>`;
  }).join("") : '<div class="empty">No entries for this day.</div>';

  // Goals
  const weeklyGoalSec = GOALS.weekly * 3600;
  const [ws, we] = weekRange(selDate);
  const weekTotal = sumInRange(ws, we);
  document.getElementById("goal-daily-target").textContent = fmtHM(dailyGoalSec);
  document.getElementById("goal-daily-bar").style.width = Math.min(100, dailyGoalSec ? (dayTotal / dailyGoalSec) * 100 : 0) + "%";
  document.getElementById("goal-daily-sub").textContent = fmtHM(dayTotal) + " / " + fmtHM(dailyGoalSec);
  document.getElementById("goal-weekly-target").textContent = fmtHM(weeklyGoalSec);
  document.getElementById("goal-weekly-bar").style.width = Math.min(100, weeklyGoalSec ? (weekTotal / weeklyGoalSec) * 100 : 0) + "%";
  document.getElementById("goal-weekly-sub").textContent = fmtHM(weekTotal) + " / " + fmtHM(weeklyGoalSec);

  renderCalendar();
}

function renderCalendar() {
  document.getElementById("cal-title").textContent = MONTHS[calMonth.getMonth()] + " " + calMonth.getFullYear();
  const first = new Date(calMonth.getFullYear(), calMonth.getMonth(), 1);
  const startOff = weekStartOffset(first);
  const gridStart = addDays(first, -startOff);

  // Days that have entries (by local day)
  const has = {};
  for (const r of ALL) has[dayKey(midnight(new Date(r.t1 * 1000)))] = true;

  let cells = orderedDOW().map((d) => `<div class="cal-dow">${d}</div>`).join("");
  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i);
    const out = d.getMonth() !== calMonth.getMonth();
    const isToday = dayKey(d) === dayKey(new Date());
    const isSel = dayKey(d) === dayKey(selDate);
    const cls = ["cal-day"];
    if (out) cls.push("out");
    if (isToday) cls.push("today");
    if (has[dayKey(d)]) cls.push("has");
    const selRing = isSel && !isToday ? "outline:1px solid var(--accent);outline-offset:-1px;" : "";
    cells += `<div class="${cls.join(" ")}" style="cursor:pointer;${selRing}" data-i="${i}">${d.getDate()}</div>`;
  }
  const grid = document.getElementById("cal-grid");
  grid.innerHTML = cells;
  grid.querySelectorAll(".cal-day").forEach((el) => {
    el.addEventListener("click", () => {
      selDate = midnight(addDays(gridStart, Number(el.dataset.i)));
      calMonth = new Date(selDate.getFullYear(), selDate.getMonth(), 1);
      renderDashboard();
    });
  });

  const [ds, de] = dayRange(selDate);
  document.getElementById("cal-duration").textContent = fmtHM(sumInRange(ds, de));
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
let syncTimer = null;

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

// startAutoSync begins polling for external changes. Safe to call once per page.
function startAutoSync(onChange, intervalMs = 4000) {
  if (syncTimer) clearInterval(syncTimer);
  lastSync = Date.now() / 1000;   // baseline: only care about changes from here on
  syncTimer = setInterval(() => syncUpdates(onChange), intervalMs);
  // Catch up right away when the tab regains focus (timers throttle while hidden).
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncUpdates(onChange); });
}

async function initDashboard() {
  await loadSettings();
  try { await loadAll(); } catch (e) { return; }

  document.getElementById("today-btn").addEventListener("click", () => {
    selDate = midnight(new Date());
    calMonth = new Date(selDate.getFullYear(), selDate.getMonth(), 1);
    renderDashboard();
  });
  document.getElementById("prev-day").addEventListener("click", () => {
    selDate = midnight(addDays(selDate, -1));
    calMonth = new Date(selDate.getFullYear(), selDate.getMonth(), 1);
    renderDashboard();
  });
  document.getElementById("next-day").addEventListener("click", () => {
    selDate = midnight(addDays(selDate, 1));
    calMonth = new Date(selDate.getFullYear(), selDate.getMonth(), 1);
    renderDashboard();
  });
  document.getElementById("cal-prev").addEventListener("click", () => {
    calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1);
    renderCalendar();
  });
  document.getElementById("cal-next").addEventListener("click", () => {
    calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1);
    renderCalendar();
  });

  renderDashboard();
}

// ---- Account ----------------------------------------------------------------

// initPrefsSettings wires the Entries / Region preference dropdowns. Each saves
// on change and re-renders so week-start and workday changes apply immediately.
function initPrefsSettings() {
  const msg = document.getElementById("prefs-msg");
  const bind = (id, key, prop, transform) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", async () => {
      const val = transform ? transform(el.value) : el.value;
      const ok = await savePref(key, prop, val);
      showMsg(msg, ok ? "Preferences saved" : "Failed to save", ok ? "ok" : "error");
    });
  };

  // Time zone: populate from the platform's zone list, falling back to the
  // detected zone if the list isn't available.
  const tzSel = document.getElementById("set-timezone");
  let zones = [];
  try { zones = (Intl.supportedValuesOf && Intl.supportedValuesOf("timeZone")) || []; } catch (e) { zones = []; }
  if (!zones.length) zones = [PREFS.timezone];
  if (!zones.includes(PREFS.timezone)) zones = [PREFS.timezone, ...zones];
  tzSel.innerHTML = zones.map((z) => `<option value="${escapeHtml(z)}">${escapeHtml(z)}</option>`).join("");

  document.getElementById("set-week-start").value = String(PREFS.weekStart);
  document.getElementById("set-workdays").value = PREFS.workdays;
  tzSel.value = PREFS.timezone;
  document.getElementById("set-language").value = PREFS.language;

  bind("set-week-start", WEEK_START_KEY, "weekStart", (v) => Number(v));
  bind("set-workdays", WORKDAYS_KEY, "workdays");
  bind("set-timezone", TIMEZONE_KEY, "timezone");
  bind("set-language", LANGUAGE_KEY, "language");
}

async function initAccount() {
  const user = localStorage.getItem(USER_KEY) || "";
  document.getElementById("acc-username").textContent = user;
  initOwnProfile(user);

  // Fetch account type once and share it across the security-related sections.
  // OAuth-only accounts have no password, which changes the password panel
  // (it "sets" rather than "changes") and the token reveal (no re-auth prompt).
  let hasPassword = true;
  try { hasPassword = !!(await (await apiFetch("whoami")).json()).has_password; } catch (e) { /* assume password */ }

  await loadSettings();
  document.getElementById("daily-goal").value = GOALS.daily;
  document.getElementById("weekly-goal").value = GOALS.weekly;

  const goalsMsg = document.getElementById("goals-msg");
  document.getElementById("save-goals").addEventListener("click", async () => {
    const daily = parseFloat(document.getElementById("daily-goal").value);
    const weekly = parseFloat(document.getElementById("weekly-goal").value);
    if (isNaN(daily) || isNaN(weekly) || daily <= 0 || weekly <= 0) { showMsg(goalsMsg, "Enter valid hours", "error"); return; }
    showMsg(goalsMsg, "Saving…", "");
    const ok = await saveGoals(daily, weekly);
    showMsg(goalsMsg, ok ? "Goals saved" : "Failed to save", ok ? "ok" : "error");
  });

  initPrefsSettings();

  // For OAuth-only accounts, the panel sets a first password rather than
  // changing an existing one.
  if (!hasPassword) {
    document.getElementById("pw-title").textContent = "Set a password";
    document.getElementById("pw-submit").textContent = "Set password";
    document.getElementById("pw-hint").hidden = false;
  }

  const pwMsg = document.getElementById("pw-msg");
  document.getElementById("pw-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const p1 = document.getElementById("pw1").value;
    const p2 = document.getElementById("pw2").value;
    if (p1 !== p2) { showMsg(pwMsg, "Passwords do not match", "error"); return; }
    if (p1.length < 4) { showMsg(pwMsg, "Password must be at least 4 characters", "error"); return; }
    showMsg(pwMsg, "Updating…", "");
    const resp = await apiFetch("password", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: p1 }),
    });
    if (resp.ok) {
      document.getElementById("pw1").value = "";
      document.getElementById("pw2").value = "";
      if (!hasPassword) {
        // First password on an OAuth account: reload so the two-factor and
        // passkey panels (and the relabeled token section) reflect the change.
        showMsg(pwMsg, "Password set", "ok");
        location.reload();
        return;
      }
      showMsg(pwMsg, "Password updated", "ok");
    } else {
      showMsg(pwMsg, (await resp.text()) || "Failed", "error");
    }
  });

  initTokenSection(hasPassword);
  initSecuritySections(hasPassword);
  document.getElementById("logout2").addEventListener("click", logout);
}

// initSecuritySections shows the two-factor and passkey panels only for password
// ("non-OAuth") accounts; OAuth-only accounts see a short explanatory note.
function initSecuritySections(hasPassword) {
  const mfaPanel = document.getElementById("panel-mfa");
  const pkPanel = document.getElementById("panel-passkeys");
  const note = document.getElementById("security-oauth-note");
  if (!hasPassword) {
    if (note) note.hidden = false;
    return;
  }
  if (mfaPanel) mfaPanel.hidden = false;
  if (pkPanel) pkPanel.hidden = false;
  initMfaSection();
  initPasskeys();
}

// initPasskeys wires the passkey management panel: list, add (register), remove.
function initPasskeys() {
  const listEl = document.getElementById("passkey-list");
  const msg = document.getElementById("passkey-msg");
  const addBtn = document.getElementById("passkey-add");
  if (!addBtn) return;
  if (!window.PublicKeyCredential) {
    addBtn.disabled = true;
    showMsg(msg, "This browser does not support passkeys.", "");
    return;
  }

  function fmtDate(sec) {
    if (!sec) return "";
    const d = new Date(sec * 1000);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function render(creds) {
    if (!creds.length) {
      listEl.innerHTML = '<div class="hint">No passkeys yet.</div>';
      return;
    }
    listEl.innerHTML = creds.map((c) => `
      <div class="passkey-row" data-id="${escapeHtml(c.id)}">
        <div class="passkey-meta">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M10.85 12.15 21 2"/><path d="M18 5l2 2"/><path d="M15 8l2 2"/></svg>
          <span class="passkey-label">${escapeHtml(c.label || "Passkey")}</span>
          <span class="passkey-added">Added ${escapeHtml(fmtDate(c.added))}</span>
        </div>
        <button class="danger-btn btn-sm passkey-remove" type="button">Remove</button>
      </div>`).join("");
    listEl.querySelectorAll(".passkey-remove").forEach((b) => {
      b.addEventListener("click", () => remove(b.closest(".passkey-row").dataset.id));
    });
  }

  async function load() {
    try {
      const r = await apiFetch("webauthn/credentials");
      if (!r.ok) { showMsg(msg, "Could not load passkeys", "error"); return; }
      render((await r.json()).credentials || []);
    } catch (e) { showMsg(msg, "Could not load passkeys", "error"); }
  }

  async function add() {
    const label = (prompt("Name this passkey (e.g. “MacBook Touch ID”):", "Passkey") || "").trim();
    if (label === "") return; // cancelled
    showMsg(msg, "Follow your device's prompt…", "");
    let options;
    try {
      const r = await apiFetch("webauthn/register/begin", { method: "POST" });
      if (!r.ok) { showMsg(msg, (await r.text()) || "Could not start registration", "error"); return; }
      options = prepCreationOptions((await r.json()).publicKey);
    } catch (e) { showMsg(msg, "Network error", "error"); return; }
    let cred;
    try { cred = await navigator.credentials.create({ publicKey: options }); }
    catch (e) { showMsg(msg, "Passkey setup was cancelled", "error"); return; }
    try {
      const r = await apiFetch("webauthn/register/finish", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: credToJSON(cred), label }),
      });
      if (!r.ok) { showMsg(msg, (await r.text()) || "Could not save passkey", "error"); return; }
      render((await r.json()).credentials || []);
      showMsg(msg, "Passkey added", "ok");
    } catch (e) { showMsg(msg, "Network error", "error"); }
  }

  async function remove(id) {
    if (!confirm("Remove this passkey? It can no longer be used to sign in.")) return;
    try {
      const r = await apiFetch("webauthn/credentials", {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
      });
      if (!r.ok) { showMsg(msg, (await r.text()) || "Could not remove passkey", "error"); return; }
      render((await r.json()).credentials || []);
      showMsg(msg, "Passkey removed", "ok");
    } catch (e) { showMsg(msg, "Network error", "error"); }
  }

  addBtn.addEventListener("click", add);
  load();
}

// initMfaSection wires the two-factor (TOTP) panel: enable via QR + code, show
// one-time backup codes, and disable (which requires a current code).
function initMfaSection() {
  const statusEl = document.getElementById("mfa-status");
  const setupEl = document.getElementById("mfa-setup");
  const backupEl = document.getElementById("mfa-backup");
  const msg = document.getElementById("mfa-msg");
  const state = { enabled: false, remaining: 0 };

  async function refresh() {
    try {
      const d = await (await apiFetch("whoami")).json();
      state.enabled = !!d.totp_enabled;
      state.remaining = d.backup_codes_remaining || 0;
    } catch (e) { /* leave defaults */ }
    renderStatus();
  }

  function renderStatus() {
    setupEl.hidden = true;
    backupEl.hidden = true;
    if (state.enabled) {
      statusEl.innerHTML = `<div class="mfa-row">
          <span class="mfa-badge on">Enabled</span>
          <span class="mfa-note">${state.remaining} backup code${state.remaining === 1 ? "" : "s"} remaining</span>
          <button class="danger-btn btn-sm" id="mfa-disable-btn" type="button">Disable</button>
        </div>
        <div id="mfa-disable-wrap" hidden>
          <div class="token-pw-row" style="margin-top:12px">
            <input id="mfa-disable-code" type="text" inputmode="numeric" placeholder="Current or backup code">
            <button class="danger-btn btn-sm" id="mfa-disable-do" type="button">Confirm disable</button>
            <button class="secondary btn-sm" id="mfa-disable-cancel" type="button">Cancel</button>
          </div>
        </div>`;
      document.getElementById("mfa-disable-btn").addEventListener("click", () => {
        document.getElementById("mfa-disable-wrap").hidden = false;
        document.getElementById("mfa-disable-code").focus();
      });
      document.getElementById("mfa-disable-cancel").addEventListener("click", () => {
        document.getElementById("mfa-disable-wrap").hidden = true;
        showMsg(msg, "", "");
      });
      document.getElementById("mfa-disable-do").addEventListener("click", disable);
    } else {
      statusEl.innerHTML = `<div class="mfa-row">
          <span class="mfa-badge off">Not enabled</span>
          <button class="btn-sm" id="mfa-enable-btn" type="button">Enable</button>
        </div>`;
      document.getElementById("mfa-enable-btn").addEventListener("click", startSetup);
    }
  }

  async function startSetup() {
    showMsg(msg, "Preparing…", "");
    const r = await apiFetch("totp/setup", { method: "POST" });
    if (!r.ok) { showMsg(msg, (await r.text()) || "Failed to start setup", "error"); return; }
    const d = await r.json();
    document.getElementById("mfa-qr").src = d.qr;
    document.getElementById("mfa-secret").textContent = (d.secret || "").replace(/(.{4})/g, "$1 ").trim();
    document.getElementById("mfa-code-in").value = "";
    statusEl.innerHTML = "";
    setupEl.hidden = false;
    showMsg(msg, "", "");
    document.getElementById("mfa-code-in").focus();
  }

  async function confirmEnable() {
    const code = document.getElementById("mfa-code-in").value.trim();
    if (!code) { showMsg(msg, "Enter the 6-digit code", "error"); return; }
    showMsg(msg, "Verifying…", "");
    const r = await apiFetch("totp/enable", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
    });
    if (!r.ok) { showMsg(msg, (await r.text()) || "Invalid code", "error"); return; }
    const d = await r.json();
    setupEl.hidden = true;
    showBackup(d.backup_codes || []);
    showMsg(msg, "", "");
  }

  function showBackup(codes) {
    document.getElementById("mfa-backup-codes").innerHTML = codes.map((c) => `<code>${escapeHtml(c)}</code>`).join("");
    backupEl.hidden = false;
    document.getElementById("mfa-backup-copy").onclick = async () => {
      try { await navigator.clipboard.writeText(codes.join("\n")); showMsg(msg, "Backup codes copied", "ok"); }
      catch (e) { showMsg(msg, "Copy failed", "error"); }
    };
    document.getElementById("mfa-backup-done").onclick = () => { showMsg(msg, "", ""); refresh(); };
  }

  async function disable() {
    const code = document.getElementById("mfa-disable-code").value.trim();
    if (!code) { showMsg(msg, "Enter a code to confirm", "error"); return; }
    showMsg(msg, "Disabling…", "");
    const r = await apiFetch("totp/disable", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }),
    });
    if (!r.ok) { showMsg(msg, (await r.text()) || "Failed to disable", "error"); return; }
    await refresh();
    showMsg(msg, "Two-factor authentication disabled", "ok");
  }

  document.getElementById("mfa-confirm").addEventListener("click", confirmEnable);
  document.getElementById("mfa-cancel").addEventListener("click", () => { setupEl.hidden = true; showMsg(msg, "", ""); refresh(); });
  document.getElementById("mfa-code-in").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); confirmEnable(); } });

  refresh();
}

// verifyPassword confirms the given password for the signed-in user by
// re-running the username/password login. Returns true on success.
async function verifyPassword(password) {
  const username = localStorage.getItem(USER_KEY) || "";
  if (!username || !password) return false;
  try {
    const payload = btoa(JSON.stringify({ method: "usernamepassword", username, password }));
    const resp = await fetch(API + "bootstrap_authentication", { method: "POST", body: payload });
    return resp.ok;
  } catch (e) { return false; }
}

// fetchApiToken returns the current (or freshly reset) API token, or null.
async function fetchApiToken(reset) {
  const resp = await apiFetch("apitoken" + (reset ? "?reset=1" : ""));
  if (!resp.ok) return null;
  return (await resp.json()).token || null;
}

// initTokenSection wires the API-token field. For password accounts the value
// stays masked until the user re-enters their password; OAuth-only accounts
// have no password to verify, so the web session alone gates the reveal.
function initTokenSection(hasPassword) {
  const input = document.getElementById("token-input");
  const showBtn = document.getElementById("token-show");
  const copyBtn = document.getElementById("token-copy");
  const pwWrap = document.getElementById("token-pw");
  const pwInput = document.getElementById("token-pw-input");
  const msg = document.getElementById("token-msg");
  let token = null; // cached once revealed this session

  function mask() {
    input.type = "password";
    showBtn.textContent = "Show";
    copyBtn.hidden = !token;
  }
  function reveal() {
    input.type = "text";
    showBtn.textContent = "Hide";
    copyBtn.hidden = false;
  }
  function closePrompt() { pwWrap.hidden = true; pwInput.value = ""; }

  // OAuth accounts can't re-enter a password, so reveal straight from the token
  // endpoint (already authorized by the web session).
  async function revealWithoutPassword() {
    showMsg(msg, "Loading…", "");
    const t = await fetchApiToken(false);
    if (!t) { showMsg(msg, "Could not load token", "error"); return; }
    token = t;
    input.value = token;
    reveal();
    showMsg(msg, "", "");
  }

  showBtn.addEventListener("click", () => {
    // Already revealed this session: toggle freely without re-asking.
    if (token) { input.type === "password" ? reveal() : mask(); return; }
    if (!hasPassword) { revealWithoutPassword(); return; }
    if (pwWrap.hidden) { pwWrap.hidden = false; pwInput.focus(); }
    else closePrompt();
  });

  async function doReveal() {
    const pw = pwInput.value;
    if (!pw) { showMsg(msg, "Enter your password", "error"); return; }
    showMsg(msg, "Verifying…", "");
    if (!(await verifyPassword(pw))) { showMsg(msg, "Incorrect password", "error"); return; }
    const t = await fetchApiToken(false);
    if (!t) { showMsg(msg, "Could not load token", "error"); return; }
    token = t;
    input.value = token;
    closePrompt();
    reveal();
    showMsg(msg, "", "");
  }
  document.getElementById("token-pw-verify").addEventListener("click", doReveal);
  pwInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doReveal(); } });
  document.getElementById("token-pw-cancel").addEventListener("click", () => { closePrompt(); showMsg(msg, "", ""); });

  copyBtn.addEventListener("click", async () => {
    if (!token) return;
    try { await navigator.clipboard.writeText(token); showMsg(msg, "Token copied", "ok"); }
    catch (e) { showMsg(msg, "Copy failed", "error"); }
  });

  document.getElementById("regen-token").addEventListener("click", async () => {
    if (!confirm("Regenerate the API token? The previous token will stop working immediately.")) return;
    showMsg(msg, "Regenerating…", "");
    const t = await fetchApiToken(true);
    if (!t) { showMsg(msg, "Failed to regenerate", "error"); return; }
    token = t;
    input.value = token;
    reveal();
    showMsg(msg, "New token generated", "ok");
  });
}

// ---- Time entries page ------------------------------------------------------

const WEEKDAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function fmtColon(sec) { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 3600) + ":" + pad(Math.floor((sec % 3600) / 60)); }
function weekStartOf(d) { return midnight(addDays(d, -weekStartOffset(d))); }
function weekTitle(start) {
  const end = addDays(start, 6);
  const mS = MONTHS[start.getMonth()].slice(0, 3);
  const mE = MONTHS[end.getMonth()].slice(0, 3);
  if (start.getMonth() === end.getMonth()) return `${mS} ${start.getDate()} – ${end.getDate()}, ${end.getFullYear()}`;
  return `${mS} ${start.getDate()} – ${mE} ${end.getDate()}, ${end.getFullYear()}`;
}

async function putRecord(obj) {
  const resp = await apiFetch("records", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify([obj]),
  });
  return resp.ok;
}

function entryCard(r) {
  const descText = (r.ds || "").replace(RE_TAG_G, "").trim();
  const tags = allTagsOf(r.ds);
  const dotColor = tags.length ? colorFor(tags[0].slice(1).toLowerCase()) : "var(--accent)";
  const tagBadges = tags.map((t) => badge(t.slice(1).toLowerCase())).join("");
  return `<div class="te-card" data-key="${escapeHtml(r.key)}">
    <span class="te-dot" style="background:${dotColor}"></span>
    <div class="te-time"><div class="t1">${clock(r.t1)}</div><div class="t2">${clock(r.t2)}</div></div>
    <div class="te-body"><div class="te-desc ${descText ? "" : "none"}">${descText ? escapeHtml(descText) : "No description"}</div>${tagBadges ? `<div class="te-tags">${tagBadges}</div>` : ""}</div>
    <div class="te-dur">${fmtHM(recDur(r))}</div>
    <div class="te-menu"><button class="te-menu-btn" aria-label="Menu">⋯</button><div class="menu-pop"><button class="edit">Edit</button><button class="danger-btn">Delete</button></div></div>
  </div>`;
}

// ---- Timeline state ---------------------------------------------------------
// The timeline maps a continuous time window [tlStart, tlStart+tlDur) onto the
// height of the canvas, so panning/zooming is just arithmetic on these two.
let tlStart = 0;             // window start, epoch seconds
let tlDur = 24 * 3600;       // window length, seconds
const TL_MIN_DUR = 2 * 3600;        // most zoomed-in: 2 hours
const TL_MAX_DUR = 60 * 86400;      // most zoomed-out: 60 days
const TL_GUTTER = 58;               // px reserved on the left for time labels
// Candidate spacings between gridlines (seconds), smallest first.
const TL_STEPS = [900, 1800, 3600, 2 * 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 7 * 86400];

function tlClampDur(d) { return Math.max(TL_MIN_DUR, Math.min(TL_MAX_DUR, d)); }

// "Today" resets both the timeline window and the selected day to now.
function tlSetToday() {
  tlDur = 24 * 3600;
  selDate = midnight(new Date());
  tlStart = selDate.getTime() / 1000;
  renderEntriesPage();
}
// Shift the window by a fraction of its length. Positive = later (down/forward).
function tlPan(frac) { tlStart += frac * tlDur; renderTimeline(); }
// Scale the window around its center. factor<1 zooms in, factor>1 zooms out.
function tlZoom(factor) {
  const center = tlStart + tlDur / 2;
  tlDur = tlClampDur(tlDur * factor);
  tlStart = center - tlDur / 2;
  renderTimeline();
}

// tlRangeTitle describes the visible span (a single day, or a date range).
function tlRangeTitle(s, e) {
  const a = new Date(s * 1000), b = new Date((e - 1) * 1000);
  const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay) return `${WEEKDAY_FULL[a.getDay()]}, ${MONTHS[a.getMonth()].slice(0, 3)} ${a.getDate()}`;
  const mA = MONTHS[a.getMonth()].slice(0, 3), mB = MONTHS[b.getMonth()].slice(0, 3);
  if (a.getFullYear() === b.getFullYear()) return `${mA} ${a.getDate()} – ${mB} ${b.getDate()}, ${b.getFullYear()}`;
  return `${mA} ${a.getDate()}, ${a.getFullYear()} – ${mB} ${b.getDate()}, ${b.getFullYear()}`;
}

// tlFloorToStep rounds an epoch down to the previous gridline boundary, aligned
// to local midnight so ticks land on clean local times regardless of timezone.
function tlFloorToStep(epoch, step) {
  const d = new Date(epoch * 1000);
  d.setHours(0, 0, 0, 0);
  const mid = d.getTime() / 1000;
  if (step >= 86400) return mid;
  return mid + Math.floor((epoch - mid) / step) * step;
}

// tlLanes packs overlapping records into side-by-side columns. Records are laid
// out in clusters of mutual overlap; each gets {lane, cols} within its cluster.
function tlLanes(recs) {
  const res = {};
  for (let i = 0; i < recs.length;) {
    let end = recs[i].t2;
    const cluster = [recs[i]];
    let j = i + 1;
    for (; j < recs.length && recs[j].t1 < end; j++) { end = Math.max(end, recs[j].t2); cluster.push(recs[j]); }
    const laneEnds = [];
    for (const r of cluster) {
      let lane = laneEnds.findIndex((le) => le <= r.t1);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
      laneEnds[lane] = r.t2;
      res[r.key] = { lane };
    }
    for (const r of cluster) res[r.key].cols = laneEnds.length;
    i = j;
  }
  return res;
}

function closeAllMenus() { document.querySelectorAll(".menu-pop.open").forEach((p) => p.classList.remove("open")); }

// renderTimeline draws the timeline for the current [tlStart, tlStart+tlDur)
// window: hour/day gridlines, a "now" marker, and every record as a positioned
// block. It is re-run on every pan, zoom, edit, and resize.
function renderTimeline() {
  const wrap = document.getElementById("tl-wrap");
  const canvas = document.getElementById("tl-canvas");
  if (!wrap || !canvas) return;

  tlDur = tlClampDur(tlDur);
  const H = Math.max(240, wrap.clientHeight || 480);
  const tlEnd = tlStart + tlDur;
  const pxPerSec = H / tlDur;
  canvas.style.height = H + "px";
  document.getElementById("tl-range").textContent = tlRangeTitle(tlStart, tlEnd);

  // Gridlines: pick the smallest tick spacing that stays at least ~44px apart.
  let step = TL_STEPS[TL_STEPS.length - 1];
  for (const s of TL_STEPS) { if (s * pxPerSec >= 44) { step = s; break; } }
  let grid = "";
  for (let t = tlFloorToStep(tlStart, step); t <= tlEnd; t += step) {
    if (t < tlStart) continue;
    const y = (t - tlStart) * pxPerSec;
    const d = new Date(t * 1000);
    const isDay = d.getHours() === 0 && d.getMinutes() === 0;
    let label;
    if (step >= 86400) label = `${DOW_BY_DAY[d.getDay()]} ${d.getDate()}`;
    else if (isDay) label = `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
    else label = pad(d.getHours()) + ":" + pad(d.getMinutes());
    grid += `<div class="tl-grid${isDay || step >= 86400 ? " day" : ""}" style="top:${y}px"><span class="tl-grid-label">${label}</span></div>`;
  }

  const nowSec = Date.now() / 1000;
  if (nowSec >= tlStart && nowSec <= tlEnd) {
    grid += `<div class="tl-now" style="top:${(nowSec - tlStart) * pxPerSec}px"></div>`;
  }

  // Blocks: every record overlapping the window, packed into overlap columns.
  const vis = ALL.filter((r) => r.t2 > tlStart && r.t1 < tlEnd && r.t2 > r.t1).sort((a, b) => a.t1 - b.t1);
  const lanes = tlLanes(vis);
  let visibleTotal = 0;
  let blocks = "";
  for (const r of vis) {
    visibleTotal += Math.min(r.t2, tlEnd) - Math.max(r.t1, tlStart);
    const top = (r.t1 - tlStart) * pxPerSec;
    const height = Math.max(2, recDur(r) * pxPerSec);
    const { lane, cols } = lanes[r.key];
    const w = 100 / cols;
    const tags = allTagsOf(r.ds);
    const color = tags.length ? colorFor(tags[0].slice(1).toLowerCase()) : "var(--accent)";
    const descText = (r.ds || "").replace(RE_TAG_G, "").trim();
    const label = descText || "No description";
    blocks += `<div class="tl-block${height < 30 ? " sm" : ""}${descText ? "" : " none"}" data-key="${escapeHtml(r.key)}"
        title="${escapeHtml(clock(r.t1) + "–" + clock(r.t2) + "  " + label)}"
        style="top:${top}px;height:${height}px;left:${lane * w}%;width:${w}%;--tl-c:${color}">
      <div class="tl-block-body"><span class="tl-block-dur">${fmtHM(recDur(r))}</span><span class="tl-block-desc">${escapeHtml(label)}</span></div>
    </div>`;
  }
  const empty = vis.length ? "" : '<div class="tl-empty">No entries in this range.</div>';

  canvas.innerHTML = grid + empty + `<div class="tl-lanes">${blocks}</div>`;
  document.getElementById("tl-visible-total").textContent = fmtHM(visibleTotal);

  canvas.querySelectorAll(".tl-block").forEach((el) => el.addEventListener("click", (e) => {
    e.stopPropagation();
    const r = ALL.find((x) => x.key === el.dataset.key);
    if (r) openEntryModal(r);
  }));
}

// renderEntriesPage redraws the whole page: the week strip, the day list for
// the selected day, and the timeline. Called after any data change.
function renderEntriesPage() {
  const wStart = weekStartOf(selDate);
  document.getElementById("week-title").textContent = weekTitle(wStart);

  let weekTotal = 0;
  const cells = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(wStart, i);
    const [s, e] = dayRange(d);
    const tot = sumInRange(s, e);
    weekTotal += tot;
    const has = ALL.some((r) => r.t1 >= s && r.t1 < e);
    const sel = dayKey(d) === dayKey(selDate);
    const off = !workdaySet().has(d.getDay());
    cells.push(`<div class="wday ${sel ? "sel" : ""} ${has ? "has" : ""} ${off ? "offday" : ""}" data-i="${i}"><div class="dow">${DOW_BY_DAY[d.getDay()]}</div><div class="dnum">${d.getDate()}</div><div class="dtot">${sel ? fmtHM(tot) : fmtColon(tot)}</div><div class="wdot"></div></div>`);
  }
  const daysEl = document.getElementById("week-days");
  daysEl.innerHTML = cells.join("");
  daysEl.querySelectorAll(".wday").forEach((el) => el.addEventListener("click", () => {
    selDate = midnight(addDays(wStart, Number(el.dataset.i)));
    tlStart = selDate.getTime() / 1000;  // scroll the timeline to the picked day
    renderEntriesPage();
  }));
  document.getElementById("week-total").textContent = fmtHM(weekTotal);

  document.getElementById("day-title").textContent = `${WEEKDAY_FULL[selDate.getDay()]}, ${MONTHS[selDate.getMonth()].slice(0, 3)} ${selDate.getDate()}`;
  const [ds, de] = dayRange(selDate);
  const dayRecs = ALL.filter((r) => r.t1 >= ds && r.t1 < de).sort((a, b) => a.t1 - b.t1);
  document.getElementById("day-total").textContent = fmtHM(dayRecs.reduce((a, r) => a + recDur(r), 0));

  const list = document.getElementById("te-list");
  list.innerHTML = dayRecs.length ? dayRecs.map(entryCard).join("") : '<div class="empty">No entries for this day.</div>';

  list.querySelectorAll(".te-menu-btn").forEach((btn) => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const pop = btn.nextElementSibling;
    const wasOpen = pop.classList.contains("open");
    closeAllMenus();
    if (!wasOpen) pop.classList.add("open");
  }));
  list.querySelectorAll(".menu-pop .delete").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    closeAllMenus();
    const key = b.closest(".te-card").dataset.key;
    const r = ALL.find((x) => x.key === key);
    if (!r) return;
    await putRecord({ key: r.key, mt: Math.floor(Date.now() / 1000), t1: r.t1, t2: r.t2, ds: "HIDDEN " + (r.ds || "") });
    await loadAll();
    renderEntriesPage();
  }));
  list.querySelectorAll(".menu-pop .edit").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllMenus();
    const r = ALL.find((x) => x.key === b.closest(".te-card").dataset.key);
    if (r) openEntryModal(r);
  }));
  // Clicking a card (outside its menu) opens the editor too.
  list.querySelectorAll(".te-card").forEach((card) => card.addEventListener("click", (e) => {
    if (e.target.closest(".te-menu")) return;
    const r = ALL.find((x) => x.key === card.dataset.key);
    if (r) openEntryModal(r);
  }));

  renderTimeline();
}

// ---- Entry editor modal -----------------------------------------------------

let emKey = null;   // key of the record being edited, or null for a new entry
let emTags = [];    // tag keys currently on the entry
let emAdding = false;

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

function emError(text) { document.getElementById("em-msg").textContent = text || ""; }

function renderEmTags() {
  const host = document.getElementById("em-tags");
  host.innerHTML = emTags.length
    ? emTags.map((t) => {
        const c = colorFor(t);
        return `<span class="em-tag-chip" style="background:${c}26;color:${c}">${escapeHtml(labelFor(t) || ("#" + t))}<button class="x" data-t="${escapeHtml(t)}" type="button" aria-label="Remove">×</button></span>`;
      }).join("")
    : '<span class="em-none">No tags yet.</span>';
  host.querySelectorAll(".x").forEach((b) => b.addEventListener("click", () => {
    emTags = emTags.filter((x) => x !== b.dataset.t);
    renderEmTags();
  }));
}

// renderEmTagMenu fills the "＋ Add" dropdown with the saved tags not already on
// the entry, followed by a "New Tag…" action.
function renderEmTagMenu() {
  const menu = document.getElementById("em-tag-menu");
  const avail = allTagKeys().filter((t) => !emTags.includes(t));
  const items = avail.map((t) => {
    const c = colorFor(t);
    return `<button type="button" class="em-tag-opt" data-t="${escapeHtml(t)}"><span class="dot" style="background:${c}"></span>${escapeHtml(labelFor(t) || ("#" + t))}</button>`;
  }).join("");
  menu.innerHTML =
    (items || '<div class="em-tag-empty">No saved tags</div>') +
    '<div class="em-tag-sep"></div>' +
    '<button type="button" class="em-tag-new">＋ New Tag…</button>';

  menu.querySelectorAll(".em-tag-opt").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    addEmTag(b.dataset.t);
    closeAllMenus();
  }));
  menu.querySelector(".em-tag-new").addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllMenus();
    emAdding = true;
    const wrap = document.getElementById("em-add-wrap");
    wrap.hidden = false;
    const inp = document.getElementById("em-tag-input");
    inp.value = "";
    inp.focus();
  });
}

function addEmTag(raw) {
  const t = normalizeTag(raw);
  if (t && !emTags.includes(t)) emTags.push(t);
  const wrap = document.getElementById("em-add-wrap");
  const inp = document.getElementById("em-tag-input");
  inp.value = "";
  wrap.hidden = true;
  emAdding = false;
  renderEmTags();
}

function openEntryModal(rec, preset) {
  emKey = rec ? rec.key : null;
  emAdding = false;
  document.getElementById("em-add-wrap").hidden = true;
  closeAllMenus();
  emError("");
  document.getElementById("em-title").textContent = rec ? "Edit Entry" : "New Entry";
  const ds = rec ? (rec.ds || "") : "";
  document.getElementById("em-desc").value = ds.replace(RE_TAG_G, "").trim();
  emTags = rec ? [...new Set(allTagsOf(ds).map((t) => t.slice(1).toLowerCase()))] : [];

  let t1, t2;
  if (rec) { t1 = rec.t1; t2 = rec.t2; }
  else if (preset) { t1 = preset.t1; t2 = preset.t2 || t1 + 1800; }
  else {
    const base = new Date(selDate);
    const now = new Date();
    if (dayKey(selDate) === dayKey(now)) base.setHours(now.getHours(), now.getMinutes(), 0, 0);
    else base.setHours(12, 0, 0, 0);
    t1 = Math.floor(base.getTime() / 1000);
    t2 = t1 + 1800;
  }
  document.getElementById("em-start-date").value = dateInputVal(t1);
  document.getElementById("em-start-time").value = timeInputVal(t1);
  document.getElementById("em-end-date").value = dateInputVal(t2);
  document.getElementById("em-end-time").value = timeInputVal(t2);
  document.getElementById("em-delete").hidden = !rec;

  renderEmTags();
  document.getElementById("entry-modal").hidden = false;
}

function closeEntryModal() { document.getElementById("entry-modal").hidden = true; }

async function saveEntryModal() {
  const descText = document.getElementById("em-desc").value.trim();
  const t1 = combineDT(document.getElementById("em-start-date").value, document.getElementById("em-start-time").value);
  const t2 = combineDT(document.getElementById("em-end-date").value, document.getElementById("em-end-time").value);
  if (isNaN(t1) || isNaN(t2)) { emError("Enter a valid start and end time."); return; }
  if (t2 < t1) { emError("End must be after start."); return; }
  let ds = descText;
  if (emTags.length) ds = (descText + " " + emTags.map((t) => "#" + t).join(" ")).trim();
  const key = emKey || randomKey();
  const ok = await putRecord({ key, mt: Math.floor(Date.now() / 1000), t1, t2, ds });
  if (!ok) { emError("Failed to save."); return; }
  closeEntryModal();
  await loadAll();
  renderEntriesPage();
}

async function deleteEntryModal() {
  if (!emKey) return;
  if (!confirm("Delete this entry? This cannot be undone.")) return;
  const r = ALL.find((x) => x.key === emKey);
  if (r) await putRecord({ key: r.key, mt: Math.floor(Date.now() / 1000), t1: r.t1, t2: r.t2, ds: "HIDDEN " + (r.ds || "") });
  closeEntryModal();
  await loadAll();
  renderEntriesPage();
}

function wireEntryModal() {
  document.getElementById("em-cancel").addEventListener("click", closeEntryModal);
  document.getElementById("em-save").addEventListener("click", saveEntryModal);
  document.getElementById("em-delete").addEventListener("click", deleteEntryModal);
  document.getElementById("em-add-tag").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = document.getElementById("em-tag-menu");
    const wasOpen = menu.classList.contains("open");
    closeAllMenus();
    if (!wasOpen) { renderEmTagMenu(); menu.classList.add("open"); }
  });
  document.getElementById("em-tag-add-btn").addEventListener("click", () => addEmTag(document.getElementById("em-tag-input").value));
  document.getElementById("em-tag-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addEmTag(e.target.value); }
  });
  // Close when clicking the dimmed backdrop.
  document.getElementById("entry-modal").addEventListener("click", (e) => {
    if (e.target.id === "entry-modal") closeEntryModal();
  });
}

// ---- Report -----------------------------------------------------------------
// Builds a grouped time report over an arbitrary date range and exports it as a
// downloadable CSV or a print-to-PDF view. The PDF path sets the print window's
// title so the browser's "Save as PDF" dialog pre-fills the chosen filename.

function repDurFns(fmt) {
  if (fmt === "h0") return { round: (t) => Math.round(t / 3600) * 3600, str: (t) => (t / 3600).toFixed(0) };
  if (fmt === "h1") return { round: (t) => Math.round(t / 360) * 360, str: (t) => (t / 3600).toFixed(1) };
  if (fmt === "h2") return { round: (t) => Math.round(t / 36) * 36, str: (t) => (t / 3600).toFixed(2) };
  if (fmt === "h3") return { round: (t) => Math.round(t / 3.6) * 3.6, str: (t) => (t / 3600).toFixed(3) };
  if (fmt === "hms") return { round: (t) => Math.round(t), str: (t) => durColon(t, true) };
  return { round: (t) => Math.round(t / 60) * 60, str: (t) => durColon(t, false) };
}
function durColon(t, withSec) {
  t = Math.max(0, Math.round(t));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return withSec ? `${h}:${pad(m)}:${pad(s)}` : `${h}:${pad(m)}`;
}
function isoWeek(epoch) {
  const d = new Date(epoch * 1000);
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return { year: date.getUTCFullYear(), week };
}
function repDateSort(epoch) { const d = new Date(epoch * 1000); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; }
function repDate(epoch) { const d = new Date(epoch * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function repPeriodLabel(epoch, period) {
  const d = new Date(epoch * 1000), y = d.getFullYear();
  if (period === "week") { const w = isoWeek(epoch); return `${w.year}W${pad(w.week)}`; }
  if (period === "month") return `${MONTHS[d.getMonth()].slice(0, 3)} ${y}`;
  if (period === "quarter") return `${y}Q${Math.floor(d.getMonth() / 3) + 1}`;
  if (period === "year") return `${y}`;
  return `${y}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // day
}

const HIDDEN_GRP = " hidden";

function reportRange() {
  const f = document.getElementById("rp-from").value;
  const tt = document.getElementById("rp-to").value;
  if (!f || !tt) return [0, 0];
  const [y1, m1, d1] = f.split("-").map(Number);
  const [y2, m2, d2] = tt.split("-").map(Number);
  const t1 = Math.floor(new Date(y1, m1 - 1, d1, 0, 0, 0).getTime() / 1000);
  const t2 = Math.floor(new Date(y2, m2 - 1, d2, 0, 0, 0).getTime() / 1000) + 86400; // range end is inclusive
  return [t1, t2];
}

// reportRows returns an array of tagged rows: ["total", dur] | ["blank"] |
// ["head", dur, title] | ["record", key, dur, date, start, stop, ds, tags].
function reportRows(t1, t2) {
  const fmt = repDurFns(document.getElementById("rp-format").value);
  const groupMethod = document.getElementById("rp-grouping").value;
  const groupPeriod = document.getElementById("rp-period").value;
  const showRecords = document.getElementById("rp-records").checked;

  const recs = ALL.filter((r) => r.t1 < t2 && r.t2 > t1).sort((a, b) => a.t1 - b.t1).map((r) => {
    const tags = allTagsOf(r.ds);
    return {
      key: r.key, t1: r.t1, t2: r.t2,
      ds: (r.ds || "").replace(RE_TAG_G, "").trim(),
      tagz: tags.map((x) => x.slice(1).toLowerCase()).sort().join(" "),
      tagsDisp: tags.join(" "),
      dur: fmt.round(Math.max(0, Math.min(t2, r.t2) - Math.max(t1, r.t1))),
    };
  });

  // Primary grouping.
  let groups;
  if (groupMethod === "tags") {
    const m = {};
    for (const r of recs) {
      if (!(r.tagz in m)) m[r.tagz] = { title: r.tagsDisp || "General", duration: 0, records: [] };
      m[r.tagz].records.push(r); m[r.tagz].duration += r.dur;
    }
    groups = Object.values(m).sort((a, b) => b.duration - a.duration);
  } else if (groupMethod === "ds") {
    const m = {};
    for (const r of recs) {
      const key = r.ds || " ";
      if (!(key in m)) m[key] = { title: r.ds || "(no description)", duration: 0, records: [] };
      m[key].records.push(r); m[key].duration += r.dur;
    }
    groups = Object.values(m).sort((a, b) => (a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1));
  } else {
    const g = { title: HIDDEN_GRP, duration: 0, records: [] };
    for (const r of recs) { g.records.push(r); g.duration += r.dur; }
    groups = [g];
  }

  // Secondary grouping by period.
  if (groupPeriod !== "none") {
    const m = {};
    groups.forEach((g, gi) => {
      for (const r of g.records) {
        const period = repPeriodLabel(r.t1, groupPeriod);
        const hidden = g.title === HIDDEN_GRP;
        const title = hidden ? period : `${period} / ${g.title}`;
        const sortkey = repDateSort(r.t1) + (hidden ? "" : String(1000000 + gi));
        if (!(title in m)) m[title] = { title, duration: 0, records: [], sortkey };
        m[title].records.push(r); m[title].duration += r.dur;
      }
    });
    groups = Object.values(m).sort((a, b) => (a.sortkey < b.sortkey ? -1 : 1));
  }

  const rows = [];
  let total = 0;
  for (const g of groups) total += g.duration;
  rows.push(["total", fmt.str(total)]);
  for (const g of groups) {
    if (showRecords) rows.push(["blank"]);
    if (g.title !== HIDDEN_GRP) rows.push(["head", fmt.str(g.duration), g.title]);
    if (showRecords) {
      for (const r of g.records) {
        rows.push(["record", r.key, fmt.str(r.dur), repDate(r.t1), clock(r.t1), clock(r.t2), r.ds, r.tagsDisp]);
      }
    }
  }
  return rows;
}

function renderReportPreview() {
  const host = document.getElementById("rp-preview");
  const [t1, t2] = reportRange();
  if (t2 <= t1) { host.innerHTML = '<div class="rep-empty">Pick a valid date range.</div>'; return; }
  const rows = reportRows(t1, t2);
  if (!rows.some((r) => r[0] === "head" || r[0] === "record")) {
    host.innerHTML = '<div class="rep-empty">No time recorded in this range.</div>';
    return;
  }
  let html = '<table class="rep-table">';
  for (const row of rows) {
    if (row[0] === "total") html += `<tr class="total"><th class="num">${escapeHtml(row[1])}</th><th colspan="4">Total</th></tr>`;
    else if (row[0] === "head") html += `<tr class="grp"><th class="num">${escapeHtml(row[1])}</th><th colspan="4">${escapeHtml(row[2])}</th></tr>`;
    else if (row[0] === "record") {
      const [, , dur, date, st, en, ds, tags] = row;
      html += `<tr class="rec"><td class="num">${escapeHtml(dur)}</td><td>${escapeHtml(date)}</td><td>${escapeHtml(st)}–${escapeHtml(en)}</td><td class="desc">${ds ? escapeHtml(ds) : "—"}</td><td class="rec-tags">${escapeHtml(tags)}</td></tr>`;
    }
  }
  html += "</table>";
  host.innerHTML = html;
}

function repMsg(text, ok) {
  const el = document.getElementById("rp-msg");
  el.textContent = text || "";
  el.classList.toggle("ok", !!ok);
}

function reportDefaultName() {
  const f = (document.getElementById("rp-from").value || "").replace(/-/g, "");
  const tt = (document.getElementById("rp-to").value || "").replace(/-/g, "");
  if (f && tt && f !== tt) return `tagged-report-${f}-${tt}`;
  if (f) return `tagged-report-${f}`;
  return "tagged-report";
}
function reportFilename(ext) {
  let name = (document.getElementById("rp-filename").value || "").trim();
  name = name.replace(/[\/\\:*?"<>|]+/g, "").trim();
  if (!name) name = reportDefaultName();
  name = name.replace(/\.(csv|pdf)$/i, "");
  return `${name}.${ext}`;
}

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

function reportSaveCSV() {
  const [t1, t2] = reportRange();
  if (t2 <= t1) return repMsg("Pick a valid date range.", false);
  const rows = reportRows(t1, t2);
  const lines = ["subtotals,tag_groups,duration,date,start,stop,description,tags", ""];
  for (const row of rows) {
    if (row[0] === "total") lines.push(`${csvCell(row[1])},Total,,,,,,`);
    else if (row[0] === "blank") lines.push(",,,,,,,");
    else if (row[0] === "head") lines.push(`${csvCell(row[1])},${csvCell(row[2])},,,,,,`);
    else if (row[0] === "record") {
      const [, , dur, date, st, en, ds, tags] = row;
      lines.push(`,,${csvCell(dur)},${date},${st},${en},${csvCell(ds)},${csvCell(tags)}`);
    }
  }
  const name = reportFilename("csv");
  downloadBlob(lines.join("\r\n"), name, "text/csv");
  repMsg(`Saved ${name}`, true);
}

function reportCopyTable() {
  const [t1, t2] = reportRange();
  if (t2 <= t1) return repMsg("Pick a valid date range.", false);
  const rows = reportRows(t1, t2);
  const lines = [];
  for (const row of rows) {
    if (row[0] === "total") lines.push(`${row[1]}\tTotal`);
    else if (row[0] === "blank") lines.push("");
    else if (row[0] === "head") lines.push(`${row[1]}\t${row[2]}`);
    else if (row[0] === "record") { const [, , dur, date, st, en, ds, tags] = row; lines.push(`\t\t${dur}\t${date}\t${st}\t${en}\t${ds}\t${tags}`); }
  }
  const text = lines.join("\n");
  const done = () => repMsg("Copied — paste into a spreadsheet.", true);
  const fail = () => repMsg("Copy failed.", false);
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
  else fail();
}

function reportSavePDF() {
  const [t1, t2] = reportRange();
  if (t2 <= t1) return repMsg("Pick a valid date range.", false);
  const rows = reportRows(t1, t2);
  const name = reportFilename("pdf").replace(/\.pdf$/i, "");
  const d1 = document.getElementById("rp-from").value;
  const d2 = document.getElementById("rp-to").value;

  let body = '<table class="r">';
  for (const row of rows) {
    if (row[0] === "total") body += `<tr class="tot"><td class="n">${escapeHtml(row[1])}</td><td colspan="4">Total</td></tr>`;
    else if (row[0] === "blank") body += '<tr class="sp"><td colspan="5"></td></tr>';
    else if (row[0] === "head") body += `<tr class="g"><td class="n">${escapeHtml(row[1])}</td><td colspan="4">${escapeHtml(row[2])}</td></tr>`;
    else if (row[0] === "record") {
      const [, , dur, date, st, en, ds, tags] = row;
      body += `<tr><td class="n">${escapeHtml(dur)}</td><td>${escapeHtml(date)}</td><td>${escapeHtml(st)}–${escapeHtml(en)}</td><td>${ds ? escapeHtml(ds) : "—"}</td><td class="tg">${escapeHtml(tags)}</td></tr>`;
    }
  }
  body += "</table>";

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(name)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; margin: 32px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .meta { color: #666; font-size: 12px; margin-bottom: 20px; }
  table.r { width: 100%; border-collapse: collapse; font-size: 12px; }
  table.r td { padding: 6px 10px; border-bottom: 1px solid #eee; vertical-align: top; }
  table.r td.n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; width: 70px; }
  table.r tr.tot td { font-size: 15px; font-weight: 700; border-bottom: 2px solid #333; }
  table.r tr.g td { font-weight: 700; background: #f4f4f4; border-bottom: 1px solid #ccc; }
  table.r tr.sp td { border: none; height: 8px; }
  table.r td.tg { color: #888; }
  @media print { body { margin: 0; } @page { margin: 18mm; } }
</style></head><body>
  <h1>Time report</h1>
  <div class="meta">${escapeHtml(d1)} &ndash; ${escapeHtml(d2)}</div>
  ${body}
</body></html>`;

  const w = window.open("", "_blank");
  if (!w) return repMsg("Allow pop-ups to save as PDF.", false);
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => { w.print(); }, 250);
  repMsg("Opened print view — choose “Save as PDF”.", true);
}

function openReportModal() {
  const start = weekStartOf(selDate);
  const end = addDays(start, 6);
  document.getElementById("rp-from").value = dateInputVal(start.getTime() / 1000);
  document.getElementById("rp-to").value = dateInputVal(end.getTime() / 1000);
  document.getElementById("rp-filename").value = reportDefaultName();
  repMsg("", false);
  renderReportPreview();
  document.getElementById("report-modal").hidden = false;
}
function closeReportModal() { document.getElementById("report-modal").hidden = true; }

function wireReportModal() {
  const refresh = () => { renderReportPreview(); repMsg("", false); };
  ["rp-grouping", "rp-period", "rp-format"].forEach((id) => document.getElementById(id).addEventListener("change", refresh));
  document.getElementById("rp-records").addEventListener("change", refresh);
  ["rp-from", "rp-to"].forEach((id) => document.getElementById(id).addEventListener("change", () => {
    const fn = document.getElementById("rp-filename");
    if (!fn.value.trim() || /^tagged-report/.test(fn.value.trim())) fn.value = reportDefaultName();
    refresh();
  }));
  document.getElementById("rp-csv").addEventListener("click", reportSaveCSV);
  document.getElementById("rp-pdf").addEventListener("click", reportSavePDF);
  document.getElementById("rp-copy").addEventListener("click", reportCopyTable);
  document.getElementById("rp-close").addEventListener("click", closeReportModal);
  document.getElementById("report-modal").addEventListener("click", (e) => {
    if (e.target.id === "report-modal") closeReportModal();
  });
}

async function initEntries() {
  await loadSettings();
  try { await loadAll(); } catch (e) { return; }

  // Start the timeline on the selected day (today), showing a full 24 hours.
  tlDur = 24 * 3600;
  tlStart = midnight(selDate).getTime() / 1000;

  document.getElementById("week-prev").addEventListener("click", () => { selDate = midnight(addDays(selDate, -7)); tlStart = selDate.getTime() / 1000; renderEntriesPage(); });
  document.getElementById("week-next").addEventListener("click", () => { selDate = midnight(addDays(selDate, 7)); tlStart = selDate.getTime() / 1000; renderEntriesPage(); });
  document.getElementById("new-entry").addEventListener("click", () => openEntryModal(null));
  document.getElementById("open-report").addEventListener("click", openReportModal);

  // Timeline controls.
  document.getElementById("tl-today").addEventListener("click", tlSetToday);
  document.getElementById("tl-up").addEventListener("click", () => tlPan(-0.2));
  document.getElementById("tl-down").addEventListener("click", () => tlPan(0.2));
  document.getElementById("tl-zoom-in").addEventListener("click", () => tlZoom(1 / 1.4));
  document.getElementById("tl-zoom-out").addEventListener("click", () => tlZoom(1.4));

  // Keyboard: ↑/PageUp earlier, ↓/PageDown later, ←/→ zoom in/out.
  const wrap = document.getElementById("tl-wrap");
  wrap.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "ArrowUp": case "PageUp": tlPan(-0.2); break;
      case "ArrowDown": case "PageDown": tlPan(0.2); break;
      case "ArrowLeft": tlZoom(1 / 1.4); break;
      case "ArrowRight": tlZoom(1.4); break;
      default: return;
    }
    e.preventDefault();
  });
  // Mouse wheel over the timeline pans; Ctrl/Cmd + wheel zooms.
  wrap.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) tlZoom(e.deltaY > 0 ? 1.15 : 1 / 1.15);
    else tlPan((e.deltaY > 0 ? 1 : -1) * 0.12);
  }, { passive: false });
  // Double-click an empty spot to add an entry starting at that time.
  document.getElementById("tl-canvas").addEventListener("dblclick", (e) => {
    if (e.target.closest(".tl-block")) return;
    const rect = wrap.getBoundingClientRect();
    const frac = (e.clientY - rect.top) / Math.max(1, rect.height);
    let t1 = Math.round((tlStart + frac * tlDur) / 300) * 300;  // snap to 5 min
    openEntryModal(null, { t1, t2: t1 + 1800 });
  });
  window.addEventListener("resize", renderTimeline);

  // View switch: show either the list or the timeline (week strip stays in both).
  const savedView = localStorage.getItem(ENTRIES_VIEW_KEY) === "list" ? "list" : "timeline";
  document.getElementById("view-switch").querySelectorAll(".vs-btn").forEach((b) => {
    b.addEventListener("click", () => setEntriesView(b.dataset.view));
  });
  setEntriesView(savedView);

  wireEntryModal();
  wireReportModal();
  document.addEventListener("click", closeAllMenus);
  renderEntriesPage();

  // Reflect entries created by other apps/tabs within a few seconds.
  startAutoSync(renderEntriesPage);
}

// setEntriesView switches between the list and timeline views and remembers the
// choice. The timeline is re-rendered when shown so it can measure its height
// (a hidden element reports zero).
function setEntriesView(view) {
  document.getElementById("view-list").hidden = view !== "list";
  document.getElementById("view-timeline").hidden = view !== "timeline";
  document.getElementById("view-switch").querySelectorAll(".vs-btn").forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  localStorage.setItem(ENTRIES_VIEW_KEY, view);
  if (view === "timeline") renderTimeline();
}

// ---- Admin: user management -------------------------------------------------

function fmtBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
function fmtDate(epoch) {
  if (!epoch) return "—";
  const d = new Date(epoch * 1000);
  return d.getDate() + " " + MONTHS[d.getMonth()].slice(0, 3) + " " + d.getFullYear();
}

// Admin page state: the full user list and the currently-selected username.
let ADMIN_USERS = [];
let ADMIN_SELECTED = null;
let USER_DRAFT = null; // profile fields + avatar being edited in the details panel
// Groups are server-wide, so the page loads them once and reads each user's
// membership out of them. null means "not loaded" (no groups.manage permission),
// which hides the Groups card rather than showing an empty one.
let ADMIN_GROUPS = null;

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

// roleOf maps a user record to a single primary role badge.
function roleOf(u) {
  if (u.config_admin) return { key: "admin", label: "Admin · config", cls: "admin" };
  if (u.is_admin) return { key: "admin", label: "Admin", cls: "admin" };
  if (u.is_controller) return { key: "controller", label: "Controller", cls: "controller" };
  return { key: "user", label: "User", cls: "muted" };
}

function statusOf(u) {
  // Deactivated outranks the password state: it is the one that decides whether
  // the account can be used at all.
  if (u.disabled) return { key: "disabled", label: "Deactivated", cls: "muted" };
  return u.registered
    ? { key: "registered", label: "Registered", cls: "ok" }
    : { key: "nopw", label: "No password", cls: "muted" };
}

function userMatchesFilters(u) {
  const q = (document.getElementById("user-search").value || "").trim().toLowerCase();
  const roleF = document.getElementById("role-filter").value;
  const statusF = document.getElementById("status-filter").value;
  if (q) {
    const p = u.profile || {};
    // Search the whole directory entry, not just the login name.
    const hay = [u.username, p.first_name, p.last_name, p.job, p.department, p.email, p.phone, p.mobile]
      .filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (roleF && roleOf(u).key !== roleF) return false;
  if (statusF && statusOf(u).key !== statusF) return false;
  return true;
}

function renderUsersTable() {
  const body = document.getElementById("users-body");
  const count = document.getElementById("users-count");
  const rows = ADMIN_USERS.filter(userMatchesFilters);
  if (ADMIN_USERS.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="muted">No users yet.</td></tr>';
    count.textContent = "";
    return;
  }
  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="muted">No users match your filters.</td></tr>';
  } else {
    body.innerHTML = rows.map((u) => {
      const uAttr = escapeHtml(u.username);
      const role = roleOf(u);
      const st = statusOf(u);
      const sel = u.username === ADMIN_SELECTED ? " selected" : "";
      const off = u.disabled ? " off" : "";
      const name = displayName(u.username, u.profile);
      // The second line carries the username once a real name takes the first,
      // then falls back to the job title so the row still says something useful.
      const sub = fullName(u.profile) ? u.username : (u.profile || {}).job || "";
      return `<tr class="um-row${sel}${off}" data-u="${uAttr}">
        <td>
          <div class="um-user">
            ${avatarHtml(u.username, u.profile, u.avatar)}
            <span class="um-id">
              <span class="um-name">${escapeHtml(name)}</span>
              ${sub ? `<span class="um-sub">${escapeHtml(sub)}</span>` : ""}
            </span>
          </div>
        </td>
        <td><span class="badge ${role.cls}">${escapeHtml(role.label)}</span></td>
        <td><span class="status-dot ${st.cls}"></span>${escapeHtml(st.label)}</td>
        <td class="muted">${fmtBytes(u.size_bytes)}</td>
        <td class="muted">${fmtDate(u.modified)}</td>
        <td><button class="um-dots" data-u="${uAttr}" title="Actions">⋯</button></td>
      </tr>`;
    }).join("");
  }
  count.textContent = `Showing ${rows.length} of ${ADMIN_USERS.length} user${ADMIN_USERS.length === 1 ? "" : "s"}`;

  body.querySelectorAll(".um-row").forEach((tr) => tr.addEventListener("click", (e) => {
    if (e.target.closest(".um-dots")) return; // dots handled separately
    selectUser(tr.dataset.u);
  }));
  body.querySelectorAll(".um-dots").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    openRowMenu(b, b.dataset.u);
  }));
}

// ---- Admin actions (shared by the details panel and the row menu) -----------

function adminMsg() { return document.getElementById("users-msg"); }

async function actResetPassword(username) {
  const pw = prompt(`New password for ${username}:`);
  if (pw === null) return;
  if (pw.length < 4) { showMsg(adminMsg(), "Password must be at least 4 characters", "error"); return; }
  const r = await apiFetch("admin/password", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: pw }),
  });
  showMsg(adminMsg(), r.ok ? `Password reset for ${username}` : (await r.text()), r.ok ? "ok" : "error");
}

// MFA_SCOPES: what each reset clears, and how to describe it. The row menu
// offers the two factors separately; the details panel resets both at once.
const MFA_SCOPES = {
  totp: {
    confirm: "Their authenticator app and backup codes stop working. Any passkeys stay.",
    done: "Authenticator reset",
  },
  passkeys: {
    confirm: "Every registered passkey is removed. Their authenticator app, if any, stays.",
    done: "Passkeys removed",
  },
  all: {
    confirm: "Their authenticator app, backup codes and passkeys all stop working.",
    done: "Two-factor reset",
  },
};

// actResetMFA clears second factors, for a user who lost their device.
async function actResetMFA(username, scope = "all") {
  const s = MFA_SCOPES[scope] || MFA_SCOPES.all;
  if (!confirm(`Reset two-factor for ${username}?\n\n${s.confirm}\n\nThey can sign in with their password alone until they set it up again.`)) return;
  const r = await apiFetch("admin/mfa", {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, scope }),
  });
  if (r.ok) { showMsg(adminMsg(), `${s.done} for ${username}`, "ok"); loadUsers(); }
  else showMsg(adminMsg(), await r.text(), "error");
}

// actSetDisabled deactivates or reactivates an account. Deactivating keeps all
// data but signs the user out everywhere and blocks further logins.
async function actSetDisabled(username, disabled) {
  const q = disabled
    ? `Deactivate ${username}?\n\nTheir data is kept, but they are signed out everywhere and cannot log in until you reactivate them.`
    : `Reactivate ${username}? They will be able to log in again.`;
  if (!confirm(q)) return;
  const r = await apiFetch("admin/disable", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, disabled }),
  });
  if (r.ok) { showMsg(adminMsg(), `${disabled ? "Deactivated" : "Reactivated"} ${username}`, "ok"); loadUsers(); }
  else showMsg(adminMsg(), await r.text(), "error");
}

async function actDeleteUser(username) {
  if (!confirm(`Delete user "${username}" and all their data? This cannot be undone.`)) return;
  const r = await apiFetch("admin/user", {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  if (r.ok) {
    showMsg(adminMsg(), `Deleted ${username}`, "ok");
    if (ADMIN_SELECTED === username) ADMIN_SELECTED = null;
    loadUsers();
  } else showMsg(adminMsg(), await r.text(), "error");
}

// ---- Row "⋯" menu -----------------------------------------------------------
// Shared by the users and groups tables: same look, same placement, one copy of
// the positioning rules.

function closeRowMenu() {
  const m = document.getElementById("um-row-menu");
  if (m) m.remove();
}

// openDotsMenu pops `items` (button markup) under `r`, a DOMRect of the button
// that was clicked, and calls onPick with the chosen button's data-act. It takes
// a rect rather than the element because a caller may re-render the table (and
// so replace the button) before the menu opens. The menu closes before the
// action runs, so an action that opens a modal is not left sitting behind one.
function openDotsMenu(r, items, onPick) {
  closeRowMenu();
  if (!items.length) return;
  const menu = document.createElement("div");
  menu.id = "um-row-menu";
  menu.className = "menu-pop open";
  menu.innerHTML = items.join("");
  document.body.appendChild(menu);
  menu.style.position = "fixed";
  // .menu-pop pins itself to right:0 for its in-flow use. Left unset here, the
  // fixed box would stretch from `left` all the way to the viewport edge.
  menu.style.right = "auto";
  menu.style.top = (r.bottom + 4) + "px";
  menu.style.left = Math.max(8, r.right - menu.offsetWidth) + "px";
  // Keep the menu on screen when the anchor sits near the bottom edge.
  const h = menu.offsetHeight;
  if (r.bottom + 4 + h > window.innerHeight - 8) {
    menu.style.top = Math.max(8, r.top - 4 - h) + "px";
  }

  menu.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    closeRowMenu();
    onPick(b.dataset.act);
  }));
}

function openRowMenu(anchor, username) {
  const u = ADMIN_USERS.find((x) => x.username === username);
  if (!u) return;
  const me = localStorage.getItem(USER_KEY) || "";
  const isSelf = username === me;
  // Roles and profile are edited in the details panel, so the row menu carries
  // only the account actions — and only the resets that have something to clear.
  const items = [`<button data-act="reset">Reset password</button>`];
  if (u.totp_enabled) items.push(`<button data-act="reset-totp">Reset 2FA</button>`);
  if (u.passkeys) items.push(`<button data-act="reset-passkeys">Reset passkeys</button>`);
  if (!isSelf) {
    items.push(u.disabled
      ? `<button data-act="activate">Reactivate user</button>`
      : `<button data-act="deactivate">Deactivate user</button>`);
    items.push(`<button class="danger" data-act="delete">Delete user</button>`);
  }

  openDotsMenu(anchor.getBoundingClientRect(), items, (act) => {
    if (act === "reset") actResetPassword(username);
    else if (act === "reset-totp") actResetMFA(username, "totp");
    else if (act === "reset-passkeys") actResetMFA(username, "passkeys");
    else if (act === "deactivate") actSetDisabled(username, true);
    else if (act === "activate") actSetDisabled(username, false);
    else if (act === "delete") actDeleteUser(username);
  });
}

// ---- Details panel ----------------------------------------------------------

function selectUser(username) {
  ADMIN_SELECTED = username;
  renderUsersTable();
  renderUserDetails();
}

// profileFormHtml renders the shared field grid from a draft object.
function profileFormHtml(draft) {
  const field = (key, id, label, type = "text") =>
    `<div><label for="${id}">${label}</label>
       <input id="${id}" type="${type}" data-pf="${key}" value="${escapeHtml(draft[key] || "")}"></div>`;
  return `<div class="pf-grid">
    ${field("first_name", "du-first", "First name")}
    ${field("last_name", "du-last", "Last name")}
    ${field("job", "du-job", "Job")}
    ${field("department", "du-dept", "Department")}
    ${field("email", "du-email", "E-mail", "email")}
    ${field("phone", "du-phone", "Phone", "tel")}
    ${field("mobile", "du-mobile", "Mobile", "tel")}
  </div>`;
}

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

// groupSlotOf reports which side of a group a user can be on. It mirrors the
// server's validateGroupUsers: controllers oversee groups, regular users belong
// to them, and stored admins can be neither.
function groupSlotOf(u) {
  if (u.config_admin) return "controllers"; // root admins may oversee any group
  if (u.is_admin) return null;
  return u.is_controller ? "controllers" : "members";
}

// groupsOf returns the groups a user is currently in, on their own side.
function groupsOf(u) {
  const slot = groupSlotOf(u);
  if (!slot || !ADMIN_GROUPS) return [];
  return ADMIN_GROUPS.filter((g) => (g[slot] || []).includes(u.username));
}

// mfaSummary describes the second factors on an account in one line each.
function mfaSummary(u) {
  const parts = [];
  if (u.totp_enabled) parts.push("Authenticator app");
  if (u.passkeys) parts.push(`${u.passkeys} passkey${u.passkeys === 1 ? "" : "s"}`);
  return parts;
}

function renderUserDetails() {
  const host = document.getElementById("user-details");
  const u = ADMIN_USERS.find((x) => x.username === ADMIN_SELECTED);
  if (!u) {
    host.classList.remove("filled");
    host.innerHTML = `<div class="um-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/></svg>
      <p>Select a user to view details, roles and actions.</p>
    </div>`;
    return;
  }
  const me = localStorage.getItem(USER_KEY) || "";
  const isSelf = u.username === me;
  const role = roleOf(u);
  const p = u.profile || {};

  // Header card: who this is, at a glance.
  const state = u.disabled
    ? `<span class="ud-state off"><span class="status-dot"></span>Deactivated</span>`
    : `<span class="ud-state on"><span class="status-dot ok"></span>Active</span>`;
  const head = `<div class="ud-head">
    ${avatarHtml(u.username, p, u.avatar, "lg")}
    <div class="ud-id">
      <div class="ud-name-row">
        <span class="ud-name">${escapeHtml(displayName(u.username, p))}</span>
        <span class="badge ${role.cls}">${escapeHtml(role.label)}</span>
      </div>
      ${fullName(p) ? `<div class="ud-username">${escapeHtml(u.username)}</div>` : ""}
      ${state}
    </div>
  </div>`;

  // Profile card — read-only here; the pencil opens the edit modal.
  const name = fullName(p);
  const profileRows = [
    udRow("Full name", name ? escapeHtml(name) : '<span class="ud-unset">Not set</span>'),
    udRow("Job", p.job ? escapeHtml(p.job) : '<span class="ud-unset">Not set</span>'),
    udRow("Department", p.department ? escapeHtml(p.department) : '<span class="ud-unset">Not set</span>'),
    udRow("E-mail", p.email ? escapeHtml(p.email) : '<span class="ud-unset">Not set</span>'),
    udRow("Phone", p.phone ? escapeHtml(p.phone) : '<span class="ud-unset">Not set</span>'),
    udRow("Mobile", p.mobile ? escapeHtml(p.mobile) : '<span class="ud-unset">Not set</span>'),
    udRow("Storage", fmtBytes(u.size_bytes)),
    udRow("Last active", fmtDate(u.modified)),
  ].join("");
  const profileCard = udCard("Profile", profileRows,
    `<button class="secondary btn-sm" id="d-edit-profile">Edit</button>`);

  // Groups card, above Roles: a user's groups only make sense in the light of
  // the role that decides which side of a group they can be on.
  let groupsCard = "";
  if (ADMIN_GROUPS) {
    const slot = groupSlotOf(u);
    const mine = groupsOf(u);
    let body;
    if (!slot) {
      body = `<p class="muted um-note">Admins are not part of groups — they can already see every user.</p>`;
    } else if (!ADMIN_GROUPS.length) {
      body = `<p class="muted um-note">No groups exist yet. Create one on the Groups page.</p>`;
    } else if (!mine.length) {
      body = `<p class="muted um-note">${slot === "controllers"
        ? "Controls no groups, so cannot act as anyone yet."
        : "Not a member of any group."}</p>`;
    } else {
      body = `<div class="gm-chips">${mine
        .map((g) => `<span class="gm-chip">${escapeHtml(g.name)}</span>`).join("")}</div>
        <p class="muted um-note">${slot === "controllers"
          ? "Can act as the members of these groups."
          : "Controlled by the controllers of these groups."}</p>`;
    }
    const canManage = slot && ADMIN_GROUPS.length && (window.TT_CAPS || []).includes("groups.manage");
    groupsCard = udCard(slot === "controllers" ? "Groups controlled" : "Groups", body,
      canManage ? `<button class="secondary btn-sm" id="d-manage-groups">Manage</button>` : "");
  }

  // Roles card.
  const roleNote = u.config_admin
    ? "Configured root admin — the role is fixed in the server config."
    : ROLE_BLURB[role.key];
  const rolesCard = udCard("Roles", `
    <div class="ud-roles"><span class="badge ${role.cls}">${escapeHtml(role.label)}</span></div>
    <p class="muted um-note">${escapeHtml(roleNote)}</p>`,
    u.config_admin || isSelf ? "" : `<button class="secondary btn-sm" id="d-manage-roles">Manage</button>`);

  // Security card: password and second factors, each with its own reset.
  const factors = mfaSummary(u);
  const mfaValue = factors.length
    ? `<span class="ud-ok">Enabled</span> · ${escapeHtml(factors.join(", "))}`
    : `<span class="ud-unset">Not enabled</span>`;
  const securityCard = udCard("Security", `
    <div class="ud-line">
      <div class="ud-line-text">
        <div class="ud-line-label">Password</div>
        <div class="ud-line-sub">${u.registered ? "Set" : "No password — token access only"}</div>
      </div>
      <button class="secondary btn-sm" id="d-reset-pw">Reset</button>
    </div>
    <div class="ud-line">
      <div class="ud-line-text">
        <div class="ud-line-label">Two-factor authentication</div>
        <div class="ud-line-sub">${mfaValue}</div>
      </div>
      <button class="secondary btn-sm" id="d-reset-mfa" ${factors.length ? "" : "disabled"}>Reset</button>
    </div>`);

  // Bottom actions. Neither is available on your own account, so an admin can
  // never lock themselves out from this panel.
  const selfTitle = ' title="You cannot do this to your own account"';
  const actions = `<div class="ud-danger">
    <button class="secondary" id="d-toggle-active" ${isSelf ? "disabled" + selfTitle : ""}>
      ${u.disabled ? "Reactivate user" : "Deactivate user"}
    </button>
    <button class="danger-btn" id="d-delete" ${isSelf ? "disabled" + selfTitle : ""}>Delete user</button>
  </div>`;

  host.classList.add("filled");
  host.innerHTML = head + profileCard + groupsCard + rolesCard + securityCard + actions;

  const on = (id, fn) => { const el = host.querySelector(id); if (el) el.addEventListener("click", fn); };
  on("#d-edit-profile", () => openEditProfile(u.username));
  on("#d-manage-groups", () => openEditGroups(u.username));
  on("#d-manage-roles", () => openEditRoles(u.username));
  on("#d-reset-pw", () => actResetPassword(u.username));
  on("#d-reset-mfa", () => actResetMFA(u.username));
  if (!isSelf) {
    on("#d-toggle-active", () => actSetDisabled(u.username, !u.disabled));
    on("#d-delete", () => actDeleteUser(u.username));
  }
}

// ROLE_BLURB explains, in the details panel, what the selected role can do.
const ROLE_BLURB = {
  admin: "Full access to all features and settings, including user management.",
  controller: "Can view and manage the time of the users in their groups.",
  user: "Can track and manage their own time only.",
};

// ---- Edit profile modal -----------------------------------------------------

function editProfileModal() { return document.getElementById("edit-profile-modal"); }

// openEditProfile fills the modal from the saved profile and shows it. The form
// edits USER_DRAFT, so Cancel simply throws the draft away.
function openEditProfile(username) {
  const u = ADMIN_USERS.find((x) => x.username === username);
  if (!u) return;
  USER_DRAFT = { ...(u.profile || {}), avatar: u.avatar || "" };
  renderEditProfile();
  const m = editProfileModal();
  m.hidden = false;
  const first = m.querySelector("#du-first");
  if (first) first.focus();
}

function closeEditProfile() { editProfileModal().hidden = true; }

// renderEditProfile (re)draws the modal body. It runs again after a picture
// change, which is why the field values come from the draft rather than the DOM.
function renderEditProfile() {
  const m = editProfileModal();
  const u = ADMIN_USERS.find((x) => x.username === ADMIN_SELECTED);
  m.querySelector("#ep-avatar").innerHTML =
    avatarHtml(u ? u.username : "", USER_DRAFT, USER_DRAFT.avatar, "lg");
  m.querySelector("#ep-fields").innerHTML = profileFormHtml(USER_DRAFT);
  m.querySelector("#ep-pick").textContent = USER_DRAFT.avatar ? "Change picture" : "Upload picture";
  m.querySelector("#ep-clear").hidden = !USER_DRAFT.avatar;
  m.querySelector("#ep-msg").innerHTML = "";
  m.querySelectorAll("input[data-pf]").forEach((inp) => inp.addEventListener("input", () => {
    USER_DRAFT[inp.dataset.pf] = inp.value;
  }));
}

// ---- Manage groups modal ----------------------------------------------------

function editGroupsModal() { return document.getElementById("edit-groups-modal"); }

let GROUP_PICK = null; // Set of group ids ticked in the modal

// openEditGroups lists every group with a checkbox, since a user can be in more
// than one. What ticking a box means depends on the account's role, so the modal
// says so up front.
function openEditGroups(username) {
  const u = ADMIN_USERS.find((x) => x.username === username);
  if (!u || !ADMIN_GROUPS) return;
  const slot = groupSlotOf(u);
  if (!slot) return;
  GROUP_PICK = new Set(groupsOf(u).map((g) => g.id));

  const m = editGroupsModal();
  m.querySelector("#eg-msg").innerHTML = "";
  m.querySelector("#eg-intro").textContent = slot === "controllers"
    ? `${displayName(u.username, u.profile)} controls the groups you tick, and can act as their members.`
    : `${displayName(u.username, u.profile)} belongs to the groups you tick.`;
  m.querySelector("#eg-options").innerHTML = ADMIN_GROUPS.map((g) => {
    const on = GROUP_PICK.has(g.id);
    const count = (g[slot] || []).length;
    return `<label class="group-choice${on ? " on" : ""}" data-group="${escapeHtml(g.id)}">
      <input type="checkbox" ${on ? "checked" : ""}>
      <span class="group-choice-text">
        <span class="group-choice-label">${escapeHtml(g.name)}</span>
        <span class="group-choice-desc">${g.description
          ? escapeHtml(g.description)
          : `${count} ${slot === "controllers" ? "controller" : "member"}${count === 1 ? "" : "s"}`}</span>
      </span>
    </label>`;
  }).join("");
  m.querySelectorAll(".group-choice").forEach((el) => el.addEventListener("change", () => {
    const id = el.dataset.group;
    if (el.querySelector("input").checked) GROUP_PICK.add(id);
    else GROUP_PICK.delete(id);
    el.classList.toggle("on", GROUP_PICK.has(id));
  }));
  m.hidden = false;
}

function closeEditGroups() { editGroupsModal().hidden = true; }

// applyGroupPick writes the whole membership in one call, so a user moving
// between groups never lands in both or neither along the way.
async function applyGroupPick(username) {
  if (!GROUP_PICK) return;
  const msg = editGroupsModal().querySelector("#eg-msg");
  showMsg(msg, "Saving…", "");
  const r = await apiFetch("admin/user-groups", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, groups: [...GROUP_PICK] }),
  });
  if (!r.ok) { showMsg(msg, await r.text(), "error"); return; }
  closeEditGroups();
  showMsg(adminMsg(), `Updated the groups for ${username}`, "ok");
  await loadUserGroups();
  loadUsers();
}

// loadUserGroups caches the server-wide group list for the users page. (The
// Groups page has its own loadGroups; these must not share a name, since every
// page loads this one file.) A 403 means the visitor may manage users but not
// groups, so the card stays hidden.
async function loadUserGroups() {
  const r = await apiFetch("admin/groups");
  if (!r.ok) { ADMIN_GROUPS = null; return; }
  ADMIN_GROUPS = (await r.json()).groups || [];
}

// ---- Manage roles modal -----------------------------------------------------

function editRolesModal() { return document.getElementById("edit-roles-modal"); }

let ROLE_PICK = null; // role key selected in the modal

function openEditRoles(username) {
  const u = ADMIN_USERS.find((x) => x.username === username);
  if (!u || u.config_admin) return;
  ROLE_PICK = roleOf(u).key;
  const m = editRolesModal();
  m.querySelector("#er-msg").innerHTML = "";
  m.querySelector("#er-options").innerHTML = ["admin", "controller", "user"].map((key) => {
    const label = key === "admin" ? "Admin" : key === "controller" ? "Controller" : "User";
    return `<label class="role-choice${ROLE_PICK === key ? " on" : ""}" data-role="${key}">
      <input type="radio" name="er-role" value="${key}" ${ROLE_PICK === key ? "checked" : ""}>
      <span class="role-choice-text">
        <span class="role-choice-label">${label}</span>
        <span class="role-choice-desc">${escapeHtml(ROLE_BLURB[key])}</span>
      </span>
    </label>`;
  }).join("");
  m.querySelectorAll(".role-choice").forEach((el) => el.addEventListener("change", () => {
    ROLE_PICK = el.dataset.role;
    m.querySelectorAll(".role-choice").forEach((o) => o.classList.toggle("on", o.dataset.role === ROLE_PICK));
  }));
  m.hidden = false;
}

function closeEditRoles() { editRolesModal().hidden = true; }

// applyRolePick writes the chosen role. The two flags behind it are separate
// endpoints, so a change may take two calls; admin is cleared first so the user
// is never briefly both.
async function applyRolePick(username) {
  const u = ADMIN_USERS.find((x) => x.username === username);
  if (!u || !ROLE_PICK) return;
  const msg = editRolesModal().querySelector("#er-msg");
  const want = ROLE_PICK;
  if (roleOf(u).key === want) { closeEditRoles(); return; }

  const steps = [];
  if (u.is_admin && want !== "admin") steps.push(["admin/admin", { username, is_admin: false }]);
  if (u.is_controller !== (want === "controller")) {
    steps.push(["admin/controller", { username, is_controller: want === "controller" }]);
  }
  if (want === "admin" && !u.is_admin) steps.push(["admin/admin", { username, is_admin: true }]);

  showMsg(msg, "Saving…", "");
  for (const [path, body] of steps) {
    const r = await apiFetch(path, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) { showMsg(msg, await r.text(), "error"); loadUsers(); return; }
  }
  closeEditRoles();
  showMsg(adminMsg(), `Updated the role for ${username}`, "ok");
  // A role change can invalidate the user's group membership, which the server
  // prunes for us — reload the groups so the card reflects that.
  await loadUserGroups();
  loadUsers();
}

// saveUserProfile writes the edit-modal draft for username. The picture rides
// along only when it changed, so an unchanged one is not re-uploaded on a rename.
async function saveUserProfile(username) {
  if (!USER_DRAFT) return;
  const u = ADMIN_USERS.find((x) => x.username === username);
  const body = { username };
  for (const [key] of PROFILE_FIELDS) body[key] = USER_DRAFT[key] || "";
  if ((u.avatar || "") !== USER_DRAFT.avatar) body.avatar = USER_DRAFT.avatar;

  const msg = editProfileModal().querySelector("#ep-msg");
  showMsg(msg, "Saving…", "");
  const r = await apiFetch("admin/profile", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // Errors stay in the modal, so the visitor keeps the values they typed.
  if (!r.ok) { showMsg(msg, await r.text(), "error"); return; }
  closeEditProfile();
  showMsg(adminMsg(), `Saved profile for ${username}`, "ok");
  loadUsers();
}

async function loadUsers() {
  const body = document.getElementById("users-body");
  const resp = await apiFetch("admin/users");
  if (!resp.ok) {
    body.innerHTML = `<tr><td colspan="6" class="muted">${escapeHtml(await resp.text())}</td></tr>`;
    return;
  }
  ADMIN_USERS = (await resp.json()).users || [];
  if (ADMIN_SELECTED && !ADMIN_USERS.some((u) => u.username === ADMIN_SELECTED)) {
    ADMIN_SELECTED = null;
  }
  if (ADMIN_SELECTED) {
    selectUser(ADMIN_SELECTED); // re-seeds the draft from the freshly loaded row
  } else {
    USER_DRAFT = null;
    renderUsersTable();
    renderUserDetails();
  }
}

// ---- Add-user modal ---------------------------------------------------------

function openAddUser() {
  document.getElementById("create-msg").innerHTML = "";
  document.getElementById("new-username").value = "";
  document.getElementById("new-password").value = "";
  document.getElementById("add-user-modal").hidden = false;
  document.getElementById("new-username").focus();
}
function closeAddUser() { document.getElementById("add-user-modal").hidden = true; }

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

async function initAdmin() {
  if (!(await requireCap("users.manage"))) return;

  document.getElementById("user-search").addEventListener("input", renderUsersTable);
  document.getElementById("role-filter").addEventListener("change", renderUsersTable);
  document.getElementById("status-filter").addEventListener("change", renderUsersTable);

  document.getElementById("add-user-btn").addEventListener("click", openAddUser);
  document.getElementById("add-user-cancel").addEventListener("click", closeAddUser);
  document.getElementById("add-user-modal").addEventListener("click", (e) => {
    if (e.target.id === "add-user-modal") closeAddUser();
  });

  const createMsg = document.getElementById("create-msg");
  document.getElementById("create-user").addEventListener("click", async () => {
    const username = document.getElementById("new-username").value.trim();
    const password = document.getElementById("new-password").value;
    if (!username || password.length < 4) { showMsg(createMsg, "Enter a username and a password of at least 4 characters", "error"); return; }
    showMsg(createMsg, "Creating…", "");
    const r = await apiFetch("admin/users", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (r.ok) {
      showMsg(adminMsg(), `Created ${username}`, "ok");
      closeAddUser();
      ADMIN_SELECTED = username;
      loadUsers();
    } else {
      showMsg(createMsg, await r.text(), "error");
    }
  });

  // Edit profile modal.
  document.getElementById("ep-cancel").addEventListener("click", closeEditProfile);
  editProfileModal().addEventListener("click", (e) => {
    if (e.target.id === "edit-profile-modal") closeEditProfile();
  });
  document.getElementById("ep-pick").addEventListener("click", async () => {
    try {
      const data = await pickAvatar(document.getElementById("ep-file"));
      if (!data) return;
      USER_DRAFT.avatar = data;
      renderEditProfile();
    } catch (e) { showMsg(document.getElementById("ep-msg"), e.message, "error"); }
  });
  document.getElementById("ep-clear").addEventListener("click", () => {
    USER_DRAFT.avatar = "";
    renderEditProfile();
  });
  document.getElementById("ep-save").addEventListener("click", () => saveUserProfile(ADMIN_SELECTED));

  // Manage groups modal.
  document.getElementById("eg-cancel").addEventListener("click", closeEditGroups);
  editGroupsModal().addEventListener("click", (e) => {
    if (e.target.id === "edit-groups-modal") closeEditGroups();
  });
  document.getElementById("eg-save").addEventListener("click", () => applyGroupPick(ADMIN_SELECTED));

  // Manage roles modal.
  document.getElementById("er-cancel").addEventListener("click", closeEditRoles);
  editRolesModal().addEventListener("click", (e) => {
    if (e.target.id === "edit-roles-modal") closeEditRoles();
  });
  document.getElementById("er-save").addEventListener("click", () => applyRolePick(ADMIN_SELECTED));

  // Close the row menu on outside click / scroll / escape.
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#um-row-menu") && !e.target.closest(".um-dots")) closeRowMenu();
  });
  window.addEventListener("scroll", closeRowMenu, true);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeRowMenu();
    closeAddUser();
    closeEditProfile();
    closeEditGroups();
    closeEditRoles();
  });

  // Groups first: the details panel reads membership out of them, and a visitor
  // without groups.manage simply gets no Groups card.
  await loadUserGroups();
  loadUsers();
}

// ---- Roles page -------------------------------------------------------------
// The three roles are fixed; what each one may do is not. The table lists them
// like the user list, and the details panel edits the selected role's
// capabilities. Capabilities in LOCKED can't be taken away (they would strand a
// server with no way back into the admin pages), so they render disabled.

let ROLES = [];          // [{key, label, desc, caps: []}]
let ROLE_CAPS = [];      // capability catalog: [{key, label, desc}]
let ROLE_LOCKED = {};    // role key -> [cap, ...]
let ROLE_COUNTS = {};    // role key -> number of users
let ROLE_SELECTED = null;
let ROLE_DRAFT = null;   // Set of cap keys being edited in the details panel

function rolesMsg() { return document.getElementById("roles-msg"); }

function roleBadgeCls(key) {
  return key === "admin" ? "admin" : key === "controller" ? "controller" : "muted";
}

function renderRolesTable() {
  const body = document.getElementById("roles-body");
  body.innerHTML = ROLES.map((r) => {
    const sel = r.key === ROLE_SELECTED ? " selected" : "";
    const n = ROLE_COUNTS[r.key] || 0;
    const caps = r.caps.length
      ? `${r.caps.length} of ${ROLE_CAPS.length}`
      : `<span class="muted">None</span>`;
    return `<tr class="um-row${sel}" data-r="${escapeHtml(r.key)}">
      <td>
        <div class="um-user">
          <span class="badge ${roleBadgeCls(r.key)}">${escapeHtml(r.label)}</span>
        </div>
        <div class="rl-desc">${escapeHtml(r.desc)}</div>
      </td>
      <td class="muted">${caps}</td>
      <td class="muted">${n} user${n === 1 ? "" : "s"}</td>
      <td><span class="tm-edit">Edit</span></td>
    </tr>`;
  }).join("");
  body.querySelectorAll(".um-row").forEach((tr) =>
    tr.addEventListener("click", () => selectRole(tr.dataset.r)));
}

function selectRole(key) {
  ROLE_SELECTED = key;
  const r = ROLES.find((x) => x.key === key);
  ROLE_DRAFT = new Set(r ? r.caps : []);
  renderRolesTable();
  renderRoleDetails();
}

// roleDirty reports whether the draft differs from the saved capability set.
function roleDirty() {
  const r = ROLES.find((x) => x.key === ROLE_SELECTED);
  if (!r || !ROLE_DRAFT) return false;
  return r.caps.length !== ROLE_DRAFT.size || r.caps.some((c) => !ROLE_DRAFT.has(c));
}

function renderRoleDetails() {
  const host = document.getElementById("role-details");
  const r = ROLES.find((x) => x.key === ROLE_SELECTED);
  if (!r) {
    host.classList.remove("filled");
    host.innerHTML = `<div class="um-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 5-3.5 8-7 9-3.5-1-7-4-7-9V6l7-3z"/><path d="M9.5 12l2 2 3.5-4"/></svg>
      <p>Select a role to view and edit its permissions.</p>
    </div>`;
    return;
  }
  const locked = ROLE_LOCKED[r.key] || [];
  const n = ROLE_COUNTS[r.key] || 0;
  const rows = ROLE_CAPS.map((c) => {
    const on = ROLE_DRAFT.has(c.key);
    const isLocked = locked.includes(c.key);
    return `<label class="perm-row${isLocked ? " locked" : ""}">
      <span class="perm-text">
        <span class="perm-label">${escapeHtml(c.label)}</span>
        <span class="perm-desc">${escapeHtml(c.desc)}</span>
      </span>
      <span class="toggle">
        <input type="checkbox" data-cap="${escapeHtml(c.key)}" ${on ? "checked" : ""} ${isLocked ? "disabled" : ""}>
        <span class="slider"></span>
      </span>
    </label>`;
  }).join("");

  host.classList.add("filled");
  host.innerHTML = `
    <div class="ud-head">
      <div class="ud-id">
        <div class="ud-name">${escapeHtml(r.label)}</div>
        <span class="badge ${roleBadgeCls(r.key)}">${n} user${n === 1 ? "" : "s"}</span>
      </div>
    </div>

    <div class="ud-section">
      <div class="ud-section-head">About</div>
      <p class="um-note muted">${escapeHtml(r.desc)}</p>
    </div>

    <div class="ud-section">
      <div class="ud-section-head">Permissions</div>
      <div class="perm-list">${rows}</div>
      ${locked.length ? `<p class="um-note muted">Dimmed permissions are required for the ${escapeHtml(r.label)} role and can't be removed.</p>` : ""}
    </div>

    <div class="ud-section">
      <div class="ud-actions">
        <button class="btn-sm" id="role-save" ${roleDirty() ? "" : "disabled"}>Save changes</button>
        <button class="secondary btn-sm" id="role-reset" ${roleDirty() ? "" : "disabled"}>Reset</button>
      </div>
    </div>`;

  host.querySelectorAll(".perm-row input").forEach((cb) => cb.addEventListener("change", () => {
    if (cb.checked) ROLE_DRAFT.add(cb.dataset.cap);
    else ROLE_DRAFT.delete(cb.dataset.cap);
    // Re-render only to refresh the Save/Reset enabled state.
    renderRoleDetails();
  }));
  host.querySelector("#role-save").addEventListener("click", saveRole);
  host.querySelector("#role-reset").addEventListener("click", () => selectRole(r.key));
}

async function saveRole() {
  const r = ROLES.find((x) => x.key === ROLE_SELECTED);
  if (!r) return;
  const caps = ROLE_CAPS.map((c) => c.key).filter((k) => ROLE_DRAFT.has(k));
  const resp = await apiFetch("admin/roles", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: r.key, caps }),
  });
  if (!resp.ok) { showMsg(rolesMsg(), await resp.text(), "error"); return; }
  showMsg(rolesMsg(), `Saved permissions for ${r.label}`, "ok");
  ROLES = (await resp.json()).roles || ROLES;
  renderRolesTable();
  renderRoleDetails();
}

async function loadRoles() {
  const body = document.getElementById("roles-body");
  const resp = await apiFetch("admin/roles");
  if (!resp.ok) {
    body.innerHTML = `<tr><td colspan="4" class="muted">${escapeHtml(await resp.text())}</td></tr>`;
    return;
  }
  const d = await resp.json();
  ROLES = d.roles || [];
  ROLE_CAPS = d.capabilities || [];
  ROLE_LOCKED = d.locked || {};
  ROLE_COUNTS = d.counts || {};
  if (ROLE_SELECTED) selectRole(ROLE_SELECTED);
  else { renderRolesTable(); renderRoleDetails(); }
}

async function initRoles() {
  if (!(await requireCap("roles.manage"))) return;
  loadRoles();
}

// ---- Groups page ------------------------------------------------------------
// A group gathers regular users under one or more controllers; a controller can
// only switch to the users in the groups they control. Members and controllers
// are edited in the details panel and committed with Save.

let GROUPS = [];
let CAND_USERS = [];       // usernames eligible to be members
let CAND_CONTROLLERS = []; // usernames eligible to control a group
let GROUP_SELECTED = null;
// username -> {profile, avatar}, so member and controller lists can show a face
// and a real name instead of a bare login.
let GROUP_DIR = {};

function groupsMsg() { return document.getElementById("groups-msg"); }

function groupMatchesFilter(g) {
  const q = (document.getElementById("group-search").value || "").trim().toLowerCase();
  if (!q) return true;
  return g.name.toLowerCase().includes(q) || (g.description || "").toLowerCase().includes(q);
}

function renderGroupsTable() {
  const body = document.getElementById("groups-body");
  const count = document.getElementById("groups-count");
  const rows = GROUPS.filter(groupMatchesFilter);
  if (GROUPS.length === 0) {
    body.innerHTML = '<tr><td colspan="4" class="muted">No groups yet — create one to get started.</td></tr>';
    count.textContent = "";
    return;
  }
  if (rows.length === 0) {
    body.innerHTML = '<tr><td colspan="4" class="muted">No groups match your search.</td></tr>';
  } else {
    body.innerHTML = rows.map((g) => {
      const sel = g.id === GROUP_SELECTED ? " selected" : "";
      const ctrls = g.controllers.length
        ? g.controllers.map((c) => `<span class="badge controller">${escapeHtml(c)}</span>`).join(" ")
        : `<span class="badge muted">None</span>`;
      return `<tr class="um-row${sel}" data-g="${escapeHtml(g.id)}">
        <td>
          <div class="um-user"><span class="um-name">${escapeHtml(g.name)}</span></div>
          ${g.description ? `<div class="rl-desc">${escapeHtml(g.description)}</div>` : ""}
        </td>
        <td><div class="ud-roles" style="margin:0">${ctrls}</div></td>
        <td class="muted">${g.members.length} user${g.members.length === 1 ? "" : "s"}</td>
        <td><button class="um-dots" data-g="${escapeHtml(g.id)}" title="Actions">⋯</button></td>
      </tr>`;
    }).join("");
  }
  count.textContent = `Showing ${rows.length} of ${GROUPS.length} group${GROUPS.length === 1 ? "" : "s"}`;
  body.querySelectorAll(".um-row").forEach((tr) => tr.addEventListener("click", (e) => {
    if (e.target.closest(".um-dots")) return; // dots handled separately
    selectGroup(tr.dataset.g);
  }));
  body.querySelectorAll(".um-dots").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    openGroupRowMenu(b, b.dataset.g);
  }));
}

function selectGroup(id) {
  GROUP_SELECTED = id;
  renderGroupsTable();
  renderGroupDetails();
}

// openGroupRowMenu mirrors the users table's "⋯". The edit and duplicate modals
// commit against the selected group, so the row is selected first — that also
// leaves the details panel showing whatever the menu is about to act on.
function openGroupRowMenu(anchor, id) {
  const g = GROUPS.find((x) => x.id === id);
  if (!g) return;
  // Measured before selectGroup, which redraws the table and drops this button.
  const rect = anchor.getBoundingClientRect();
  selectGroup(id);
  openDotsMenu(rect, [
    `<button data-act="edit">Edit group</button>`,
    `<button data-act="duplicate">Duplicate group</button>`,
    `<button class="danger" data-act="delete">Delete group</button>`,
  ], (act) => {
    if (act === "edit") openGroupEdit(id);
    else if (act === "duplicate") openGroupDuplicate(id);
    else if (act === "delete") deleteGroup(g);
  });
}

// groupInitials takes up to two letters from a group name, the way initials()
// does for people.
function groupInitials(name) {
  const words = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const letters = words.length === 1
    ? words[0].slice(0, 2)
    : words[0][0] + words[1][0];
  return letters.toUpperCase();
}

// dirEntry looks a username up in the directory, tolerating one that is not
// there (a group can outlive the account it names until the prune runs).
function dirEntry(username) { return GROUP_DIR[username] || {}; }

// personRow renders one member/controller: avatar, display name, and the login
// underneath when the two differ.
function personRow(username) {
  const d = dirEntry(username);
  const name = displayName(username, d.profile);
  return `<div class="gr-person">
    ${avatarHtml(username, d.profile, d.avatar)}
    <span class="gr-person-text">
      <span class="gr-person-name">${escapeHtml(name)}</span>
      ${name !== username ? `<span class="gr-person-sub">${escapeHtml(username)}</span>` : ""}
    </span>
  </div>`;
}

// peopleCard is the shared body of the controllers and members cards.
function peopleCard(list, emptyNote) {
  if (!list.length) return `<p class="muted um-note">${escapeHtml(emptyNote)}</p>`;
  return `<div class="gr-people">${[...list].sort().map(personRow).join("")}</div>`;
}

function renderGroupDetails() {
  const host = document.getElementById("group-details");
  const g = GROUPS.find((x) => x.id === GROUP_SELECTED);
  if (!g) {
    host.classList.remove("filled");
    host.innerHTML = `<div class="um-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3"/><path d="M6 20v-1a6 6 0 0 1 12 0v1"/><circle cx="5" cy="9" r="2"/><path d="M2 20v-1a4 4 0 0 1 3-3.8"/><circle cx="19" cy="9" r="2"/><path d="M22 20v-1a4 4 0 0 0-3-3.8"/></svg>
      <p>Select a group to manage its members and controllers.</p>
    </div>`;
    return;
  }
  host.classList.add("filled");

  const head = `<div class="ud-head">
    <span class="gr-avatar">${escapeHtml(groupInitials(g.name))}</span>
    <div class="ud-id">
      <div class="ud-name">${escapeHtml(g.name)}</div>
      ${g.description
        ? `<p class="gr-desc">${escapeHtml(g.description)}</p>`
        : `<p class="gr-desc ud-unset">No description</p>`}
    </div>
  </div>`;

  const controllersCard = udCard("Controllers",
    peopleCard(g.controllers, "Nobody controls this group yet.") +
    `<p class="muted um-note" style="margin-top:10px">A controller can view and edit the time data of this group's members.</p>`,
    `<button class="secondary btn-sm" id="g-manage-controllers">Manage</button>`);

  const membersCard = udCard(`Members${g.members.length ? ` · ${g.members.length}` : ""}`,
    peopleCard(g.members, "No members yet."),
    `<button class="secondary btn-sm" id="g-manage-members">Manage</button>`);

  const actions = `<div class="ud-danger">
    <button class="secondary" id="g-edit">Edit group</button>
    <button class="secondary" id="g-duplicate">Duplicate group</button>
    <button class="danger-btn" id="g-delete">Delete group</button>
  </div>`;

  host.innerHTML = head + controllersCard + membersCard + actions;

  host.querySelector("#g-manage-controllers").addEventListener("click", () => openGroupPeople(g.id, "controllers"));
  host.querySelector("#g-manage-members").addEventListener("click", () => openGroupPeople(g.id, "members"));
  host.querySelector("#g-edit").addEventListener("click", () => openGroupEdit(g.id));
  host.querySelector("#g-duplicate").addEventListener("click", () => openGroupDuplicate(g.id));
  host.querySelector("#g-delete").addEventListener("click", () => deleteGroup(g));
}

// saveGroupFields writes a group back. Every group edit goes through the one
// save endpoint, which wants the whole record, so unchanged parts ride along.
async function saveGroupFields(g, changes, msgEl, okText) {
  const body = {
    id: g.id,
    name: g.name,
    description: g.description || "",
    members: g.members,
    controllers: g.controllers,
    ...changes,
  };
  const r = await apiFetch("admin/groups", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) { showMsg(msgEl, await r.text(), "error"); return false; }
  showMsg(groupsMsg(), okText, "ok");
  loadGroups();
  return true;
}

// ---- Manage members / controllers modal -------------------------------------
// One modal serves both lists; `kind` says which, since they differ only in
// which candidates are eligible.

let PEOPLE_KIND = null;  // "members" | "controllers"
let PEOPLE_PICK = null;  // Set of usernames currently on the group
let PEOPLE_POOL = [];    // every username that may be picked, sorted

// PEOPLE_RESULT_LIMIT caps how many matches are drawn at once. On a server with
// thousands of accounts, rendering them all would cost more than it tells the
// reader — the search box is the way through a list that long.
const PEOPLE_RESULT_LIMIT = 30;

function groupPeopleModal() { return document.getElementById("group-people-modal"); }

// personSearchText is what a query is matched against: the login plus every
// profile field a person might be looked up by.
function personSearchText(username) {
  const p = dirEntry(username).profile || {};
  return [username, p.first_name, p.last_name, p.job, p.department, p.email]
    .filter(Boolean).join(" ").toLowerCase();
}

// personLine renders the avatar + name block shared by both lists.
function personLine(username) {
  const d = dirEntry(username);
  const name = displayName(username, d.profile);
  return `${avatarHtml(username, d.profile, d.avatar)}
    <span class="gr-person-text">
      <span class="gr-person-name">${escapeHtml(name)}</span>
      ${name !== username ? `<span class="gr-person-sub">${escapeHtml(username)}</span>` : ""}
    </span>`;
}

// renderGroupPeople redraws both halves: who is on the group now, and the
// search results offering everyone who is not.
function renderGroupPeople() {
  const m = groupPeopleModal();
  const kindLabel = PEOPLE_KIND === "controllers" ? "controller" : "member";

  const chosen = [...PEOPLE_PICK].sort();
  m.querySelector("#gp-chosen").innerHTML = chosen.length
    ? chosen.map((u) => `<div class="gr-person" data-u="${escapeHtml(u)}">
        ${personLine(u)}
        <button class="gr-person-btn danger-link" data-remove="${escapeHtml(u)}">Remove</button>
      </div>`).join("")
    : `<p class="muted um-note">No ${kindLabel}s yet — search below to add someone.</p>`;
  m.querySelector("#gp-chosen-count").textContent = chosen.length
    ? `${chosen.length} ${kindLabel}${chosen.length === 1 ? "" : "s"}`
    : "";

  const q = m.querySelector("#gp-search").value.trim().toLowerCase();
  const free = PEOPLE_POOL.filter((u) => !PEOPLE_PICK.has(u));
  const matches = q ? free.filter((u) => personSearchText(u).includes(q)) : free;
  const shown = matches.slice(0, PEOPLE_RESULT_LIMIT);

  const results = m.querySelector("#gp-results");
  if (!free.length) {
    results.innerHTML = `<p class="muted um-note gr-result-note">${PEOPLE_POOL.length
      ? `Everyone eligible is already a ${kindLabel}.`
      : `No eligible users. Give someone the ${PEOPLE_KIND === "controllers" ? "Controller" : "User"} role first.`}</p>`;
  } else if (!shown.length) {
    results.innerHTML = `<p class="muted um-note gr-result-note">Nobody matches “${escapeHtml(q)}”.</p>`;
  } else {
    results.innerHTML = shown.map((u) => `<div class="gr-result" data-u="${escapeHtml(u)}">
        ${personLine(u)}
        <button class="secondary btn-sm gr-person-btn" data-add="${escapeHtml(u)}">Add</button>
      </div>`).join("")
      + (matches.length > shown.length
        ? `<p class="muted um-note gr-result-note">${matches.length - shown.length} more — keep typing to narrow it down.</p>`
        : "");
  }
}

function openGroupPeople(id, kind) {
  const g = GROUPS.find((x) => x.id === id);
  if (!g) return;
  PEOPLE_KIND = kind;
  PEOPLE_PICK = new Set(g[kind]);
  const candidates = kind === "controllers" ? CAND_CONTROLLERS : CAND_USERS;
  // A name already on the group stays in the pool even if it is no longer
  // eligible, so nobody is silently dropped by simply opening the modal.
  PEOPLE_POOL = [...new Set([...candidates, ...g[kind]])].sort();

  const m = groupPeopleModal();
  m.querySelector("#gp-title").textContent = kind === "controllers" ? "Manage controllers" : "Manage members";
  m.querySelector("#gp-intro").textContent = kind === "controllers"
    ? `Who oversees ${g.name}. Only users with the Controller role can be picked.`
    : `Who belongs to ${g.name}. Only users with the User role can be picked.`;
  m.querySelector("#gp-msg").innerHTML = "";
  m.querySelector("#gp-search").value = "";
  renderGroupPeople();
  m.hidden = false;
  m.querySelector("#gp-search").focus();
}

// wireGroupPeople binds the modal once, at init. The two lists are redrawn on
// every change, so their buttons are handled by delegation rather than rebound.
function wireGroupPeople() {
  const m = groupPeopleModal();
  m.querySelector("#gp-search").addEventListener("input", renderGroupPeople);
  m.addEventListener("click", (e) => {
    const add = e.target.closest("[data-add]");
    const remove = e.target.closest("[data-remove]");
    if (!add && !remove) return;
    if (add) PEOPLE_PICK.add(add.dataset.add);
    else PEOPLE_PICK.delete(remove.dataset.remove);
    renderGroupPeople();
    // Adding several people in a row should not cost a click back into the box.
    if (add) m.querySelector("#gp-search").focus();
  });
}

function closeGroupPeople() { groupPeopleModal().hidden = true; }

async function applyGroupPeople() {
  const g = GROUPS.find((x) => x.id === GROUP_SELECTED);
  if (!g || !PEOPLE_KIND || !PEOPLE_PICK) return;
  const msg = groupPeopleModal().querySelector("#gp-msg");
  showMsg(msg, "Saving…", "");
  const ok = await saveGroupFields(g, { [PEOPLE_KIND]: [...PEOPLE_PICK] }, msg,
    `Updated the ${PEOPLE_KIND} of ${g.name}`);
  if (ok) closeGroupPeople();
}

// ---- Edit group modal -------------------------------------------------------

function groupEditModal() { return document.getElementById("edit-group-modal"); }

function openGroupEdit(id) {
  const g = GROUPS.find((x) => x.id === id);
  if (!g) return;
  const m = groupEditModal();
  m.querySelector("#eg-name").value = g.name;
  m.querySelector("#eg-desc").value = g.description || "";
  m.querySelector("#eg-group-msg").innerHTML = "";
  m.hidden = false;
  m.querySelector("#eg-name").focus();
}

function closeGroupEdit() { groupEditModal().hidden = true; }

async function applyGroupEdit() {
  const g = GROUPS.find((x) => x.id === GROUP_SELECTED);
  if (!g) return;
  const m = groupEditModal();
  const msg = m.querySelector("#eg-group-msg");
  const name = m.querySelector("#eg-name").value.trim();
  if (!name) { showMsg(msg, "A group name is required", "error"); return; }
  showMsg(msg, "Saving…", "");
  const ok = await saveGroupFields(g,
    { name, description: m.querySelector("#eg-desc").value.trim() }, msg, `Saved ${name}`);
  if (ok) closeGroupEdit();
}

// ---- Duplicate group modal --------------------------------------------------

function groupDuplicateModal() { return document.getElementById("duplicate-group-modal"); }

function openGroupDuplicate(id) {
  const g = GROUPS.find((x) => x.id === id);
  if (!g) return;
  const m = groupDuplicateModal();
  m.querySelector("#dg-name").value = `${g.name} copy`;
  m.querySelector("#dg-intro").textContent =
    `Creates a new group with the same description, ${g.controllers.length} controller${g.controllers.length === 1 ? "" : "s"} and ${g.members.length} member${g.members.length === 1 ? "" : "s"}.`;
  m.querySelector("#dg-msg").innerHTML = "";
  m.hidden = false;
  const input = m.querySelector("#dg-name");
  input.focus();
  input.select();
}

function closeGroupDuplicate() { groupDuplicateModal().hidden = true; }

// applyGroupDuplicate posts a group with no id, which the save endpoint treats
// as a create — so the copy gets its own generated id.
async function applyGroupDuplicate() {
  const g = GROUPS.find((x) => x.id === GROUP_SELECTED);
  if (!g) return;
  const m = groupDuplicateModal();
  const msg = m.querySelector("#dg-msg");
  const name = m.querySelector("#dg-name").value.trim();
  if (!name) { showMsg(msg, "A name for the copy is required", "error"); return; }
  showMsg(msg, "Duplicating…", "");
  const r = await apiFetch("admin/groups", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      description: g.description || "",
      members: g.members,
      controllers: g.controllers,
    }),
  });
  if (!r.ok) { showMsg(msg, await r.text(), "error"); return; }
  const created = await r.json();
  closeGroupDuplicate();
  showMsg(groupsMsg(), `Created ${name} from ${g.name}`, "ok");
  GROUP_SELECTED = created.id || null; // land on the copy
  loadGroups();
}

async function deleteGroup(g) {
  if (!confirm(`Delete the group "${g.name}"? Its controllers lose access to these users. The user accounts themselves are not touched.`)) return;
  const r = await apiFetch("admin/group", {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: g.id }),
  });
  if (!r.ok) { showMsg(groupsMsg(), await r.text(), "error"); return; }
  showMsg(groupsMsg(), `Deleted ${g.name}`, "ok");
  if (GROUP_SELECTED === g.id) GROUP_SELECTED = null;
  loadGroups();
}

async function loadGroups() {
  const body = document.getElementById("groups-body");
  const resp = await apiFetch("admin/groups");
  if (!resp.ok) {
    body.innerHTML = `<tr><td colspan="4" class="muted">${escapeHtml(await resp.text())}</td></tr>`;
    return;
  }
  const d = await resp.json();
  GROUPS = d.groups || [];
  CAND_USERS = d.candidate_users || [];
  CAND_CONTROLLERS = d.candidate_controllers || [];
  GROUP_DIR = d.directory || {};
  if (GROUP_SELECTED && GROUPS.some((g) => g.id === GROUP_SELECTED)) selectGroup(GROUP_SELECTED);
  else { GROUP_SELECTED = null; renderGroupsTable(); renderGroupDetails(); }
}

function openAddGroup() {
  document.getElementById("create-group-msg").innerHTML = "";
  document.getElementById("new-group-name").value = "";
  document.getElementById("new-group-desc").value = "";
  document.getElementById("add-group-modal").hidden = false;
  document.getElementById("new-group-name").focus();
}
function closeAddGroup() { document.getElementById("add-group-modal").hidden = true; }

async function initGroups() {
  if (!(await requireCap("groups.manage"))) return;

  document.getElementById("group-search").addEventListener("input", renderGroupsTable);
  document.getElementById("add-group-btn").addEventListener("click", openAddGroup);
  document.getElementById("add-group-cancel").addEventListener("click", closeAddGroup);
  document.getElementById("add-group-modal").addEventListener("click", (e) => {
    if (e.target.id === "add-group-modal") closeAddGroup();
  });
  // Manage members / controllers.
  document.getElementById("gp-cancel").addEventListener("click", closeGroupPeople);
  groupPeopleModal().addEventListener("click", (e) => {
    if (e.target.id === "group-people-modal") closeGroupPeople();
  });
  document.getElementById("gp-save").addEventListener("click", applyGroupPeople);
  wireGroupPeople();

  // Edit group.
  document.getElementById("eg-group-cancel").addEventListener("click", closeGroupEdit);
  groupEditModal().addEventListener("click", (e) => {
    if (e.target.id === "edit-group-modal") closeGroupEdit();
  });
  document.getElementById("eg-group-save").addEventListener("click", applyGroupEdit);

  // Duplicate group.
  document.getElementById("dg-cancel").addEventListener("click", closeGroupDuplicate);
  groupDuplicateModal().addEventListener("click", (e) => {
    if (e.target.id === "duplicate-group-modal") closeGroupDuplicate();
  });
  document.getElementById("dg-save").addEventListener("click", applyGroupDuplicate);

  // Close the row menu on outside click / scroll / escape.
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#um-row-menu") && !e.target.closest(".um-dots")) closeRowMenu();
  });
  window.addEventListener("scroll", closeRowMenu, true);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeRowMenu();
    closeAddGroup();
    closeGroupPeople();
    closeGroupEdit();
    closeGroupDuplicate();
  });

  const createMsg = document.getElementById("create-group-msg");
  document.getElementById("create-group").addEventListener("click", async () => {
    const name = document.getElementById("new-group-name").value.trim();
    if (!name) { showMsg(createMsg, "Enter a group name", "error"); return; }
    showMsg(createMsg, "Creating…", "");
    const r = await apiFetch("admin/groups", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        description: document.getElementById("new-group-desc").value.trim(),
        members: [], controllers: [],
      }),
    });
    if (!r.ok) { showMsg(createMsg, await r.text(), "error"); return; }
    showMsg(groupsMsg(), `Created ${name}`, "ok");
    closeAddGroup();
    GROUP_SELECTED = (await r.json()).id;
    loadGroups();
  });

  loadGroups();
}

// ---- Own profile (Account page) ---------------------------------------------
// The self-service half of the profile feature: same fields as the admin panel,
// but scoped to the signed-in account via /profile.

async function initOwnProfile(user) {
  const msg = document.getElementById("pf-msg");
  const avatarEl = document.getElementById("pf-avatar");
  const clearBtn = document.getElementById("pf-clear");
  const fileInput = document.getElementById("pf-file");
  let avatar = "";

  // paint keeps the picture, its Remove button and the initials fallback in sync.
  const paint = () => {
    if (avatar) {
      avatarEl.classList.add("has-img");
      avatarEl.innerHTML = `<img src="${escapeHtml(avatar)}" alt="">`;
    } else {
      avatarEl.classList.remove("has-img");
      avatarEl.textContent = initials(user, currentFields());
    }
    clearBtn.hidden = !avatar;
  };
  const currentFields = () => {
    const out = {};
    for (const [key, id] of PROFILE_FIELDS) out[key] = document.getElementById("pf-" + id).value.trim();
    return out;
  };

  try {
    const r = await apiFetch("profile");
    if (r.ok) {
      const d = await r.json();
      const p = d.profile || {};
      for (const [key, id] of PROFILE_FIELDS) document.getElementById("pf-" + id).value = p[key] || "";
      avatar = d.avatar || "";
    }
  } catch (e) { /* leave the form empty */ }
  paint();

  document.getElementById("pf-first").addEventListener("input", paint);
  document.getElementById("pf-last").addEventListener("input", paint);
  document.getElementById("pf-pick").addEventListener("click", async () => {
    try {
      const data = await pickAvatar(fileInput);
      if (!data) return;
      avatar = data;
      paint();
    } catch (e) { showMsg(msg, e.message, "error"); }
  });
  clearBtn.addEventListener("click", () => { avatar = ""; paint(); });

  document.getElementById("pf-save").addEventListener("click", async () => {
    const body = { ...currentFields(), avatar };
    const r = await apiFetch("profile", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) { showMsg(msg, await r.text(), "error"); return; }
    showMsg(msg, "Profile saved", "ok");
    // Reflect the new name/picture in the sidebar without a reload.
    const nameEl = document.getElementById("side-user");
    if (nameEl) nameEl.textContent = displayName(user, currentFields());
    const avEl = document.getElementById("avatar");
    if (avEl) {
      if (avatar) { avEl.classList.add("has-img"); avEl.innerHTML = `<img src="${escapeHtml(avatar)}" alt="">`; }
      else { avEl.classList.remove("has-img"); avEl.textContent = initials(user, currentFields()); }
    }
  });
}

// ---- Tag manager ------------------------------------------------------------

// tagUsage computes, per tag key, how many entries use it and their total time.
function tagUsage() {
  const stats = {};
  for (const r of ALL) {
    const seen = new Set();
    for (const raw of allTagsOf(r.ds)) {
      const k = raw.slice(1).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      if (!stats[k]) stats[k] = { count: 0, sec: 0 };
      stats[k].count++;
      stats[k].sec += recDur(r);
    }
  }
  return stats;
}

function renderTags() {
  const stats = tagUsage();
  // Include tags that only exist as a color definition (no entries yet).
  const keys = new Set(Object.keys(stats));
  for (const k of Object.keys(TAGINFO_RAW)) {
    const info = TAGINFO_RAW[k];
    if (k !== OTHER_KEY && info && (info.color || info.title)) keys.add(k);
  }
  const sorted = Array.from(keys).sort((a, b) => (stats[b]?.sec || 0) - (stats[a]?.sec || 0));
  const host = document.getElementById("tags-manage");
  if (sorted.length === 0) {
    host.innerHTML = '<div class="empty">No tags yet — create one or add #tags to your entries.</div>';
    return;
  }
  host.innerHTML = sorted.map((k) => {
    const color = colorFor(k);
    const st = stats[k];
    const usage = st
      ? `${st.count} ${st.count === 1 ? "entry" : "entries"} · ${fmtHM(st.sec)}`
      : "No entries yet";
    return `<div class="tm-row tm-clickable" data-tag="${escapeHtml(k)}">
      <div class="tm-main">
        <span class="tm-dot" style="background:${color}"></span>
        <span class="tm-chip" style="background:${color}26;color:${color}">${escapeHtml(labelFor(k))}</span>
        <span class="tm-stats">${usage}</span>
      </div>
      <span class="tm-edit">Edit</span>
    </div>`;
  }).join("");

  host.querySelectorAll(".tm-row").forEach((row) =>
    row.addEventListener("click", () => openTagModal(row.dataset.tag)));
}

// ---- Tag editor modal -------------------------------------------------------

let tmEditKey = null;   // tag key being edited, or null when creating
let tmColor = TAG_PRESETS[0];

function renderTagSwatches() {
  const host = document.getElementById("tm-swatches");
  if (!host) return;
  const cur = (tmColor || "").toLowerCase();
  const check = '<span class="chk"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"/></svg></span>';
  host.innerHTML = TAG_PRESETS.map((c) =>
    `<button type="button" class="tm-swatch ${c.toLowerCase() === cur ? "sel" : ""}" style="background:${c}" data-c="${c}" title="${c}">${check}</button>`
  ).join("");
  host.querySelectorAll(".tm-swatch").forEach((b) =>
    b.addEventListener("click", () => selectTagColor(b.dataset.c)));
}

function selectTagColor(hex) {
  tmColor = hex;
  const custom = document.getElementById("tm-custom");
  if (custom) custom.value = hex;
  renderTagSwatches();
}

function openTagModal(key) {
  tmEditKey = key || null;
  tmColor = key ? colorFor(key) : TAG_PRESETS[0];
  document.getElementById("tm-title").textContent = tmEditKey ? "Edit Tag" : "New Tag";
  const name = document.getElementById("tm-name");
  name.value = tmEditKey ? labelFor(tmEditKey) : "";
  document.getElementById("tm-custom").value = tmColor;
  document.getElementById("tm-delete").hidden = !tmEditKey;
  showMsg(document.getElementById("tm-modal-msg"), "", "");
  renderTagSwatches();
  document.getElementById("tag-modal").hidden = false;
  name.focus();
}

function closeTagModal() { document.getElementById("tag-modal").hidden = true; }

function tmError(text) { showMsg(document.getElementById("tm-modal-msg"), text, "error"); }

// renameTag rewrites #oldKey to the new tag in every record that uses it and
// moves the stored color/title to the new key.
async function renameTag(oldKey, newKey, newRaw) {
  const re = new RegExp("#" + oldKey.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&") + "\\b", "gi");
  for (const r of ALL) {
    if (!allTagsOf(r.ds).some((t) => t.slice(1).toLowerCase() === oldKey)) continue;
    // Write the lowercased tag into the description (matching the app / upstream
    // convention); the display casing is kept in the taginfo "title" field.
    const ds = (r.ds || "").replace(re, "#" + newKey);
    const ok = await putRecord({ key: r.key, mt: Math.floor(Date.now() / 1000), t1: r.t1, t2: r.t2, ds });
    if (!ok) return false;
  }
  // Clear the old color definition so it no longer appears on its own.
  await apiFetch("settings", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ key: TAGINFO_PREFIX + oldKey, mt: Math.floor(Date.now() / 1000), value: {} }]),
  });
  delete TAGINFO_RAW[oldKey];
  delete TAGCOLORS[oldKey];
  return true;
}

async function saveTagModal() {
  const raw = document.getElementById("tm-name").value.trim().replace(/^#+/, "");
  const key = normalizeTag(raw);
  if (!key) { tmError("Enter a tag name (letters, numbers, - or _; at least 2 characters)."); return; }

  const usage = tagUsage();
  const renaming = tmEditKey && key !== tmEditKey;
  if ((!tmEditKey || renaming) && (usage[key] || TAGINFO_RAW[key])) {
    tmError("A tag with that name already exists."); return;
  }

  if (renaming) {
    const ok = await renameTag(tmEditKey, key, raw);
    if (!ok) { tmError("Failed to rename tag."); return; }
  }

  // Save the color plus the display title, preserving any other taginfo fields.
  const info = Object.assign({}, TAGINFO_RAW[key] || {}, { color: tmColor, title: raw });
  const resp = await apiFetch("settings", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ key: TAGINFO_PREFIX + key, mt: Math.floor(Date.now() / 1000), value: info }]),
  });
  if (!resp.ok) { tmError("Failed to save."); return; }
  TAGINFO_RAW[key] = info;
  TAGCOLORS[key] = tmColor;

  closeTagModal();
  showMsg(document.getElementById("tags-msg"), tmEditKey ? "Tag updated" : "Tag created", "ok");
  await loadAll();
  renderTags();
}

async function deleteTagModal() {
  if (!tmEditKey) return;
  const st = tagUsage()[tmEditKey];
  const warn = st
    ? `Delete the tag "${labelFor(tmEditKey)}"? It will be removed from ${st.count} ${st.count === 1 ? "entry" : "entries"} (the entries themselves are kept).`
    : `Delete the tag "${labelFor(tmEditKey)}"?`;
  if (!confirm(warn)) return;

  // Strip the #tag token from every record that uses it.
  const re = new RegExp("#" + tmEditKey.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&") + "\\b", "gi");
  for (const r of ALL) {
    if (!allTagsOf(r.ds).some((t) => t.slice(1).toLowerCase() === tmEditKey)) continue;
    const ds = (r.ds || "").replace(re, "").replace(/\s{2,}/g, " ").trim();
    const ok = await putRecord({ key: r.key, mt: Math.floor(Date.now() / 1000), t1: r.t1, t2: r.t2, ds });
    if (!ok) { tmError("Failed to delete."); return; }
  }

  // Clear the stored color/title so the tag disappears entirely.
  const resp = await apiFetch("settings", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ key: TAGINFO_PREFIX + tmEditKey, mt: Math.floor(Date.now() / 1000), value: {} }]),
  });
  if (!resp.ok) { tmError("Failed to delete."); return; }
  delete TAGINFO_RAW[tmEditKey];
  delete TAGCOLORS[tmEditKey];

  closeTagModal();
  showMsg(document.getElementById("tags-msg"), "Tag deleted", "ok");
  await loadAll();
  renderTags();
}

function wireTagModal() {
  document.getElementById("tag-new").addEventListener("click", () => openTagModal(null));
  document.getElementById("tm-cancel").addEventListener("click", closeTagModal);
  document.getElementById("tm-save").addEventListener("click", saveTagModal);
  document.getElementById("tm-delete").addEventListener("click", deleteTagModal);
  document.getElementById("tm-custom").addEventListener("input", (e) => selectTagColor(e.target.value));
  document.getElementById("tm-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveTagModal(); }
  });
  document.getElementById("tag-modal").addEventListener("click", (e) => {
    if (e.target.id === "tag-modal") closeTagModal();
  });
}

// ---- Bulk add tags ----------------------------------------------------------
// Accepts one tag per line ("name #hexcolor", comma also works) or an uploaded
// CSV, and upserts each as a taginfo setting in a single batch.

// normHexColor normalizes "#abc", "abc", "#aabbcc", "AABBCC" → "#aabbcc", else null.
function normHexColor(s) {
  s = (s || "").trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.split("").map((c) => c + c).join("");
  return /^[0-9a-fA-F]{6}$/.test(s) ? "#" + s.toLowerCase() : null;
}

// parseBulkTagLine splits a line into { name, color }. The color may be after a
// comma/semicolon/tab, or a trailing hex token separated by whitespace.
function parseBulkTagLine(line) {
  line = line.trim();
  if (!line) return null;
  const delim = line.split(/[,;\t]/).map((s) => s.trim()).filter((s) => s.length);
  if (delim.length >= 2) return { name: delim[0], color: delim[1] };
  const toks = line.split(/\s+/);
  const last = toks[toks.length - 1];
  // A trailing token that is a hex color, or starts with "#", is the color field
  // (so an invalid "#zzz" is reported rather than folded into the name).
  if (toks.length >= 2 && (normHexColor(last) || /^#/.test(last))) {
    return { name: toks.slice(0, -1).join(" "), color: last };
  }
  return { name: line, color: "" };
}

function bulkLog(html, cls, reset) {
  const el = document.getElementById("bulk-log");
  if (reset) el.innerHTML = "";
  el.innerHTML += `<div class="${cls || ""}">${html}</div>`;
}

async function bulkAddTags() {
  const lines = document.getElementById("bulk-input").value.split(/\r?\n/);
  const usage = tagUsage();
  const now = Math.floor(Date.now() / 1000);
  const settings = [];
  const applied = [];      // {key, info}
  const seen = new Set();
  let created = 0, updated = 0, invalid = 0, presetIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    const parsed = parseBulkTagLine(lines[i]);
    if (!parsed) continue;
    const key = normalizeTag(parsed.name);

    // Skip an optional header row like "name,color".
    if (i === 0 && parsed.color && !normHexColor(parsed.color) &&
        /^(tag|tags|name|label)$/i.test(parsed.name.trim())) continue;

    if (!key) { invalid++; bulkLog(`✗ ${escapeHtml(parsed.name || lines[i].trim())} — invalid name`, "err"); continue; }
    let hex = parsed.color ? normHexColor(parsed.color) : null;
    if (parsed.color && !hex) { invalid++; bulkLog(`✗ ${escapeHtml(parsed.name)} — invalid color “${escapeHtml(parsed.color)}”`, "err"); continue; }
    if (!hex) hex = TAG_PRESETS[presetIdx++ % TAG_PRESETS.length];
    if (seen.has(key)) continue; // de-dupe within the batch
    seen.add(key);

    const exists = !!TAGINFO_RAW[key] || !!usage[key];
    const info = Object.assign({}, TAGINFO_RAW[key] || {}, { color: hex, title: parsed.name.trim() });
    settings.push({ key: TAGINFO_PREFIX + key, mt: now, value: info });
    applied.push({ key, info });
    if (exists) updated++; else created++;
  }

  if (!settings.length) { bulkLog("No valid tags found.", "err", invalid === 0); return; }

  const btn = document.getElementById("bulk-add");
  btn.disabled = true;
  try {
    const resp = await apiFetch("settings", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings),
    });
    if (!resp.ok) throw new Error("http " + resp.status);
    for (const a of applied) { TAGINFO_RAW[a.key] = a.info; TAGCOLORS[a.key] = a.info.color; }
    bulkLog(`Added <b>${created}</b> new tag${created === 1 ? "" : "s"}${updated ? `, updated <b>${updated}</b>` : ""}${invalid ? `, skipped ${invalid}` : ""}.`, "ok");
    document.getElementById("bulk-input").value = "";
    renderTags();
  } catch (e) {
    bulkLog("Failed to save: " + escapeHtml(String((e && e.message) || e)), "err");
  } finally {
    btn.disabled = false;
  }
}

function readBulkTagFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (["xls", "xlsx", "xlsm", "pdf"].includes(ext)) {
    bulkLog(`Cannot read <u>${escapeHtml(file.name)}</u>. Use a .csv or plain-text file.`, "err", true);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => { document.getElementById("bulk-input").value = reader.result; bulkLog(`Loaded <u>${escapeHtml(file.name)}</u> — review, then click Add tags.`, "", true); };
  reader.readAsText(file);
}

function wireBulkTags() {
  document.getElementById("bulk-add").addEventListener("click", bulkAddTags);
  const fileInput = document.getElementById("bulk-file");
  document.getElementById("bulk-drop-hint").addEventListener("click", (e) => { e.preventDefault(); fileInput.click(); });
  fileInput.addEventListener("change", () => { if (fileInput.files[0]) readBulkTagFile(fileInput.files[0]); });
  const drop = document.getElementById("bulk-drop");
  const ta = document.getElementById("bulk-input");
  ["dragover", "dragenter"].forEach((ev) => ta.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "dragend"].forEach((ev) => ta.addEventListener(ev, () => drop.classList.remove("drag")));
  ta.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("drag"); const f = e.dataTransfer.files[0]; if (f) readBulkTagFile(f); });
}

async function initTags() {
  await loadSettings();
  try { await loadAll(); } catch (e) { return; }
  wireTagModal();
  wireBulkTags();
  renderTags();
}

// ---- Dispatch ---------------------------------------------------------------

// ---- Import / Export --------------------------------------------------------
// Export writes all records to a downloadable CSV (filename entered by the user).
// Import parses pasted or dropped CSV/TSV data following the TimeTagger import
// format (https://timetagger.app/articles/importing/): tab/comma/semicolon are
// auto-detected, and the columns key/tags/start/stop/description/date/duration
// (with aliases) are recognized.

const IE_HEADER_ALIASES = {
  key: "key", id: "key", identifier: "key",
  tag: "tags", tags: "tags", project: "tags", pr: "tags", proj: "tags", "project name": "tags", projectname: "tags",
  start: "t1", begin: "t1", "start time": "t1", "begin time": "t1",
  stop: "t2", end: "t2", "stop time": "t2", "end time": "t2",
  description: "description", ds: "description", comment: "description", title: "description", summary: "description",
  date: "date",
  duration: "duration", "duration hh:mm": "duration", "duration hh:mm:ss": "duration",
};
const YEAR_EPOCH = 31536000; // used to tell a real timestamp from an hh:mm value

function fmtLocalDT(epoch) {
  const d = new Date(epoch * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// --- Export ---
function exportDefaultName() { const d = new Date(); return `tagged-export-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; }
function exportFilename() {
  let n = (document.getElementById("ie-filename").value || "").trim().replace(/[\/\\:*?"<>|]+/g, "").trim();
  if (!n) n = exportDefaultName();
  return n.replace(/\.(csv|tsv|txt)$/i, "") + ".csv";
}
function exportBuildRows() {
  const mode = document.getElementById("ie-format").value;
  const fdt = (e) => (mode === "unix" ? String(e) : mode === "iso" ? new Date(e * 1000).toISOString() : fmtLocalDT(e));
  const rows = [["key", "start", "stop", "tags", "description"]];
  for (const r of ALL.slice().sort((a, b) => a.t1 - b.t1)) {
    rows.push([r.key, fdt(r.t1), fdt(r.t2), allTagsOf(r.ds).join(" "), (r.ds || "").replace(/[\t\r\n]+/g, " ").trim()]);
  }
  return rows;
}
function ieExportMsg(text, ok) {
  const el = document.getElementById("ie-export-msg");
  el.textContent = text || "";
  el.classList.toggle("ok", !!ok);
}
function exportDownloadCSV() {
  const rows = exportBuildRows();
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const name = exportFilename();
  downloadBlob(csv, name, "text/csv");
  ieExportMsg(`Saved ${name} · ${rows.length - 1} records`, true);
}
function exportCopyTable() {
  const rows = exportBuildRows();
  const tsv = rows.map((row) => row.join("\t")).join("\n");
  const done = () => ieExportMsg(`Copied ${rows.length - 1} records.`, true);
  const fail = () => ieExportMsg("Copy failed.", false);
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(tsv).then(done, fail);
  else fail();
}

// --- Import parsing ---
// parseDelimited turns CSV/TSV text into rows of fields, honoring double-quote
// wrapping ("" escapes an inner quote) and quoted newlines.
function parseDelimited(text, sep) {
  const rows = [];
  let row = [], field = "", inQ = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === sep) { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function detectSep(headerLine) {
  let best = null, bestN = 0;
  for (const s of ["\t", ",", ";"]) { const n = headerLine.split(s).length - 1; if (n > bestN) { bestN = n; best = s; } }
  return best;
}
function parseImportDate(d) {
  d = (d || "").trim().replace(/\./g, "-");
  const p = d.split("-");
  if (d.length === 10 && p.length === 3 && p[2].length === 4) return `${p[2]}-${p[1]}-${p[0]}`; // dd-mm-yyyy → yyyy-mm-dd
  return d;
}
function isTimeOnly(s) { return /^\d{1,2}[:.]\d{2}([:.]\d{2})?$/.test((s || "").trim()); }
function normalizeTimePart(s) {
  const p = (s || "").trim().replace(/\./g, ":").split(":");
  return `${pad(Number(p[0]))}:${pad(Number(p[1]))}:${pad(Number(p[2] || 0))}`;
}
function parseImportTime(s) {
  s = (s || "").trim();
  if (!s) return NaN;
  const num = Number(s);
  if (isFinite(num) && Math.abs(num) > YEAR_EPOCH) return Math.floor(num); // unix seconds
  const ms = Date.parse(s);
  return isFinite(ms) ? Math.floor(ms / 1000) : NaN;
}
function combineImportDateTime(dateStr, timeStr) {
  const ms = Date.parse(`${dateStr}T${normalizeTimePart(timeStr)}`);
  return isFinite(ms) ? Math.floor(ms / 1000) : NaN;
}
function parseImportDuration(s) {
  s = (s || "").trim();
  if (!s) return NaN;
  if (s.includes(":")) {
    const p = s.split(":").map(Number);
    if (p.length === 2) return p[0] * 3600 + p[1] * 60;
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  }
  const n = Number(s);
  return isFinite(n) ? n : NaN;
}

let IMP_RECORDS = [];

function importLog(html, cls, reset) {
  const el = document.getElementById("ie-log");
  if (reset) el.innerHTML = "";
  el.innerHTML += `<div class="${cls || ""}">${html}</div>`;
}

function importAnalyse() {
  IMP_RECORDS = [];
  const importBtn = document.getElementById("ie-import");
  importBtn.disabled = true;
  importBtn.textContent = "Import";

  const raw = document.getElementById("ie-input").value.replace(/^\s+/, "");
  const nl = raw.indexOf("\n");
  if (nl < 0) { importLog("No data to import.", "err", true); return; }
  const headerLine = raw.slice(0, nl).trim();
  const body = raw.slice(nl + 1);

  const sep = detectSep(headerLine);
  if (!sep) { importLog("Could not determine the separator (tried tab, comma, semicolon).", "err", true); return; }
  const sepName = sep === "\t" ? "tab" : sep === "," ? "comma" : "semicolon";
  importLog(`Separator looks like a ${sepName}.`, "", true);

  const headerFields = parseDelimited(headerLine, sep)[0] || [];
  const cols = [];
  const unknown = [];
  for (const name of headerFields) {
    const norm = name.toLowerCase().replace(/[-_]/g, " ").trim();
    if (norm in IE_HEADER_ALIASES) cols.push(IE_HEADER_ALIASES[norm]);
    else { if (norm) unknown.push(name); cols.push(null); }
  }
  importLog(unknown.length ? `Ignoring unrecognized columns: ${escapeHtml(unknown.join(", "))}` : "All column names recognized.");

  if (!cols.includes("t1")) { importLog("Missing a required <b>start</b> column.", "err"); return; }
  if (!cols.includes("t2") && !cols.includes("duration")) { importLog("Missing a required <b>stop</b> or <b>duration</b> column.", "err"); return; }

  const timemap = {};
  const existingKeys = new Set();
  for (const r of ALL) { timemap[`${r.t1}_${r.t2}`] = r.key; existingKeys.add(r.key); }

  const dataRows = parseDelimited(body, sep);
  const records = [];
  let newCount = 0;
  for (let ri = 0; ri < dataRows.length; ri++) {
    const fields = dataRows[ri];
    if (fields.join("").trim() === "") continue; // skip blank rows
    const rowNo = ri + 2; // 1-based incl. header

    const rawObj = {};
    for (let j = 0; j < Math.min(fields.length, cols.length); j++) {
      if (cols[j]) rawObj[cols[j]] = (fields[j] || "").trim();
    }
    const dateOk = rawObj.date ? parseImportDate(rawObj.date) : "";

    let t1 = parseImportTime(rawObj.t1);
    if (!isFinite(t1) && dateOk && isTimeOnly(rawObj.t1)) t1 = combineImportDateTime(dateOk, rawObj.t1);

    let t2 = parseImportTime(rawObj.t2);
    if (!isFinite(t2) && rawObj.duration) { const dur = parseImportDuration(rawObj.duration); if (isFinite(dur) && isFinite(t1)) t2 = t1 + dur; }
    if (!isFinite(t2) && dateOk && isTimeOnly(rawObj.t2)) t2 = combineImportDateTime(dateOk, rawObj.t2);

    if (!isFinite(t1) || !isFinite(t2)) { importLog(`Row ${rowNo}: could not parse the start/stop time — stopping.`, "err"); return; }
    t1 = Math.floor(t1); t2 = Math.max(Math.ceil(t2), t1 + 1);

    // Collect tags from the tags column and from any inline #tags in description.
    const tagKeys = [];
    if (rawObj.tags) for (const part of rawObj.tags.split(/[\s,]+/)) { const k = normalizeTag(part); if (k) tagKeys.push(k); }
    const descRaw = (rawObj.description || "").replace(/[\t\r\n]+/g, " ");
    for (const t of allTagsOf(descRaw)) tagKeys.push(t.slice(1).toLowerCase());
    const uniqTags = Array.from(new Set(tagKeys));
    const textOnly = descRaw.replace(RE_TAG_G, "").replace(/\s+/g, " ").trim();
    const ds = (uniqTags.map((t) => "#" + t).join(" ") + (textOnly ? " " + textOnly : "")).trim();

    let key = (rawObj.key || "").trim();
    if (!key) key = timemap[`${t1}_${t2}`] || randomKey();
    if (!existingKeys.has(key)) newCount++;

    records.push({ key, t1, t2, ds });
  }

  IMP_RECORDS = records;
  if (!records.length) { importLog("No records found.", "err"); return; }
  importLog(`Found <b>${records.length}</b> records (${newCount} new, ${records.length - newCount} updates).`, "ok");
  importBtn.disabled = false;
}

async function importDoImport() {
  if (!IMP_RECORDS.length) return;
  const importBtn = document.getElementById("ie-import");
  importBtn.disabled = true;
  importBtn.textContent = "Importing…";
  const now = Math.floor(Date.now() / 1000);
  const payload = IMP_RECORDS.map((r) => ({ key: r.key, mt: now, t1: r.t1, t2: r.t2, ds: r.ds }));
  try {
    const resp = await apiFetch("records", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!resp.ok) throw new Error("http " + resp.status);
    const res = await resp.json();
    const n = (res.accepted || payload).length;
    importLog(`Imported <b>${n}</b> records.`, "ok");
    importBtn.textContent = "Import done";
    IMP_RECORDS = [];
    await loadAll();
  } catch (e) {
    importLog("Import failed: " + escapeHtml(String(e && e.message || e)), "err");
    importBtn.textContent = "Import";
    importBtn.disabled = false;
  }
}

function readImportFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (["xls", "xlsx", "xlsm", "pdf"].includes(ext)) {
    importLog(`Cannot read <u>${escapeHtml(file.name)}</u>. Export it as CSV first, or paste the columns here.`, "err", true);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => { document.getElementById("ie-input").value = reader.result; importLog(`Loaded <u>${escapeHtml(file.name)}</u> — click Analyse.`, "", true); };
  reader.readAsText(file);
}

async function initImpExp() {
  await loadSettings();
  try { await loadAll(); } catch (e) { return; }
  document.getElementById("ie-filename").value = exportDefaultName();
  document.getElementById("ie-download").addEventListener("click", exportDownloadCSV);
  document.getElementById("ie-copy").addEventListener("click", exportCopyTable);

  const fileInput = document.getElementById("ie-file");
  document.getElementById("ie-drop-hint").addEventListener("click", (e) => { e.preventDefault(); fileInput.click(); });
  fileInput.addEventListener("change", () => { if (fileInput.files[0]) readImportFile(fileInput.files[0]); });

  const drop = document.getElementById("ie-drop");
  const ta = document.getElementById("ie-input");
  ["dragover", "dragenter"].forEach((ev) => ta.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "dragend"].forEach((ev) => ta.addEventListener(ev, () => drop.classList.remove("drag")));
  ta.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("drag"); const f = e.dataTransfer.files[0]; if (f) readImportFile(f); });

  document.getElementById("ie-analyse").addEventListener("click", importAnalyse);
  document.getElementById("ie-import").addEventListener("click", importDoImport);
}

// ---- About ------------------------------------------------------------------

function fmtBuildDate(s) {
  if (!s) return "unknown";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

async function initAbout() {
  const depsHost = document.getElementById("ab-deps");
  try {
    const resp = await apiFetch("about");
    if (!resp.ok) throw new Error("http " + resp.status);
    const d = await resp.json();
    document.getElementById("ab-version").textContent = d.version || "—";
    document.getElementById("ab-build").textContent = fmtBuildDate(d.build_date);
    document.getElementById("ab-go").textContent = d.go_version || "—";
    if (d.revision) {
      document.getElementById("ab-rev").textContent = d.revision.slice(0, 12);
      document.getElementById("ab-rev-row").hidden = false;
    }
    if (d.repo_url) document.getElementById("ab-repo").href = d.repo_url;

    const deps = d.dependencies || [];
    depsHost.innerHTML = deps.length
      ? deps.map((x) => `
        <div class="dep-row">
          <div class="dep-info">
            <div class="dep-name">${escapeHtml(x.name || x.path)}</div>
            <div class="dep-path">${escapeHtml(x.path)}${x.version ? " " + escapeHtml(x.version) : ""}</div>
            ${x.description ? `<div class="dep-desc">${escapeHtml(x.description)}</div>` : ""}
          </div>
          ${x.license ? `<span class="lic-badge">${escapeHtml(x.license)}</span>` : ""}
        </div>`).join("")
      : '<div class="hint">No dependency information available.</div>';
  } catch (e) {
    depsHost.innerHTML = '<div class="hint">Could not load about information.</div>';
  }
}

// ---- Admin · Servers --------------------------------------------------------

// initServers wires the server-settings page: currently the self-registration
// switch. Non-admins are redirected (the API also enforces admin access).
async function initServers() {
  try {
    const who = await apiFetch("whoami");
    if (who.ok && !(await who.json()).is_admin) { location.href = PREFIX; return; }
  } catch (e) { return; }

  const toggle = document.getElementById("reg-toggle");
  const msg = document.getElementById("servers-msg");
  try {
    const r = await apiFetch("admin/server");
    if (!r.ok) { showMsg(msg, "Could not load server settings", "error"); return; }
    const d = await r.json();
    toggle.checked = !!d.registration_open;
    toggle.disabled = false;
  } catch (e) { showMsg(msg, "Could not load server settings", "error"); return; }

  toggle.addEventListener("change", async () => {
    const open = toggle.checked;
    toggle.disabled = true;
    showMsg(msg, "Saving…", "");
    try {
      const r = await apiFetch("admin/server", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registration_open: open }),
      });
      if (!r.ok) { throw new Error(await r.text()); }
      showMsg(msg, open ? "Registration enabled" : "Registration disabled", "ok");
    } catch (e) {
      toggle.checked = !open; // revert on failure
      showMsg(msg, "Could not save: " + (e.message || "error"), "error");
    } finally {
      toggle.disabled = false;
    }
  });

  loadModules();
}

// ---- Modules ----------------------------------------------------------------
// Optional pages (Shifts, Skills) an operator switches on per server. The server
// is the source of truth: a module that is off has no page and no nav entry.

async function loadModules() {
  const host = document.getElementById("modules-list");
  const msg = document.getElementById("modules-msg");
  if (!host) return;
  let mods;
  try {
    const r = await apiFetch("admin/server");
    if (!r.ok) throw new Error(await r.text());
    mods = (await r.json()).modules || [];
  } catch (e) {
    host.textContent = "Could not load modules";
    return;
  }
  if (!mods.length) { host.textContent = "No optional modules on this server."; return; }
  host.classList.remove("muted");
  host.innerHTML = mods.map((m) => `
    <label class="setting-row" for="mod-${escapeHtml(m.key)}">
      <span class="setting-label">
        <strong>${escapeHtml(m.label)}</strong>
        <span class="muted">${escapeHtml(m.desc)}</span>
      </span>
      <span class="toggle">
        <input type="checkbox" id="mod-${escapeHtml(m.key)}" data-mod="${escapeHtml(m.key)}" ${m.enabled ? "checked" : ""}>
        <span class="slider"></span>
      </span>
    </label>`).join("");

  host.querySelectorAll("input[data-mod]").forEach((t) => t.addEventListener("change", async () => {
    const key = t.dataset.mod, on = t.checked;
    t.disabled = true;
    showMsg(msg, "Saving…", "");
    try {
      const r = await apiFetch("admin/server", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ module: key, enabled: on }),
      });
      if (!r.ok) throw new Error(await r.text());
      // The nav is built from whoami, so it only picks this up on the next page
      // load -- say so rather than leaving the operator wondering.
      showMsg(msg, `${key} module ${on ? "enabled" : "disabled"}. Reload to update the menu.`, "ok");
    } catch (e) {
      t.checked = !on; // revert on failure
      showMsg(msg, "Could not save: " + (e.message || "error"), "error");
    } finally {
      t.disabled = false;
    }
  }));
}

// initOAuth guards the placeholder OAuth page; nothing to load yet.
// OAuth provider presets: sensible endpoint defaults so admins only fill in the
// client id/secret.
const OAUTH_PRESETS = {
  google: {
    id: "google", name: "Google", enabled: true,
    auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
    token_url: "https://oauth2.googleapis.com/token",
    userinfo_url: "https://openidconnect.googleapis.com/v1/userinfo",
    scopes: "openid email profile", username_field: "email",
  },
  github: {
    id: "github", name: "GitHub", enabled: true,
    auth_url: "https://github.com/login/oauth/authorize",
    token_url: "https://github.com/login/oauth/access_token",
    userinfo_url: "https://api.github.com/user",
    // GitHub's "email" can be null for private profiles; "login" is always present.
    scopes: "read:user", username_field: "login",
  },
  custom: { id: "", name: "", enabled: false, username_field: "email" },
};

const OAUTH_FIELDS = [
  { key: "name", label: "Display name", ph: "Google", type: "text" },
  { key: "id", label: "Provider id (used in the redirect URL)", ph: "google", type: "text" },
  { key: "client_id", label: "Client ID", ph: "", type: "text" },
  { key: "client_secret", label: "Client secret", ph: "", type: "password" },
  { key: "auth_url", label: "Authorization URL", ph: "https://…/authorize", type: "text" },
  { key: "token_url", label: "Token URL", ph: "https://…/token", type: "text" },
  { key: "userinfo_url", label: "Userinfo URL", ph: "https://…/userinfo", type: "text" },
  { key: "scopes", label: "Scopes (space-separated)", ph: "openid email profile", type: "text" },
  { key: "username_field", label: "Username claim (comma-separated fallbacks)", ph: "email,login", type: "text" },
];

async function initOAuth() {
  try {
    const who = await apiFetch("whoami");
    if (who.ok && !(await who.json()).is_admin) { location.href = PREFIX; return; }
  } catch (e) { return; }

  const list = document.getElementById("oauth-list");
  const empty = document.getElementById("oauth-empty");
  const msg = document.getElementById("oauth-msg");
  const base = document.getElementById("oauth-callback-base");

  function refreshEmpty() { empty.hidden = list.children.length > 0; }

  // Build one editable provider card from a provider object.
  function addCard(p) {
    p = p || {};
    const card = document.createElement("div");
    card.className = "oauth-card";
    const head = document.createElement("div");
    head.className = "oauth-card-head";
    const en = document.createElement("label");
    en.className = "oauth-enabled";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.dataset.key = "enabled"; cb.checked = !!p.enabled;
    en.appendChild(cb); en.appendChild(document.createTextNode(" Enabled"));
    const rm = document.createElement("button");
    rm.type = "button"; rm.className = "link danger-btn"; rm.textContent = "Remove";
    rm.addEventListener("click", () => { card.remove(); refreshEmpty(); });
    head.appendChild(en); head.appendChild(rm);
    card.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "oauth-grid";
    for (const f of OAUTH_FIELDS) {
      const wrap = document.createElement("div");
      const lab = document.createElement("label");
      lab.textContent = f.label;
      const inp = document.createElement("input");
      inp.type = f.type; inp.dataset.key = f.key; inp.placeholder = f.ph;
      inp.value = p[f.key] != null ? p[f.key] : "";
      if (f.key === "client_secret") inp.autocomplete = "new-password";
      wrap.appendChild(lab); wrap.appendChild(inp);
      grid.appendChild(wrap);
    }
    card.appendChild(grid);
    list.appendChild(card);
    refreshEmpty();
  }

  // Collect all cards back into a providers array.
  function collect() {
    return Array.from(list.querySelectorAll(".oauth-card")).map((card) => {
      const o = {};
      card.querySelectorAll("[data-key]").forEach((el) => {
        o[el.dataset.key] = el.type === "checkbox" ? el.checked : el.value.trim();
      });
      return o;
    });
  }

  // Load current config.
  try {
    const r = await apiFetch("admin/oauth");
    if (!r.ok) { showMsg(msg, "Could not load OAuth settings", "error"); return; }
    const d = await r.json();
    if (base) base.textContent = d.callback_base || "";
    (d.providers || []).forEach(addCard);
    refreshEmpty();
  } catch (e) { showMsg(msg, "Could not load OAuth settings", "error"); return; }

  document.getElementById("oauth-add-google").addEventListener("click", () => addCard({ ...OAUTH_PRESETS.google }));
  document.getElementById("oauth-add-github").addEventListener("click", () => addCard({ ...OAUTH_PRESETS.github }));
  document.getElementById("oauth-add-custom").addEventListener("click", () => addCard({ ...OAUTH_PRESETS.custom }));

  document.getElementById("oauth-save").addEventListener("click", async () => {
    showMsg(msg, "Saving…", "");
    try {
      const r = await apiFetch("admin/oauth", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers: collect() }),
      });
      if (!r.ok) { showMsg(msg, (await r.text()) || "Save failed", "error"); return; }
      showMsg(msg, "Saved. Enabled providers now appear on the login page.", "ok");
    } catch (e) { showMsg(msg, "Network error", "error"); }
  });
}

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
// A week grid of planned shifts, grouped by the groups the viewer controls. This
// is the design pass: the page renders from the SAMPLE_* fixtures below and every
// edit stays in memory. Wiring replaces buildSampleWeek/loadShifts with the API
// and leaves the render functions as they are.

// SHIFT_KINDS is the catalog: one hue and one canonical window per kind. `open`
// is a slot nobody is assigned to yet; `absence` is time the member is away.
const SHIFT_KINDS = [
  { key: "morning", label: "Morning", window: "06:00 – 14:00", color: "var(--sh-morning)" },
  { key: "day", label: "Day", window: "08:00 – 16:00", color: "var(--sh-day)" },
  { key: "evening", label: "Evening", window: "13:00 – 21:00", color: "var(--sh-evening)" },
  { key: "night", label: "Night", window: "22:00 – 06:00", color: "var(--sh-night)" },
  { key: "open", label: "Open shift", window: "unassigned", color: "var(--sh-open)" },
  { key: "absence", label: "Absence", window: "away", color: "var(--sh-absence)" },
];
function kindDef(key) { return SHIFT_KINDS.find((k) => k.key === key) || SHIFT_KINDS[1]; }

// Sample groups. Each member carries a profile in the shape the profile API
// returns, so wiring only has to swap the fixture for GET admin/groups plus the
// members' profiles -- the render path already reads them the way every other
// page does. `pattern` is design-only: it seeds a plausible week.
const SAMPLE_GROUPS = [
  { id: "support", name: "Support", members: [
    { username: "alice", profile: { first_name: "Alice", last_name: "Johnson", job: "Support Lead" }, pattern: { start: "09:00", end: "17:00", kind: "evening", days: [1, 2, 3, 4, 5] } },
    { username: "bob", profile: { first_name: "Bob", last_name: "Martin", job: "Support Agent" }, pattern: { start: "13:00", end: "21:00", kind: "evening", days: [1, 2, 3, 5] } },
    { username: "charlie", profile: { first_name: "Charlie", last_name: "Davis", job: "Support Agent" }, pattern: { start: "17:00", end: "01:00", kind: "night", days: [3, 4, 5] } },
  ] },
  { id: "development", name: "Development", members: [
    { username: "diana", profile: { first_name: "Diana", last_name: "Prince", job: "Developer" }, pattern: { start: "08:00", end: "16:00", kind: "day", days: [1, 2, 3, 4, 5] } },
    { username: "ethan", profile: { first_name: "Ethan", last_name: "Hunt", job: "Developer" }, pattern: { start: "08:00", end: "16:00", kind: "day", days: [1, 3, 5] } },
    { username: "fiona", profile: { first_name: "Fiona", last_name: "Gallagher", job: "QA Engineer" }, pattern: { start: "10:00", end: "18:00", kind: "day", days: [1, 2, 3, 4, 5] } },
  ] },
  { id: "operations", name: "Operations", members: [
    { username: "george", profile: { first_name: "George", last_name: "Miller", job: "Ops Lead" }, pattern: { start: "06:00", end: "14:00", kind: "morning", days: [1, 2, 3, 4, 5] } },
    { username: "hannah", profile: { first_name: "Hannah", last_name: "Lee", job: "Ops Engineer" }, pattern: { start: "14:00", end: "22:00", kind: "evening", days: [1, 2, 3, 4, 5] } },
    { username: "ian", profile: { first_name: "Ian", last_name: "Wright", job: "Ops Engineer" }, pattern: { start: "22:00", end: "06:00", kind: "night", days: [1, 2, 3, 4, 5] } },
  ] },
];

let PL_GROUPS = [];
let PL_SHIFTS = [];              // {id, group, user (null = open), date, start, end, kind, note}
let PL_WEEK = null;              // Date: midnight of the displayed week's first day
let PL_CAL = null;               // Date: first of the month the mini calendar shows
let PL_SEL = null;               // id of the selected shift
let PL_COLLAPSED = new Set();    // group ids collapsed in the grid
let PL_SEEDED = new Set();       // sample weeks already generated
let PL_TAB = "schedule";
let PL_SEQ = 0;
let PL_EDIT = null;              // {id} when editing, {date, user, group} when creating

function shiftsMsg() { return document.getElementById("shifts-msg"); }
function plId() { return "s" + (++PL_SEQ); }
function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function plDays() { return Array.from({ length: 7 }, (_, i) => addDays(PL_WEEK, i)); }

// shiftMinutes returns a shift's length, treating an end at or before the start
// as running past midnight (a 22:00 – 06:00 night is 8h, not -16h).
function shiftMinutes(s) {
  if (s.kind === "absence") return 0;
  const [sh, sm] = s.start.split(":").map(Number);
  const [eh, em] = s.end.split(":").map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60;
  return mins;
}
function plTotalMins(list) { return list.reduce((a, s) => a + shiftMinutes(s), 0); }
function weekShifts() {
  const from = ymd(PL_WEEK), to = ymd(addDays(PL_WEEK, 6));
  return PL_SHIFTS.filter((s) => s.date >= from && s.date <= to);
}
function groupOf(id) { return PL_GROUPS.find((g) => g.id === id); }
function memberOf(username) {
  for (const g of PL_GROUPS) {
    const m = g.members.find((x) => x.username === username);
    if (m) return m;
  }
  return null;
}
// Members are presented like everywhere else: their profile name if they have
// one, otherwise the username they log in with.
function plMemberName(m) { return displayName(m.username, m.profile); }
function plMemberInitials(m) { return initials(m.username, m.profile); }
function plName(username) { const m = memberOf(username); return m ? plMemberName(m) : username; }

// buildSampleWeek fills a week from each member's pattern, plus a couple of open
// shifts and one absence so every state in the legend is visible. Design-only.
function buildSampleWeek(weekStart) {
  const key = ymd(weekStart);
  if (PL_SEEDED.has(key)) return;
  PL_SEEDED.add(key);
  for (const g of PL_GROUPS) {
    for (const m of g.members) {
      for (let i = 0; i < 7; i++) {
        const d = addDays(weekStart, i);
        if (!m.pattern.days.includes(d.getDay())) continue;
        PL_SHIFTS.push({
          id: plId(), group: g.id, user: m.username, date: ymd(d),
          start: m.pattern.start, end: m.pattern.end, kind: m.pattern.kind, note: "",
        });
      }
    }
  }
  const sat = addDays(weekStart, 5);
  PL_SHIFTS.push({ id: plId(), group: "support", user: null, date: ymd(sat), start: "10:00", end: "18:00", kind: "open", note: "Weekend cover" });
  const thu = addDays(weekStart, 3);
  PL_SHIFTS.push({ id: plId(), group: "development", user: "ethan", date: ymd(thu), start: "00:00", end: "00:00", kind: "absence", note: "Paid leave" });
}

function renderPlTiles() {
  const list = weekShifts();
  const assigned = list.filter((s) => s.user && s.kind !== "absence");
  const open = list.filter((s) => s.kind === "open");
  const absences = list.filter((s) => s.kind === "absence");
  const total = plTotalMins(assigned);
  // Contracted week = 40h per member; anything above it is the overtime estimate.
  const members = PL_GROUPS.reduce((a, g) => a + g.members.length, 0);
  const contracted = members * 40 * 60;
  const over = Math.max(0, total - contracted);
  const covered = list.length ? Math.round(((list.length - open.length) / list.length) * 100) : 100;
  const tiles = [
    { k: "Total scheduled", v: fmtHM(total * 60), sub: `${assigned.length} shift${assigned.length === 1 ? "" : "s"} across ${members} member${members === 1 ? "" : "s"}` },
    { k: "Coverage", v: covered + "%", sub: open.length ? `${open.length} slot${open.length === 1 ? "" : "s"} unfilled` : "All shifts covered", pos: !open.length },
    { k: "Overtime (est.)", v: fmtHM(over * 60), sub: total ? `${((over / total) * 100).toFixed(1)}% of total` : "—" },
    { k: "Open shifts", v: String(open.length), sub: "This week" },
    { k: "Absences", v: String(absences.length), sub: "This week" },
  ];
  document.getElementById("sh-tiles").innerHTML = tiles.map((t) => `
    <div class="tile">
      <div class="k">${escapeHtml(t.k)}</div>
      <div class="v">${escapeHtml(t.v)}</div>
      <div class="sub${t.pos ? " pos" : ""}">${escapeHtml(t.sub)}</div>
    </div>`).join("");
}

// plChip renders one shift, or the empty cell's add affordance.
function plChip(s) {
  const k = kindDef(s.kind);
  const sel = s.id === PL_SEL ? " selected" : "";
  const label = s.kind === "absence" ? "Absent" : `${s.start} – ${s.end}`;
  const sub = s.kind === "absence" ? escapeHtml(s.note || "Away") : fmtHM(shiftMinutes(s) * 60);
  return `<button class="pl-chip ${escapeHtml(s.kind)}${sel}" style="--c:${k.color}" data-shift="${escapeHtml(s.id)}">
    <span class="pl-t">${escapeHtml(label)}</span>
    <span class="pl-h">${sub}</span>
  </button>`;
}
function plEmpty(user, group, date) {
  return `<button class="pl-empty" data-add="1" data-user="${user == null ? "" : escapeHtml(user)}" data-group="${escapeHtml(group)}" data-date="${escapeHtml(date)}">
    <span class="pl-dash">–</span><span class="pl-add">+ Add</span>
  </button>`;
}

function renderPlanner() {
  const grid = document.getElementById("pl-grid");
  const days = plDays();
  const todayKey = ymd(new Date());
  const list = weekShifts();
  const at = (user, date) => list.find((s) => s.user === user && s.date === date);

  let html = `<div class="pl-head pl-mem">Group / member</div>`;
  html += days.map((d) => {
    const t = ymd(d) === todayKey ? " today" : "";
    return `<div class="pl-head${t}">${DOW_BY_DAY[d.getDay()].slice(0, 1) + DOW_BY_DAY[d.getDay()].slice(1).toLowerCase()} ${d.getDate()}</div>`;
  }).join("");

  for (const g of PL_GROUPS) {
    const gShifts = list.filter((s) => s.group === g.id && s.kind !== "absence");
    const collapsed = PL_COLLAPSED.has(g.id);
    html += `<div class="pl-group${collapsed ? " collapsed" : ""}" data-group="${escapeHtml(g.id)}">
      <svg class="pl-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      <span class="pl-gname">${escapeHtml(g.name)}</span>
      <span class="pl-gtot">Total ${escapeHtml(fmtHM(plTotalMins(gShifts) * 60))}</span>
    </div>`;
    if (collapsed) continue;

    for (const m of g.members) {
      html += `<div class="pl-mem">
        <span class="avatar sm">${escapeHtml(plMemberInitials(m))}</span>
        <span style="min-width:0">
          <div class="pl-mn">${escapeHtml(plMemberName(m))}</div>
          <div class="pl-mr">${escapeHtml(m.profile.job || "")}</div>
        </span>
      </div>`;
      html += days.map((d) => {
        const key = ymd(d);
        const s = at(m.username, key);
        const cls = (key === todayKey ? " today" : "") + (d.getDay() === 0 || d.getDay() === 6 ? " weekend" : "");
        return `<div class="pl-cell${cls}">${s ? plChip(s) : plEmpty(m.username, g.id, key)}</div>`;
      }).join("");
    }

    // Open-shift row: one per group, holding the slots nobody is assigned to.
    html += `<div class="pl-mem pl-open">
      <span class="pl-open-ic"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></span>
      <span class="pl-mn">Open shift</span>
    </div>`;
    html += days.map((d) => {
      const key = ymd(d);
      const s = list.find((x) => x.group === g.id && x.user === null && x.date === key);
      const cls = (key === todayKey ? " today" : "") + (d.getDay() === 0 || d.getDay() === 6 ? " weekend" : "");
      return `<div class="pl-cell${cls}">${s ? plChip(s) : plEmpty(null, g.id, key)}</div>`;
    }).join("");
  }
  grid.innerHTML = html;

  grid.querySelectorAll(".pl-group").forEach((el) => el.addEventListener("click", () => {
    const id = el.dataset.group;
    if (PL_COLLAPSED.has(id)) PL_COLLAPSED.delete(id); else PL_COLLAPSED.add(id);
    renderPlanner();
  }));
  grid.querySelectorAll(".pl-chip").forEach((el) => el.addEventListener("click", () => {
    PL_SEL = el.dataset.shift;
    renderPlanner();
    renderPlDetails();
  }));
  grid.querySelectorAll(".pl-empty").forEach((el) => el.addEventListener("click", () =>
    openShiftModal(null, { user: el.dataset.user || null, group: el.dataset.group, date: el.dataset.date })));
}

function renderPlDetails() {
  const host = document.getElementById("sh-details");
  const s = PL_SHIFTS.find((x) => x.id === PL_SEL);
  if (!s) {
    host.innerHTML = `<div class="um-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4M16 3v4"/></svg>
      <p>Select a shift to see its details.</p>
    </div>`;
    return;
  }
  const k = kindDef(s.kind);
  const d = new Date(s.date + "T00:00:00");
  const when = s.kind === "absence" ? "Absent all day"
    : `${s.start} – ${s.end} (${fmtHM(shiftMinutes(s) * 60)})`;
  host.innerHTML = `
    <div class="sd-when">${escapeHtml(when)}</div>
    <div class="sd-date">${WEEKDAY_FULL[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}</div>
    <div class="sd-row"><span class="sd-dot" style="--c:${k.color}"></span>${escapeHtml(k.label)}</div>
    <div class="sd-row">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="3.5"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></svg>
      ${s.user ? escapeHtml(plName(s.user)) : "Unassigned"}
    </div>
    <div class="sd-row">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="3"/><path d="M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11z"/></svg>
      ${escapeHtml(s.note || "No note")}
    </div>
    <div class="sd-row" style="gap:6px;flex-wrap:wrap">
      <span class="badge muted">${escapeHtml(groupOf(s.group) ? groupOf(s.group).name : s.group)}</span>
      <span class="badge" style="background:color-mix(in srgb, ${k.color} 16%, transparent);color:${k.color}">${escapeHtml(k.label)}</span>
    </div>
    <div class="sd-actions">
      <button class="secondary btn-sm" id="sd-edit">Edit</button>
      <button class="danger-btn" id="sd-del">Delete</button>
    </div>`;
  host.querySelector("#sd-edit").addEventListener("click", () => openShiftModal(s.id));
  host.querySelector("#sd-del").addEventListener("click", () => deleteShift(s));
}

function renderPlStatus() {
  const list = weekShifts();
  const totals = PL_GROUPS.map((g) => ({
    name: g.name,
    mins: plTotalMins(list.filter((s) => s.group === g.id && s.kind !== "absence")),
  }));
  const max = Math.max(1, ...totals.map((t) => t.mins));
  const sum = totals.reduce((a, t) => a + t.mins, 0);
  document.getElementById("sh-status").innerHTML = totals.map((t) => `
    <div class="sh-stat">
      <div class="sh-stat-top"><span class="sh-sn">${escapeHtml(t.name)}</span><span class="sh-sv">${escapeHtml(fmtHM(t.mins * 60))} scheduled</span></div>
      <div class="bar"><span style="width:${(t.mins / max) * 100}%"></span></div>
    </div>`).join("") + `
    <div class="sh-stat" style="margin-top:16px;padding-top:12px;border-top:1px solid var(--stroke)">
      <div class="sh-stat-top"><span class="sh-sn">Total</span><span class="sh-sv">${escapeHtml(fmtHM(sum * 60))}</span></div>
    </div>`;
}

function renderPlLegend() {
  document.getElementById("sh-legend").innerHTML = SHIFT_KINDS.map((k) => `
    <div class="sh-leg"><span class="dot" style="--c:${k.color}"></span>${escapeHtml(k.label)} <span class="muted">(${escapeHtml(k.window)})</span></div>`).join("");
}

function renderPlCal() {
  const grid = document.getElementById("sh-cal-grid");
  document.getElementById("sh-cal-title").textContent = MONTHS[PL_CAL.getMonth()] + " " + PL_CAL.getFullYear();
  const first = new Date(PL_CAL.getFullYear(), PL_CAL.getMonth(), 1);
  const start = weekStartOf(first);
  const todayKey = ymd(new Date());
  const wFrom = ymd(PL_WEEK), wTo = ymd(addDays(PL_WEEK, 6));
  let html = orderedDOW().map((d) => `<div class="cal-dow">${d.slice(0, 2)}</div>`).join("");
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const key = ymd(d);
    const cls = [
      d.getMonth() === PL_CAL.getMonth() ? "" : "out",
      key >= wFrom && key <= wTo ? "inweek" : "",
      key === todayKey ? "today" : "",
    ].filter(Boolean).join(" ");
    html += `<button class="cal-day ${cls}" data-d="${key}">${d.getDate()}</button>`;
  }
  grid.innerHTML = html;
  grid.querySelectorAll(".cal-day").forEach((b) => b.addEventListener("click", () => {
    setPlWeek(weekStartOf(new Date(b.dataset.d + "T00:00:00")));
  }));
}

function renderPlTeam() {
  const list = weekShifts();
  const rows = [];
  for (const g of PL_GROUPS) {
    for (const m of g.members) {
      const own = list.filter((s) => s.user === m.username && s.kind !== "absence");
      rows.push(`<tr>
        <td>
          <div class="um-user"><span class="avatar sm">${escapeHtml(plMemberInitials(m))}</span><span class="um-name">${escapeHtml(plMemberName(m))}</span></div>
          <div class="rl-desc">${escapeHtml(m.profile.job || "")}</div>
        </td>
        <td class="muted">${escapeHtml(g.name)}</td>
        <td class="muted">${own.length}</td>
        <td>${escapeHtml(fmtHM(plTotalMins(own) * 60))}</td>
      </tr>`);
    }
  }
  document.getElementById("sh-team-body").innerHTML = rows.join("");
}

function renderShifts() {
  document.getElementById("sh-range").textContent = weekTitle(PL_WEEK);
  renderPlTiles();
  renderPlanner();
  renderPlDetails();
  renderPlStatus();
  renderPlCal();
  renderPlTeam();
}

function setPlWeek(d) {
  PL_WEEK = weekStartOf(d);
  PL_CAL = new Date(PL_WEEK.getFullYear(), PL_WEEK.getMonth(), 1);
  buildSampleWeek(PL_WEEK);
  // Drop a selection the new week no longer shows, so the details panel never
  // describes a shift that is not on screen.
  if (PL_SEL && !weekShifts().some((s) => s.id === PL_SEL)) PL_SEL = null;
  renderShifts();
}

// ---- Shift editor -----------------------------------------------------------

function openShiftModal(id, seed) {
  const s = id ? PL_SHIFTS.find((x) => x.id === id) : null;
  PL_EDIT = s ? { id: s.id } : (seed || {});
  document.getElementById("sh-modal-title").textContent = s ? "Edit shift" : "New shift";
  document.getElementById("sh-modal-msg").innerHTML = "";

  // The member picker offers everyone in the group, plus the unassigned slot.
  const gid = s ? s.group : seed.group;
  const g = groupOf(gid);
  const opts = [`<option value="">Open shift (unassigned)</option>`].concat(
    (g ? g.members : []).map((m) => `<option value="${escapeHtml(m.username)}">${escapeHtml(plMemberName(m))}</option>`));
  const userSel = document.getElementById("sh-f-user");
  userSel.innerHTML = opts.join("");
  userSel.value = (s ? s.user : seed.user) || "";

  document.getElementById("sh-f-kind").innerHTML = SHIFT_KINDS
    .map((k) => `<option value="${escapeHtml(k.key)}">${escapeHtml(k.label)}</option>`).join("");
  document.getElementById("sh-f-date").value = s ? s.date : seed.date;
  document.getElementById("sh-f-start").value = s ? s.start : "09:00";
  document.getElementById("sh-f-end").value = s ? s.end : "17:00";
  document.getElementById("sh-f-kind").value = s ? s.kind : (seed.user ? "day" : "open");
  document.getElementById("sh-f-note").value = s ? s.note : "";
  document.getElementById("sh-modal").hidden = false;
  document.getElementById("sh-f-start").focus();
}
function closeShiftModal() { document.getElementById("sh-modal").hidden = true; PL_EDIT = null; }

function saveShift() {
  const msg = document.getElementById("sh-modal-msg");
  const user = document.getElementById("sh-f-user").value || null;
  const date = document.getElementById("sh-f-date").value;
  const start = document.getElementById("sh-f-start").value;
  const end = document.getElementById("sh-f-end").value;
  let kind = document.getElementById("sh-f-kind").value;
  const note = document.getElementById("sh-f-note").value.trim();
  if (!date) { showMsg(msg, "Pick a date", "error"); return; }
  if (kind !== "absence" && (!start || !end)) { showMsg(msg, "Enter a start and end time", "error"); return; }
  if (kind !== "absence" && start === end) { showMsg(msg, "Start and end cannot be the same", "error"); return; }
  // An unassigned slot is an open shift by definition, and vice versa.
  if (!user && kind !== "open" && kind !== "absence") kind = "open";
  if (user && kind === "open") { showMsg(msg, "An open shift cannot have a member assigned", "error"); return; }

  const existing = PL_EDIT && PL_EDIT.id ? PL_SHIFTS.find((x) => x.id === PL_EDIT.id) : null;
  // One shift per member per day keeps the grid one chip per cell.
  const clash = PL_SHIFTS.find((x) => x !== existing && x.date === date && x.user === user
    && (user !== null || x.group === (existing ? existing.group : PL_EDIT.group)));
  if (clash) { showMsg(msg, user ? `${plName(user)} already has a shift that day` : "This group already has an open shift that day", "error"); return; }

  if (existing) {
    Object.assign(existing, { user, date, start, end, kind, note });
    PL_SEL = existing.id;
  } else {
    const s = { id: plId(), group: PL_EDIT.group, user, date, start, end, kind, note };
    PL_SHIFTS.push(s);
    PL_SEL = s.id;
  }
  closeShiftModal();
  setPlWeek(new Date(date + "T00:00:00"));
  showMsg(shiftsMsg(), existing ? "Shift updated" : "Shift added", "ok");
}

function deleteShift(s) {
  if (!confirm(`Delete this shift${s.user ? " for " + plName(s.user) : ""} on ${s.date}?`)) return;
  PL_SHIFTS = PL_SHIFTS.filter((x) => x.id !== s.id);
  if (PL_SEL === s.id) PL_SEL = null;
  renderShifts();
  showMsg(shiftsMsg(), "Shift deleted", "ok");
}

function setPlTab(tab) {
  PL_TAB = tab;
  document.querySelectorAll("#sh-tabs .vs-btn").forEach((b) => {
    const on = b.dataset.view === tab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.getElementById("sh-schedule").hidden = tab !== "schedule";
  document.getElementById("sh-team").hidden = tab !== "team";
}

function initShifts() {
  PL_GROUPS = SAMPLE_GROUPS;
  renderPlLegend();

  document.getElementById("sh-today").addEventListener("click", () => setPlWeek(new Date()));
  document.getElementById("sh-prev").addEventListener("click", () => setPlWeek(addDays(PL_WEEK, -7)));
  document.getElementById("sh-next").addEventListener("click", () => setPlWeek(addDays(PL_WEEK, 7)));
  document.getElementById("sh-cal-prev").addEventListener("click", () => {
    PL_CAL = new Date(PL_CAL.getFullYear(), PL_CAL.getMonth() - 1, 1);
    renderPlCal();
  });
  document.getElementById("sh-cal-next").addEventListener("click", () => {
    PL_CAL = new Date(PL_CAL.getFullYear(), PL_CAL.getMonth() + 1, 1);
    renderPlCal();
  });
  document.querySelectorAll("#sh-tabs .vs-btn").forEach((b) =>
    b.addEventListener("click", () => setPlTab(b.dataset.view)));

  document.getElementById("sh-modal-cancel").addEventListener("click", closeShiftModal);
  document.getElementById("sh-modal-save").addEventListener("click", saveShift);
  document.getElementById("sh-modal").addEventListener("click", (e) => {
    if (e.target.id === "sh-modal") closeShiftModal();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeShiftModal(); });

  setPlTab("schedule");
  setPlWeek(new Date());
}

// ---- Skills -----------------------------------------------------------------
// A catalog of skills, each with a proficiency scale and a rating per team
// member. This is the design pass: it renders from the SAMPLE_SKILLS fixture and
// the same fictional org the planner uses, and every edit stays in memory.
// Wiring replaces loadSkills() with the API and leaves the render path alone.

// SKILL_LEVELS is the proficiency scale, low to high. A skill may use a shorter
// scale (see `scale`), never a longer one.
const SKILL_LEVELS = [
  { n: 1, label: "Basic", color: "var(--lv-1)" },
  { n: 2, label: "Intermediate", color: "var(--lv-2)" },
  { n: 3, label: "Advanced", color: "var(--lv-3)" },
  { n: 4, label: "Expert", color: "var(--lv-4)" },
  { n: 5, label: "Master", color: "var(--lv-5)" },
];
const SKILL_CATS = [
  { key: "development", label: "Development", color: "#4C82F7" },
  { key: "devops", label: "DevOps", color: "#2FB79E" },
  { key: "database", label: "Database", color: "#A66CFF" },
  { key: "cloud", label: "Cloud", color: "#E9913C" },
  { key: "design", label: "Design", color: "#EB459E" },
  { key: "security", label: "Security", color: "#E5484D" },
  { key: "data", label: "Data", color: "#3BA55D" },
];
function catDef(key) { return SKILL_CATS.find((c) => c.key === key) || SKILL_CATS[0]; }
function levelDef(n) { return SKILL_LEVELS[n - 1] || SKILL_LEVELS[0]; }

// Sample catalog. `mark` is the square badge's text, `scale` how many levels the
// skill defines, `spread` roughly how much of the team holds it (0-100), and
// `added` when it entered the catalog. Ratings are derived (see skRatings).
const SAMPLE_SKILLS = [
  { id: "SKL-0001", name: "Go (Golang)", mark: "GO", cat: "development", scale: 5, spread: 85, added: "2025-11-04", desc: "Programming language for building scalable backend services." },
  { id: "SKL-0002", name: "JavaScript / TypeScript", mark: "JS", cat: "development", scale: 5, spread: 90, added: "2025-11-04", desc: "Language of the web UI and the Node tooling around it." },
  { id: "SKL-0003", name: "Python", mark: "PY", cat: "development", scale: 5, spread: 70, added: "2026-01-12", desc: "Scripting, automation and data work." },
  { id: "SKL-0004", name: "React", mark: "RE", cat: "development", scale: 4, spread: 65, added: "2026-02-02", desc: "Component framework used by the customer-facing apps." },
  { id: "SKL-0005", name: "Docker", mark: "DK", cat: "devops", scale: 5, spread: 95, added: "2025-11-04", desc: "Container images and local development environments." },
  { id: "SKL-0006", name: "Kubernetes", mark: "K8", cat: "devops", scale: 5, spread: 60, added: "2026-03-18", desc: "Orchestration for the production clusters." },
  { id: "SKL-0007", name: "CI/CD", mark: "CI", cat: "devops", scale: 4, spread: 80, added: "2025-12-01", desc: "Build, test and release pipelines." },
  { id: "SKL-0008", name: "Terraform", mark: "TF", cat: "cloud", scale: 4, spread: 55, added: "2026-06-30", desc: "Infrastructure as code across the cloud accounts." },
  { id: "SKL-0009", name: "AWS", mark: "AW", cat: "cloud", scale: 5, spread: 62, added: "2025-11-20", desc: "Hosting, networking and managed services." },
  { id: "SKL-0010", name: "PostgreSQL", mark: "PG", cat: "database", scale: 5, spread: 72, added: "2025-11-04", desc: "Primary relational store behind the Performance Server." },
  { id: "SKL-0011", name: "Redis", mark: "RD", cat: "database", scale: 3, spread: 45, added: "2026-07-02", desc: "Caching and ephemeral state." },
  { id: "SKL-0012", name: "UI/UX Design", mark: "UX", cat: "design", scale: 5, spread: 50, added: "2026-01-26", desc: "Interaction design, flows and usability review." },
  { id: "SKL-0013", name: "Figma", mark: "FG", cat: "design", scale: 4, spread: 58, added: "2026-02-14", desc: "Design files, prototypes and the shared component library." },
  { id: "SKL-0014", name: "Security Auditing", mark: "SC", cat: "security", scale: 5, spread: 40, added: "2026-07-08", desc: "Threat modelling and review of authentication paths." },
  { id: "SKL-0015", name: "SQL / Analytics", mark: "SQ", cat: "data", scale: 4, spread: 68, added: "2026-05-11", desc: "Reporting queries and usage analysis." },
  { id: "SKL-0016", name: "AngularJS", mark: "NG", cat: "development", scale: 3, spread: 30, added: "2025-11-04", desc: "Retired front-end framework, kept for the legacy admin.", archived: true },
];

let SKILLS = [];
let SK_SELECTED = null;
let SK_PAGE = 1;
const SK_PER_PAGE = 10;

function skillsMsg() { return document.getElementById("skills-msg"); }

// skTeam is everyone the catalog rates: the same fictional org the planner
// shows. Wiring: the members of the groups the viewer controls.
function skTeam() { return SAMPLE_GROUPS.flatMap((g) => g.members); }

// skHash is a small deterministic string hash (FNV-1a plus a murmur3 finalizer).
// It stands in for stored ratings so the fixture looks plausible and, more
// importantly, stays stable across renders instead of reshuffling on every
// repaint. The finalizer matters: plain FNV-1a leaves near-identical keys
// ("SKL-0006|alice" vs "SKL-0007|alice") correlated in exactly the low bits the
// callers reduce with %, which skewed coverage badly away from each skill's
// spread.
function skHash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

// skRatings derives {username: level} for a skill. A member holds the skill when
// their hash falls inside its spread; the level comes from a second, independent
// hash so holding a skill does not correlate with being good at it. Coverage
// still lands a little off `spread` -- nine people is a small sample, and that
// is what a real roster looks like.
function skRatings(skill) {
  const out = {};
  for (const m of skTeam()) {
    if (skHash(skill.id + "|" + m.username) % 100 >= skill.spread) continue;
    out[m.username] = 1 + (skHash(m.username + "@" + skill.id) % skill.scale);
  }
  return out;
}

// skCounts returns how many members sit at each level, indexed 1..5.
function skCounts(skill) {
  const counts = [0, 0, 0, 0, 0, 0];
  for (const lv of Object.values(skRatings(skill))) counts[lv]++;
  return counts;
}
function skRated(skill) { return Object.keys(skRatings(skill)).length; }
// Coverage is the share of the team that holds the skill at all -- not how good
// they are at it, which is what the level distribution is for.
function skCoverage(skill) {
  const team = skTeam().length;
  return team ? Math.round((skRated(skill) / team) * 100) : 0;
}
function skAvgLevel(skill) {
  const lv = Object.values(skRatings(skill));
  return lv.length ? lv.reduce((a, b) => a + b, 0) / lv.length : 0;
}

function skActive() { return SKILLS.filter((s) => !s.archived); }
function skShowArchived() { return document.getElementById("sk-archived").checked; }

// skFiltered applies the toolbar: search, category, held-level and the archived
// switch.
function skFiltered() {
  const q = (document.getElementById("sk-search").value || "").trim().toLowerCase();
  const cat = document.getElementById("sk-cat-filter").value;
  const lv = document.getElementById("sk-level-filter").value;
  return SKILLS.filter((s) => {
    if (s.archived && !skShowArchived()) return false;
    if (cat && s.cat !== cat) return false;
    if (lv && skCounts(s)[Number(lv)] === 0) return false;
    if (q && !s.name.toLowerCase().includes(q) && !(s.desc || "").toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderSkTiles() {
  const active = skActive();
  const cats = [...new Set(active.map((s) => s.cat))];
  const cov = active.length ? Math.round(active.reduce((a, s) => a + skCoverage(s), 0) / active.length) : 0;
  // Skills the team has real depth in: somebody is at Expert or above. An
  // *average* of 4+ would need nearly everyone at expert level, so it read 0 for
  // every plausible roster and told you nothing.
  const expert = active.filter((s) => skCounts(s).slice(4).some((n) => n > 0)).length;
  // "Recent" is the last 30 days, measured from today rather than stored.
  const cutoff = ymd(addDays(new Date(), -30));
  const fresh = active.filter((s) => (s.added || "") >= cutoff).length;
  const tiles = [
    { k: "Total skills", v: String(active.length), sub: fresh ? `+${fresh} in the last 30 days` : "None added recently", pos: fresh > 0 },
    { k: "Categories", v: String(cats.length), sub: cats.slice(0, 3).map((c) => catDef(c).label).join(", ") + (cats.length > 3 ? "…" : "") },
    { k: "Team coverage", v: cov + "%", sub: `Average across ${active.length} skill${active.length === 1 ? "" : "s"}` },
    { k: "Expert skills", v: String(expert), sub: "With an expert on the team" },
  ];
  document.getElementById("sk-tiles").innerHTML = tiles.map((t) => `
    <div class="tile">
      <div class="k">${escapeHtml(t.k)}</div>
      <div class="v">${escapeHtml(t.v)}</div>
      <div class="sub${t.pos ? " pos" : ""}">${escapeHtml(t.sub)}</div>
    </div>`).join("");
}

// skLevelGlyph renders the scale as one bar per level, lit where somebody on the
// team holds it.
function skLevelGlyph(skill) {
  const counts = skCounts(skill);
  const bars = [];
  for (let n = 1; n <= skill.scale; n++) {
    const on = counts[n] > 0;
    bars.push(`<span class="sk-lv${on ? " on" : ""}" style="--c:${levelDef(n).color}" title="${escapeHtml(levelDef(n).label)}: ${counts[n]}">
      <i></i><span>${n}</span>
    </span>`);
  }
  return `<div class="sk-levels">${bars.join("")}</div>`;
}

function renderSkTable() {
  const body = document.getElementById("skills-body");
  const rows = skFiltered();
  const pages = Math.max(1, Math.ceil(rows.length / SK_PER_PAGE));
  if (SK_PAGE > pages) SK_PAGE = pages;
  const from = (SK_PAGE - 1) * SK_PER_PAGE;
  const page = rows.slice(from, from + SK_PER_PAGE);

  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="5" class="muted">${SKILLS.length ? "No skills match your filters." : "No skills yet — add one to get started."}</td></tr>`;
  } else {
    body.innerHTML = page.map((s) => {
      const c = catDef(s.cat);
      const cov = skCoverage(s);
      const sel = s.id === SK_SELECTED ? " selected" : "";
      return `<tr class="um-row${sel}" data-s="${escapeHtml(s.id)}">
        <td>
          <div class="um-user">
            <span class="sk-ic" style="--c:${c.color}">${escapeHtml(s.mark)}</span>
            <span class="um-name">${escapeHtml(s.name)}${s.archived ? ' <span class="badge muted">Archived</span>' : ""}</span>
          </div>
        </td>
        <td><span class="sk-cat"><span class="sk-dot" style="--c:${c.color}"></span>${escapeHtml(c.label)}</span></td>
        <td>${skLevelGlyph(s)}</td>
        <td>
          <div class="sk-cov">
            <span class="sk-pct">${cov}%</span>
            <div class="bar"><span style="width:${cov}%"></span></div>
          </div>
        </td>
        <td>
          <div class="te-menu">
            <button class="sk-menu-btn" aria-label="Actions">⋯</button>
            <div class="menu-pop">
              <button class="sk-m-details">Details</button>
              <button class="sk-m-archive">${s.archived ? "Restore" : "Archive"}</button>
              <button class="danger-btn">Delete</button>
            </div>
          </div>
        </td>
      </tr>`;
    }).join("");
  }

  document.getElementById("sk-count").textContent = rows.length
    ? `Showing ${from + 1} to ${Math.min(from + SK_PER_PAGE, rows.length)} of ${rows.length} skill${rows.length === 1 ? "" : "s"}`
    : "";
  renderSkPager(pages);

  body.querySelectorAll(".um-row").forEach((tr) => tr.addEventListener("click", () => selectSkill(tr.dataset.s)));
  body.querySelectorAll(".sk-menu-btn").forEach((btn) => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const pop = btn.nextElementSibling;
    const wasOpen = pop.classList.contains("open");
    closeAllMenus();
    if (!wasOpen) pop.classList.add("open");
  }));
  const rowSkill = (el) => SKILLS.find((x) => x.id === el.closest(".um-row").dataset.s);
  body.querySelectorAll(".sk-m-details").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation(); closeAllMenus(); selectSkill(rowSkill(b).id);
  }));
  body.querySelectorAll(".sk-m-archive").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation(); closeAllMenus(); toggleArchiveSkill(rowSkill(b));
  }));
  body.querySelectorAll(".sk-m-delete").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation(); closeAllMenus(); deleteSkill(rowSkill(b));
  }));
}

function renderSkPager(pages) {
  const host = document.getElementById("sk-pager");
  if (pages <= 1) { host.innerHTML = ""; return; }
  const arrow = (d) => d < 0
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>`;
  let html = `<button data-p="${SK_PAGE - 1}" ${SK_PAGE === 1 ? "disabled" : ""} aria-label="Previous page">${arrow(-1)}</button>`;
  for (let p = 1; p <= pages; p++) {
    html += `<button data-p="${p}" class="${p === SK_PAGE ? "active" : ""}">${p}</button>`;
  }
  html += `<button data-p="${SK_PAGE + 1}" ${SK_PAGE === pages ? "disabled" : ""} aria-label="Next page">${arrow(1)}</button>`;
  host.innerHTML = html;
  host.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    if (b.disabled) return;
    SK_PAGE = Number(b.dataset.p);
    renderSkTable();
  }));
}

function selectSkill(id) {
  SK_SELECTED = id;
  renderSkTable();
  renderSkDetails();
}

function renderSkDetails() {
  const host = document.getElementById("skill-details");
  const s = SKILLS.find((x) => x.id === SK_SELECTED);
  if (!s) {
    host.classList.remove("filled");
    host.innerHTML = `<div class="um-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3z"/></svg>
      <p>Select a skill to see its levels and team coverage.</p>
    </div>`;
    return;
  }
  host.classList.add("filled");
  const c = catDef(s.cat);
  const counts = skCounts(s);
  const rated = skRated(s);
  const segs = SKILL_LEVELS.slice(0, s.scale)
    .map((l) => ({ sec: counts[l.n], color: l.color, label: l.label, n: l.n }))
    .filter((x) => x.sec > 0);

  host.innerHTML = `
    <div class="ud-head">
      <span class="sk-ic lg" style="--c:${c.color}">${escapeHtml(s.mark)}</span>
      <div class="ud-id">
        <div class="sk-head-row"><h3>${escapeHtml(s.name)}</h3></div>
        <span class="badge ${s.archived ? "muted" : "ok"}">${s.archived ? "Archived" : "Active"}</span>
        <div class="sd-meta">ID: ${escapeHtml(s.id)}</div>
      </div>
    </div>

    <div class="ud-section">
      <div class="sd-sec-head"><div class="ud-section-head">Category</div></div>
      <span class="sk-cat"><span class="sk-dot" style="--c:${c.color}"></span>${escapeHtml(c.label)}</span>
    </div>

    <div class="ud-section">
      <div class="sd-sec-head"><div class="ud-section-head">Description</div></div>
      <p class="sd-desc">${escapeHtml(s.desc || "No description.")}</p>
    </div>

    <div class="ud-section">
      <div class="sd-sec-head"><div class="ud-section-head">Proficiency levels</div></div>
      <div class="sd-lv-list">
        ${SKILL_LEVELS.slice(0, s.scale).map((l) => `
          <div class="sd-lv">
            <span class="n">${l.n}</span>
            <span class="sk-dot" style="--c:${l.color}"></span>
            <span class="nm">${escapeHtml(l.label)}</span>
            <span class="ct">${counts[l.n]} member${counts[l.n] === 1 ? "" : "s"}</span>
          </div>`).join("")}
      </div>
    </div>

    <div class="ud-section">
      <div class="sd-sec-head"><div class="ud-section-head">Team proficiency distribution</div></div>
      ${rated === 0 ? `<p class="sd-desc">Nobody on the team holds this skill yet.</p>` : `
        <div class="sd-dist">
          <div class="donut-wrap">
            <svg viewBox="0 0 42 42" width="96" height="96">${donutSVG(segs, rated)}</svg>
            <div class="donut-center"><div><div class="d-total">${skCoverage(s)}%</div><div class="d-label">Coverage</div></div></div>
          </div>
          <div class="legend">
            ${segs.map((x) => `<div class="legend-row">
              <span class="dot" style="background:${x.color}"></span>
              <span class="legend-name">${x.n} ${escapeHtml(x.label)}</span>
              <span class="legend-pct">${x.sec} (${Math.round((x.sec / rated) * 100)}%)</span>
            </div>`).join("")}
          </div>
        </div>`}
      <p class="um-note muted" style="margin-top:12px">${rated} of ${skTeam().length} team members hold this skill.</p>
    </div>

    <div class="ud-section">
      <div class="sd-sec-head"><div class="ud-section-head">Used in</div></div>
      <div class="sd-used">
        <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>Time entries</span>
        <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4M16 3v4"/></svg>Shifts</span>
        <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5"/><rect x="7" y="11" width="3" height="8"/><rect x="13" y="7" width="3" height="12"/></svg>Reports</span>
      </div>
    </div>

    <div class="ud-section">
      <div class="ud-actions">
        <button class="secondary btn-sm" id="sk-archive">${s.archived ? "Restore" : "Archive"}</button>
        <button class="danger-btn" id="sk-delete">Delete</button>
      </div>
    </div>`;

  host.querySelector("#sk-archive").addEventListener("click", () => toggleArchiveSkill(s));
  host.querySelector("#sk-delete").addEventListener("click", () => deleteSkill(s));
}

function toggleArchiveSkill(s) {
  s.archived = !s.archived;
  showMsg(skillsMsg(), s.archived ? `Archived ${s.name}` : `Restored ${s.name}`, "ok");
  renderSkills();
}

function deleteSkill(s) {
  if (!confirm(`Delete the skill "${s.name}"? Team ratings for it are removed too.`)) return;
  SKILLS = SKILLS.filter((x) => x.id !== s.id);
  if (SK_SELECTED === s.id) SK_SELECTED = null;
  showMsg(skillsMsg(), `Deleted ${s.name}`, "ok");
  renderSkills();
}

function renderSkills() {
  renderSkTiles();
  renderSkTable();
  renderSkDetails();
}

// exportSkills downloads the catalog as JSON, ratings resolved.
function exportSkills() {
  const out = SKILLS.map((s) => ({
    id: s.id, name: s.name, category: s.cat, description: s.desc,
    scale: s.scale, archived: !!s.archived, added: s.added,
    levels: SKILL_LEVELS.slice(0, s.scale).map((l) => l.label),
    ratings: skRatings(s),
  }));
  const blob = new Blob([JSON.stringify({ skills: out }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "skills.json";
  a.click();
  URL.revokeObjectURL(a.href);
  showMsg(skillsMsg(), `Exported ${out.length} skills`, "ok");
}

function openAddSkill() {
  document.getElementById("create-skill-msg").innerHTML = "";
  document.getElementById("new-skill-name").value = "";
  document.getElementById("new-skill-desc").value = "";
  document.getElementById("add-skill-modal").hidden = false;
  document.getElementById("new-skill-name").focus();
}
function closeAddSkill() { document.getElementById("add-skill-modal").hidden = true; }

// skMark derives the square badge's letters: initials of the first two words, or
// the first two characters of a single word.
function skMark(name) {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const s = words.length >= 2 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2);
  return s.toUpperCase();
}
// skNextId keeps the SKL-#### sequence going past whatever the fixture ends on.
function skNextId() {
  const max = SKILLS.reduce((a, s) => Math.max(a, Number((s.id.split("-")[1] || 0))), 0);
  return "SKL-" + String(max + 1).padStart(4, "0");
}

function createSkill() {
  const msg = document.getElementById("create-skill-msg");
  const name = document.getElementById("new-skill-name").value.trim();
  if (!name) { showMsg(msg, "Enter a skill name", "error"); return; }
  if (SKILLS.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
    showMsg(msg, "A skill with that name already exists", "error"); return;
  }
  const s = {
    id: skNextId(), name, mark: skMark(name),
    cat: document.getElementById("new-skill-cat").value,
    desc: document.getElementById("new-skill-desc").value.trim(),
    scale: 5, spread: 0, added: ymd(new Date()),
  };
  SKILLS.push(s);
  closeAddSkill();
  SK_SELECTED = s.id;
  showMsg(skillsMsg(), `Created ${name}`, "ok");
  renderSkills();
}

function initSkills() {
  SKILLS = SAMPLE_SKILLS.map((s) => ({ ...s }));

  const catOpts = SKILL_CATS.map((c) => `<option value="${c.key}">${escapeHtml(c.label)}</option>`).join("");
  document.getElementById("sk-cat-filter").innerHTML = `<option value="">All categories</option>` + catOpts;
  document.getElementById("new-skill-cat").innerHTML = catOpts;
  document.getElementById("sk-level-filter").innerHTML = `<option value="">All levels</option>` +
    SKILL_LEVELS.map((l) => `<option value="${l.n}">${l.n} · ${escapeHtml(l.label)}</option>`).join("");

  const rerender = () => { SK_PAGE = 1; renderSkTable(); };
  document.getElementById("sk-search").addEventListener("input", rerender);
  document.getElementById("sk-cat-filter").addEventListener("change", rerender);
  document.getElementById("sk-level-filter").addEventListener("change", rerender);
  document.getElementById("sk-archived").addEventListener("change", () => { SK_PAGE = 1; renderSkills(); });

  document.getElementById("add-skill-btn").addEventListener("click", openAddSkill);
  document.getElementById("add-skill-cancel").addEventListener("click", closeAddSkill);
  document.getElementById("create-skill").addEventListener("click", createSkill);
  document.getElementById("export-skills-btn").addEventListener("click", exportSkills);
  document.getElementById("add-skill-modal").addEventListener("click", (e) => {
    if (e.target.id === "add-skill-modal") closeAddSkill();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAddSkill(); });
  // The row menus are popovers: any click elsewhere dismisses them.
  document.addEventListener("click", closeAllMenus);

  renderSkills();
}

document.addEventListener("DOMContentLoaded", () => {
  if (document.getElementById("setup-form")) return initSetup();
  if (document.getElementById("login-form")) return initLogin();
  if (document.getElementById("register-form")) return initRegister();
  if (!getToken()) { location.href = PREFIX + "login"; return; }
  fillSidebar();
  if (document.getElementById("pl-grid")) return initShifts();
  if (document.getElementById("skills-body")) return initSkills();
  if (document.getElementById("cal-grid")) return initDashboard();
  if (document.getElementById("week-days")) return initEntries();
  if (document.getElementById("ie-input")) return initImpExp();
  if (document.getElementById("users-body")) return initAdmin();
  if (document.getElementById("roles-body")) return initRoles();
  if (document.getElementById("groups-body")) return initGroups();
  if (document.getElementById("servers-page")) return initServers();
  if (document.getElementById("oauth-page")) return initOAuth();
  if (document.getElementById("tags-manage")) return initTags();
  if (document.getElementById("acc-username")) return initAccount();
  if (document.getElementById("about-content")) return initAbout();
});
