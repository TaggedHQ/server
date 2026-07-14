"use strict";
// Tagged web UI client. Talks to the JSON API under <prefix>api/v2/.

const PREFIX = window.TT_PREFIX || "/";
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
  if (nameEl) nameEl.textContent = user;
  if (avEl) avEl.textContent = (user[0] || "?").toUpperCase();
  const lo = document.getElementById("logout");
  if (lo) lo.addEventListener("click", logout);
  revealChrome();
}

// revealChrome makes one whoami call to reveal role-specific UI: the Admin nav
// section for admins, and the user switcher for controllers.
async function revealChrome() {
  try {
    const r = await apiFetch("whoami");
    if (!r.ok) return;
    const d = await r.json();
    window.TT_IS_ADMIN = !!d.is_admin;
    window.TT_IS_CONTROLLER = !!d.is_controller;
    // The Admin section is hidden by default on non-admin pages; reveal it (falls
    // back to the .nav-section stylesheet display) only for admins.
    const na = document.getElementById("nav-admin");
    if (na && d.is_admin) na.style.display = "";
    if (d.is_controller) setupSwitcher();
  } catch (e) { /* ignore */ }
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

function renderDonut(segments, totalSec) {
  const CX = 21, CY = 21, R = 15.915, SW = 5;
  let parts = `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="var(--surface-raised)" stroke-width="${SW}"/>`;
  if (totalSec > 0) {
    let cum = 0;
    const segs = segments.map((s) => {
      const pct = (s.sec / totalSec) * 100;
      if (pct <= 0) return "";
      const c = `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${s.color}" stroke-width="${SW}" stroke-dasharray="${pct.toFixed(3)} ${(100 - pct).toFixed(3)}" stroke-dashoffset="${(-cum).toFixed(3)}"/>`;
      cum += pct;
      return c;
    });
    parts += `<g transform="rotate(-90 ${CX} ${CY})">${segs.join("")}</g>`;
  }
  document.getElementById("donut").innerHTML = parts;
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
      showMsg(pwMsg, "Password updated", "ok");
      document.getElementById("pw1").value = "";
      document.getElementById("pw2").value = "";
    } else {
      showMsg(pwMsg, (await resp.text()) || "Failed", "error");
    }
  });

  initTokenSection();
  await initSecuritySections();
  document.getElementById("logout2").addEventListener("click", logout);
}

// initSecuritySections shows the two-factor and passkey panels only for password
// ("non-OAuth") accounts; OAuth-only accounts see a short explanatory note.
async function initSecuritySections() {
  let hasPassword = true;
  try { hasPassword = !!(await (await apiFetch("whoami")).json()).has_password; } catch (e) { /* assume password */ }
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

// initTokenSection wires the API-token field: the value stays masked and is
// only revealed after the user re-enters their password.
function initTokenSection() {
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

  showBtn.addEventListener("click", () => {
    // Already revealed this session: toggle freely without re-asking.
    if (token) { input.type === "password" ? reveal() : mask(); return; }
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
    <div class="te-menu"><button class="te-menu-btn" aria-label="Menu">⋯</button><div class="menu-pop"><button class="edit">Edit</button><button class="danger delete">Delete</button></div></div>
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

async function loadUsers() {
  const body = document.getElementById("users-body");
  const me = localStorage.getItem(USER_KEY) || "";
  const resp = await apiFetch("admin/users");
  if (!resp.ok) {
    body.innerHTML = `<tr><td colspan="5" class="muted">${escapeHtml(await resp.text())}</td></tr>`;
    return;
  }
  const users = (await resp.json()).users || [];
  if (users.length === 0) {
    body.innerHTML = '<tr><td colspan="5" class="muted">No users yet.</td></tr>';
    return;
  }
  body.innerHTML = users.map((u) => {
    const isSelf = u.username === me;
    const uAttr = escapeHtml(u.username);
    const storedAdmin = u.is_admin && !u.config_admin;
    // Status badge(s)
    let status;
    if (u.config_admin) status = '<span class="badge admin">Admin · config</span>';
    else if (u.is_admin) status = '<span class="badge admin">Admin</span>';
    else status = u.registered ? '<span class="badge ok">Registered</span>' : '<span class="badge muted">No password</span>';
    if (u.is_controller) status += ' <span class="badge controller">Controller</span>';
    // Admin toggle (not for config admins or yourself)
    let toggle = "";
    if (!u.config_admin && !isSelf) {
      toggle = storedAdmin
        ? `<button class="secondary btn-sm toggle-admin" data-u="${uAttr}" data-make="0">Revoke admin</button>`
        : `<button class="secondary btn-sm toggle-admin" data-u="${uAttr}" data-make="1">Make admin</button>`;
    }
    // Controller toggle: only for regular (non-admin) users.
    let ctrlToggle = "";
    if (!u.config_admin && !u.is_admin) {
      ctrlToggle = u.is_controller
        ? `<button class="secondary btn-sm toggle-controller" data-u="${uAttr}" data-make="0">Revoke controller</button>`
        : `<button class="secondary btn-sm toggle-controller" data-u="${uAttr}" data-make="1">Make controller</button>`;
    }
    const del = isSelf
      ? '<button class="secondary btn-sm" disabled title="You cannot delete your own account">Delete</button>'
      : `<button class="secondary btn-sm delete-user" data-u="${uAttr}">Delete</button>`;
    return `<tr>
      <td>${escapeHtml(u.username)}</td>
      <td>${status}</td>
      <td class="muted">${fmtBytes(u.size_bytes)}</td>
      <td class="muted">${fmtDate(u.modified)}</td>
      <td><div class="u-actions">${toggle}${ctrlToggle}<button class="secondary btn-sm reset-user" data-u="${uAttr}">Reset password</button>${del}</div></td>
    </tr>`;
  }).join("");

  const msg = document.getElementById("users-msg");
  body.querySelectorAll(".toggle-admin").forEach((b) => b.addEventListener("click", async () => {
    const u = b.dataset.u;
    const makeAdmin = b.dataset.make === "1";
    if (!confirm(`${makeAdmin ? "Grant admin rights to" : "Revoke admin rights from"} ${u}?`)) return;
    const r = await apiFetch("admin/admin", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, is_admin: makeAdmin }),
    });
    if (r.ok) { showMsg(msg, `${makeAdmin ? "Granted" : "Revoked"} admin for ${u}`, "ok"); loadUsers(); }
    else showMsg(msg, await r.text(), "error");
  }));
  body.querySelectorAll(".toggle-controller").forEach((b) => b.addEventListener("click", async () => {
    const u = b.dataset.u;
    const makeController = b.dataset.make === "1";
    if (!confirm(`${makeController ? "Grant controller rights to" : "Revoke controller rights from"} ${u}?`)) return;
    const r = await apiFetch("admin/controller", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, is_controller: makeController }),
    });
    if (r.ok) { showMsg(msg, `${makeController ? "Granted" : "Revoked"} controller for ${u}`, "ok"); loadUsers(); }
    else showMsg(msg, await r.text(), "error");
  }));
  body.querySelectorAll(".reset-user").forEach((b) => b.addEventListener("click", async () => {
    const u = b.dataset.u;
    const pw = prompt(`New password for ${u}:`);
    if (pw === null) return;
    if (pw.length < 4) { showMsg(msg, "Password must be at least 4 characters", "error"); return; }
    const r = await apiFetch("admin/password", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: pw }),
    });
    showMsg(msg, r.ok ? `Password reset for ${u}` : (await r.text()), r.ok ? "ok" : "error");
  }));
  body.querySelectorAll(".delete-user").forEach((b) => b.addEventListener("click", async () => {
    const u = b.dataset.u;
    if (!confirm(`Delete user "${u}" and all their data? This cannot be undone.`)) return;
    const r = await apiFetch("admin/user", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u }),
    });
    if (r.ok) { showMsg(msg, `Deleted ${u}`, "ok"); loadUsers(); }
    else showMsg(msg, await r.text(), "error");
  }));
}

async function initAdmin() {
  // Server also enforces this; redirect non-admins away from the page.
  try {
    const who = await apiFetch("whoami");
    if (who.ok && !(await who.json()).is_admin) { location.href = PREFIX; return; }
  } catch (e) { return; }

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
      showMsg(createMsg, `Created ${username}`, "ok");
      document.getElementById("new-username").value = "";
      document.getElementById("new-password").value = "";
      loadUsers();
    } else {
      showMsg(createMsg, await r.text(), "error");
    }
  });
  document.getElementById("refresh-users").addEventListener("click", loadUsers);
  loadUsers();
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
    rm.type = "button"; rm.className = "link danger"; rm.textContent = "Remove";
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
  document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"]').forEach((l) => l.remove());
  const add = (rel, href, type, sizes) => {
    const l = document.createElement("link");
    l.rel = rel; l.href = href;
    if (type) l.type = type;
    if (sizes) l.sizes = sizes;
    document.head.appendChild(l);
  };
  add("icon", base + "favicon-32x32.png", "image/png", "32x32");
  add("icon", base + "favicon-16x16.png", "image/png", "16x16");
  add("icon", base + "favicon.ico", "image/x-icon");
  add("apple-touch-icon", base + "apple-touch-icon.png");
}
applyFavicon();
if (window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyFavicon);
}

document.addEventListener("DOMContentLoaded", () => {
  if (document.getElementById("setup-form")) return initSetup();
  if (document.getElementById("login-form")) return initLogin();
  if (document.getElementById("register-form")) return initRegister();
  if (!getToken()) { location.href = PREFIX + "login"; return; }
  fillSidebar();
  if (document.getElementById("cal-grid")) return initDashboard();
  if (document.getElementById("week-days")) return initEntries();
  if (document.getElementById("ie-input")) return initImpExp();
  if (document.getElementById("users-body")) return initAdmin();
  if (document.getElementById("servers-page")) return initServers();
  if (document.getElementById("oauth-page")) return initOAuth();
  if (document.getElementById("tags-manage")) return initTags();
  if (document.getElementById("acc-username")) return initAccount();
  if (document.getElementById("about-content")) return initAbout();
});
