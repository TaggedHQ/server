"use strict";
// Tagged web UI client. Talks to the JSON API under <prefix>api/v2/.

const PREFIX = window.TT_PREFIX || "/";
const API = PREFIX + "api/v2/";
const TOKEN_KEY = "tt_webtoken";
const USER_KEY = "tt_username";

// Categorical palette for tags (matches the macOS app's accent-first scheme).
const PALETTE = ["#DEAA22", "#4C82F7", "#2FB79E", "#E5484D", "#E9913C", "#3BA55D", "#EB459E", "#5865F2"];
const OTHER = "Other";
const OTHER_COLOR = "#A66CFF";

const DAILY_GOAL_KEY = "tagged_web_daily_goal";
const WEEKLY_GOAL_KEY = "tagged_web_weekly_goal";

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
}
function logout() { clearSession(); location.href = PREFIX + "login"; }

function showMsg(el, text, kind) {
  el.textContent = text;
  el.className = "msg" + (kind ? " " + kind : "");
}

async function apiFetch(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  const token = getToken();
  if (token) headers["authtoken"] = token;
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

function midnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function dayKey(d) { return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate(); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function dayRange(d) { const s = midnight(d).getTime() / 1000; return [s, s + 86400]; }
function weekRange(d) {
  const off = (d.getDay() + 6) % 7; // Monday-based
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
function tagKeyOf(ds) { const m = (ds || "").match(/#(\S+)/); return m ? m[1].toLowerCase() : OTHER_KEY; }
function rawTagOf(ds) { const m = (ds || "").match(/#(\S+)/); return m ? m[1] : OTHER; }
function recDur(r) { return Math.max(0, r.t2 - r.t1); }

let ALL = [];          // all records
let COLORS = {};       // tag key -> auto-assigned color (fallback)
let LABELS = {};       // tag key -> display label
let TAGCOLORS = {};    // tag key -> stored color (from settings, wins over auto)
let TAGINFO_RAW = {};  // tag key -> full taginfo object (preserved when saving)
let GOALS = { daily: 8, weekly: 40 };

function allTagsOf(ds) { return (ds || "").match(/#(\S+)/g) || []; }

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
function labelFor(key) { return LABELS[key] || (key === OTHER_KEY ? OTHER : key); }

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

function initLogin() {
  const form = document.getElementById("login-form");
  const msg = document.getElementById("msg");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;
    showMsg(msg, "Logging in…", "");
    const payload = btoa(JSON.stringify({ method: "usernamepassword", username, password }));
    try {
      const resp = await fetch(API + "bootstrap_authentication", { method: "POST", body: payload });
      if (!resp.ok) { showMsg(msg, (await resp.text()) || "Login failed", "error"); return; }
      const data = await resp.json();
      setSession(data.token, username);
      location.href = PREFIX;
    } catch (err) { showMsg(msg, "Network error", "error"); }
  });
}

function initRegister() {
  const form = document.getElementById("register-form");
  const msg = document.getElementById("msg");
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
  revealAdmin();
}

// revealAdmin shows the Admin nav item only for admin users.
async function revealAdmin() {
  const na = document.getElementById("nav-admin");
  if (!na) return;
  try {
    const r = await apiFetch("whoami");
    if (!r.ok) return;
    const d = await r.json();
    if (d.is_admin && !na.classList.contains("active")) na.style.display = "flex";
    window.TT_IS_ADMIN = !!d.is_admin;
  } catch (e) { /* ignore */ }
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
  const startOff = (first.getDay() + 6) % 7; // Monday-based
  const gridStart = addDays(first, -startOff);

  // Days that have entries (by local day)
  const has = {};
  for (const r of ALL) has[dayKey(midnight(new Date(r.t1 * 1000)))] = true;

  let cells = DOW.map((d) => `<div class="cal-dow">${d}</div>`).join("");
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

  const tokenBox = document.getElementById("token-box");
  async function genToken(reset) {
    tokenBox.textContent = "Generating…";
    tokenBox.classList.add("show");
    const resp = await apiFetch("apitoken" + (reset ? "?reset=1" : ""));
    tokenBox.textContent = resp.ok ? (await resp.json()).token : (await resp.text());
  }
  document.getElementById("gen-token").addEventListener("click", () => genToken(false));
  document.getElementById("regen-token").addEventListener("click", () => genToken(true));
  document.getElementById("logout2").addEventListener("click", logout);
}

// ---- Time entries page ------------------------------------------------------

const WEEKDAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function fmtColon(sec) { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 3600) + ":" + pad(Math.floor((sec % 3600) / 60)); }
function weekStartOf(d) { const off = (d.getDay() + 6) % 7; return midnight(addDays(d, -off)); }
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
  const descText = (r.ds || "").replace(/#\S+/g, "").trim();
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

function closeAllMenus() { document.querySelectorAll(".menu-pop.open").forEach((p) => p.classList.remove("open")); }

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
    cells.push(`<div class="wday ${sel ? "sel" : ""} ${has ? "has" : ""}" data-i="${i}"><div class="dow">${DOW[i]}</div><div class="dnum">${d.getDate()}</div><div class="dtot">${sel ? fmtHM(tot) : fmtColon(tot)}</div><div class="wdot"></div></div>`);
  }
  const daysEl = document.getElementById("week-days");
  daysEl.innerHTML = cells.join("");
  daysEl.querySelectorAll(".wday").forEach((el) => el.addEventListener("click", () => {
    selDate = midnight(addDays(wStart, Number(el.dataset.i)));
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
}

// ---- Entry editor modal -----------------------------------------------------

let emKey = null;   // key of the record being edited, or null for a new entry
let emTags = [];    // tag keys currently on the entry
let emAdding = false;

function normalizeTag(s) {
  s = (s || "").trim().replace(/^#+/, "").toLowerCase().replace(/[^a-z0-9_\-]/g, "");
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

  const wrap = document.getElementById("em-add-wrap");
  wrap.hidden = !emAdding;
  if (emAdding) {
    const sugg = allTagKeys().filter((t) => !emTags.includes(t)).slice(0, 12);
    const box = document.getElementById("em-suggest");
    box.innerHTML = sugg.map((t) => {
      const c = colorFor(t);
      return `<button type="button" data-t="${escapeHtml(t)}" style="border-color:${c}55;color:${c}">#${escapeHtml(t)}</button>`;
    }).join("");
    box.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => addEmTag(b.dataset.t)));
  }
}

function addEmTag(raw) {
  const t = normalizeTag(raw);
  if (t && !emTags.includes(t)) emTags.push(t);
  const inp = document.getElementById("em-tag-input");
  inp.value = "";
  renderEmTags();
  inp.focus();
}

function openEntryModal(rec) {
  emKey = rec ? rec.key : null;
  emAdding = false;
  emError("");
  document.getElementById("em-title").textContent = rec ? "Edit Entry" : "New Entry";
  const ds = rec ? (rec.ds || "") : "";
  document.getElementById("em-desc").value = ds.replace(/#\S+/g, "").trim();
  emTags = rec ? [...new Set(allTagsOf(ds).map((t) => t.slice(1).toLowerCase()))] : [];

  let t1, t2;
  if (rec) { t1 = rec.t1; t2 = rec.t2; }
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
  document.getElementById("em-add-tag").addEventListener("click", () => {
    emAdding = !emAdding;
    renderEmTags();
    if (emAdding) document.getElementById("em-tag-input").focus();
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

async function initEntries() {
  await loadSettings();
  try { await loadAll(); } catch (e) { return; }
  document.getElementById("week-prev").addEventListener("click", () => { selDate = midnight(addDays(selDate, -7)); renderEntriesPage(); });
  document.getElementById("week-next").addEventListener("click", () => { selDate = midnight(addDays(selDate, 7)); renderEntriesPage(); });
  document.getElementById("new-entry").addEventListener("click", () => openEntryModal(null));
  wireEntryModal();
  document.addEventListener("click", closeAllMenus);
  renderEntriesPage();
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
    // Status badge
    let status;
    if (u.config_admin) status = '<span class="badge admin">Admin · config</span>';
    else if (u.is_admin) status = '<span class="badge admin">Admin</span>';
    else status = u.registered ? '<span class="badge ok">Registered</span>' : '<span class="badge muted">No password</span>';
    // Admin toggle (not for config admins or yourself)
    let toggle = "";
    if (!u.config_admin && !isSelf) {
      toggle = storedAdmin
        ? `<button class="secondary btn-sm toggle-admin" data-u="${uAttr}" data-make="0">Revoke admin</button>`
        : `<button class="secondary btn-sm toggle-admin" data-u="${uAttr}" data-make="1">Make admin</button>`;
    }
    const del = isSelf
      ? '<button class="secondary btn-sm" disabled title="You cannot delete your own account">Delete</button>'
      : `<button class="secondary btn-sm delete-user" data-u="${uAttr}">Delete</button>`;
    return `<tr>
      <td>${escapeHtml(u.username)}</td>
      <td>${status}</td>
      <td class="muted">${fmtBytes(u.size_bytes)}</td>
      <td class="muted">${fmtDate(u.modified)}</td>
      <td><div class="u-actions">${toggle}<button class="secondary btn-sm reset-user" data-u="${uAttr}">Reset password</button>${del}</div></td>
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
  const keys = Object.keys(stats).sort((a, b) => stats[b].sec - stats[a].sec);
  const host = document.getElementById("tags-manage");
  if (keys.length === 0) {
    host.innerHTML = '<div class="empty">No tags yet — add #tags to your entries.</div>';
    return;
  }
  host.innerHTML = keys.map((k) => {
    const color = colorFor(k);
    const stored = TAGCOLORS[k];
    const presets = TAG_PRESETS.map((c) =>
      `<button class="preset ${c.toLowerCase() === color.toLowerCase() ? "sel" : ""}" style="background:${c}" data-c="${c}" title="${c}"></button>`
    ).join("");
    return `<div class="tm-row" data-tag="${escapeHtml(k)}">
      <div class="tm-main">
        <input type="color" class="swatch" value="${color}" data-tag="${escapeHtml(k)}" title="Custom color">
        <span class="tm-chip" style="background:${color}26;color:${color}">${escapeHtml(labelFor(k))}</span>
        <span class="tm-stats">${stats[k].count} ${stats[k].count === 1 ? "entry" : "entries"} · ${fmtHM(stats[k].sec)}</span>
      </div>
      <div class="tm-picker">
        <div class="presets">${presets}</div>
        ${stored ? `<button class="tm-reset" data-tag="${escapeHtml(k)}">Auto</button>` : ""}
      </div>
    </div>`;
  }).join("");

  const msg = document.getElementById("tags-msg");
  const save = async (k, hex, okText) => {
    const ok = await saveTagColor(k, hex);
    showMsg(msg, ok ? okText : "Failed to save", ok ? "ok" : "error");
    renderTags();
  };
  host.querySelectorAll(".swatch").forEach((inp) =>
    inp.addEventListener("change", () => save(inp.dataset.tag, inp.value, "Color saved")));
  host.querySelectorAll(".preset").forEach((b) =>
    b.addEventListener("click", () => save(b.closest(".tm-row").dataset.tag, b.dataset.c, "Color saved")));
  host.querySelectorAll(".tm-reset").forEach((b) =>
    b.addEventListener("click", () => save(b.dataset.tag, "", "Reset to automatic color")));
}

async function initTags() {
  await loadSettings();
  try { await loadAll(); } catch (e) { return; }
  renderTags();
}

// ---- Dispatch ---------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  if (document.getElementById("login-form")) return initLogin();
  if (document.getElementById("register-form")) return initRegister();
  if (!getToken()) { location.href = PREFIX + "login"; return; }
  fillSidebar();
  if (document.getElementById("cal-grid")) return initDashboard();
  if (document.getElementById("week-days")) return initEntries();
  if (document.getElementById("users-body")) return initAdmin();
  if (document.getElementById("tags-manage")) return initTags();
  if (document.getElementById("acc-username")) return initAccount();
});
