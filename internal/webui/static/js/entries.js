// entries.js -- everything only the entries page needs.
// core.js holds what every page shares and is loaded first; the
// registerPage call at the bottom hooks this into its page registry.

const ENTRIES_VIEW_KEY = "tagged_web_entries_view";  // "list" | "timeline"
function workdaySet() { return new Set(WORKDAY_PRESETS[PREFS.workdays] || WORKDAY_PRESETS["mon-fri"]); }
let syncTimer = null;
// startAutoSync begins polling for external changes. Safe to call once per page.
function startAutoSync(onChange, intervalMs = 4000) {
  if (syncTimer) clearInterval(syncTimer);
  lastSync = Date.now() / 1000;   // baseline: only care about changes from here on
  syncTimer = setInterval(() => syncUpdates(onChange), intervalMs);
  // Catch up right away when the tab regains focus (timers throttle while hidden).
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncUpdates(onChange); });
}
function fmtColon(sec) { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 3600) + ":" + pad(Math.floor((sec % 3600) / 60)); }
function entryCard(r) {
  const descText = (r.ds || "").replace(RE_TAG_G, "").trim();
  const tags = allTagsOf(r.ds);
  const dotColor = tags.length ? colorFor(tags[0].slice(1).toLowerCase()) : "var(--accent)";
  const tagBadges = tags.map((t) => badge(t.slice(1).toLowerCase())).join("");
  return `<div class="te-card" data-key="${escapeHtml(r.key)}">
    <span class="te-dot" style="background:${dotColor}"></span>
    <div class="te-time"><div class="t1">${clock(r.t1)}</div><div class="t2">${clock(r.t2)}</div></div>
    <div class="te-body"><div class="te-desc ${descText ? "" : "none"}">${descText ? escapeHtml(descText) : escapeHtml(t("No description"))}</div>${tagBadges ? `<div class="te-tags">${tagBadges}</div>` : ""}</div>
    <div class="te-dur">${fmtHM(recDur(r))}</div>
    <div class="te-menu"><button class="te-menu-btn" aria-label="Menu">⋯</button><div class="menu-pop"><button class="resume">${escapeHtml(t("Resume"))}</button><button class="edit">${escapeHtml(t("Edit"))}</button><button class="delete danger-btn">${escapeHtml(t("Delete"))}</button></div></div>
  </div>`;
}
// Mirrors the users/roles/groups pages: clicking a row selects it, and the side
// panel shows the read-only detail cards plus the actions for that record.

let ENTRY_SELECTED = null; // key of the entry shown in the panel, or null
function selectEntry(key) {
  ENTRY_SELECTED = key;
  markEntrySelection();
  renderEntryDetails();
}
// markEntrySelection repaints just the selected state. Selection is the one
// change that does not need renderEntriesPage — rebuilding the timeline under
// the cursor on every click would be both wasteful and jarring.
function markEntrySelection() {
  document.querySelectorAll(".te-card, .tl-block").forEach((el) => {
    el.classList.toggle("selected", el.dataset.key === ENTRY_SELECTED);
  });
}
function renderEntryDetails() {
  const host = document.getElementById("entry-details");
  if (!host) return; // other pages reuse renderEntriesPage's helpers
  const r = ENTRY_SELECTED ? ALL.find((x) => x.key === ENTRY_SELECTED) : null;
  if (!r) {
    host.classList.remove("filled");
    host.innerHTML = `<div class="um-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
      <p>${escapeHtml(t("Select an entry to view its details and actions."))}</p>
    </div>`;
    return;
  }

  const descText = (r.ds || "").replace(RE_TAG_G, "").trim();
  const tags = allTagsOf(r.ds);
  const dotColor = tags.length ? colorFor(tags[0].slice(1).toLowerCase()) : "var(--accent)";
  const day = new Date(r.t1 * 1000);

  const head = `<div class="ud-head">
    <span class="ed-dot" style="background:${dotColor}"></span>
    <div class="ud-id">
      <div class="ud-name-row">
        <span class="ud-name">${descText ? escapeHtml(descText) : "No description"}</span>
      </div>
      <div class="ud-username">${escapeHtml(fmtLongDate(day))}</div>
    </div>
  </div>`;

  const detailsCard = udCard(t("Details"), [
    udRow(t("Date"), escapeHtml(fmtLongDate(day))),
    udRow(t("Start"), clock(r.t1)),
    udRow(t("End"), clock(r.t2)),
    udRow(t("Duration"), fmtHM(recDur(r))),
  ].join(""), `<button class="secondary btn-sm" id="d-edit-entry">${escapeHtml(t("Edit"))}</button>`);

  const tagsCard = udCard(t("Tags"), tags.length
    ? `<div class="ud-roles">${tags.map((t) => badge(t.slice(1).toLowerCase())).join("")}</div>`
    : `<p class="muted um-note">${escapeHtml(t("No tags on this entry."))}</p>`);

  const actions = `<div class="ud-stack">
    <button id="d-entry-resume">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true" style="vertical-align:-2px;margin-right:6px"><path d="M8 5v14l11-7z"/></svg>
      ${escapeHtml(t("Resume entry"))}
    </button>
    <button class="secondary" id="d-entry-edit">${escapeHtml(t("Edit entry"))}</button>
    <button class="danger-btn" id="d-entry-delete">${escapeHtml(t("Delete entry"))}</button>
  </div>`;

  host.classList.add("filled");
  host.innerHTML = head + detailsCard + tagsCard + actions;

  const on = (id, fn) => { const el = host.querySelector(id); if (el) el.addEventListener("click", fn); };
  on("#d-edit-entry", () => openEntryModal(r));
  on("#d-entry-resume", () => resumeEntry(r));
  on("#d-entry-edit", () => openEntryModal(r));
  on("#d-entry-delete", () => deleteEntry(r));
}
// resumeEntry starts the sidebar timer again on an entry's description and
// tags, the way the original TimeTagger's "Resume" does. That app models a
// running record as one with t1 == t2; here the running clock lives in
// timerState and only becomes a record on stop, so resuming means seeding the
// timer rather than writing anything.
async function resumeEntry(r) {
  // Capture the text before any await: stopTimer reloads ALL, which replaces
  // the record objects this one came from.
  const desc = (r.ds || "").replace(RE_TAG_G, "").trim();
  const tags = [...new Set(allTagsOf(r.ds).map((t) => t.slice(1).toLowerCase()))];

  // Only one clock can run at a time, so bank the current one first — the same
  // thing the original does when it stops other running records.
  const wasRunning = timerState.running;
  if (wasRunning) await stopTimer();

  timerState.desc = desc;
  timerState.tags = tags;
  timerState.running = true;
  timerState.startEpoch = Math.floor(Date.now() / 1000);
  saveTimerState();
  timerTickStart();
  updateTimerUI();
  toast(wasRunning
    ? `Resumed ${desc || "entry"} — previous timer stopped`
    : `Resumed ${desc || "entry"}`, "ok");
}
// fmtLongDate renders "Saturday, Jul 18 2026" for the panel header.
function fmtLongDate(d) {
  return t("{weekday}, {month} {d} {year}", { weekday: weekdayName(d.getDay()), month: monthShort(d.getMonth()), d: d.getDate(), year: d.getFullYear() });
}
// deleteEntry soft-deletes a record after confirmation. Shared by the details
// panel, the row menu and the editor, so all three ask the same question.
// Returns true when the entry was actually deleted.
async function deleteEntry(r) {
  if (!(await confirmModal({
    title: t("Delete entry"),
    body: t("Delete this entry? This cannot be undone."),
  }))) return false;
  await putRecord({ key: r.key, mt: Math.floor(Date.now() / 1000), t1: r.t1, t2: r.t2, ds: "HIDDEN " + (r.ds || "") });
  if (ENTRY_SELECTED === r.key) ENTRY_SELECTED = null;
  toast(t("Entry deleted"), "ok");
  await loadAll();
  renderEntriesPage();
  return true;
}
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
  if (sameDay) return t("{weekday}, {month} {d}", { weekday: weekdayName(a.getDay()), month: monthShort(a.getMonth()), d: a.getDate() });
  const mA = monthShort(a.getMonth()), mB = monthShort(b.getMonth());
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
  for (let ts = tlFloorToStep(tlStart, step); ts <= tlEnd; ts += step) {
    if (ts < tlStart) continue;
    const y = (ts - tlStart) * pxPerSec;
    const d = new Date(ts * 1000);
    const isDay = d.getHours() === 0 && d.getMinutes() === 0;
    let label;
    if (step >= 86400) label = `${dowShort(d.getDay())} ${d.getDate()}`;
    else if (isDay) label = t("{month} {d}", { month: monthShort(d.getMonth()), d: d.getDate() });
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

  canvas.querySelectorAll(".tl-block").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      selectEntry(el.dataset.key);
    });
    // Double-click still jumps straight to the editor, for anyone who does not
    // want the detour through the panel.
    el.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const r = ALL.find((x) => x.key === el.dataset.key);
      if (r) openEntryModal(r);
    });
  });
  markEntrySelection();
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
    cells.push(`<div class="wday ${sel ? "sel" : ""} ${has ? "has" : ""} ${off ? "offday" : ""}" data-i="${i}"><div class="dow">${dowShort(d.getDay())}</div><div class="dnum">${d.getDate()}</div><div class="dtot">${sel ? fmtHM(tot) : fmtColon(tot)}</div><div class="wdot"></div></div>`);
  }
  const daysEl = document.getElementById("week-days");
  daysEl.innerHTML = cells.join("");
  daysEl.querySelectorAll(".wday").forEach((el) => el.addEventListener("click", () => {
    selDate = midnight(addDays(wStart, Number(el.dataset.i)));
    tlStart = selDate.getTime() / 1000;  // scroll the timeline to the picked day
    renderEntriesPage();
  }));
  document.getElementById("week-total").textContent = fmtHM(weekTotal);

  document.getElementById("day-title").textContent = t("{weekday}, {month} {d}", { weekday: weekdayName(selDate.getDay()), month: monthShort(selDate.getMonth()), d: selDate.getDate() });
  const [ds, de] = dayRange(selDate);
  const dayRecs = ALL.filter((r) => r.t1 >= ds && r.t1 < de).sort((a, b) => a.t1 - b.t1);
  document.getElementById("day-total").textContent = fmtHM(dayRecs.reduce((a, r) => a + recDur(r), 0));

  const list = document.getElementById("te-list");
  list.innerHTML = dayRecs.length ? dayRecs.map(entryCard).join("") : `<div class="empty">${escapeHtml(t("No entries for this day."))}</div>`;

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
    const r = ALL.find((x) => x.key === b.closest(".te-card").dataset.key);
    if (r) await deleteEntry(r);
  }));
  list.querySelectorAll(".menu-pop .edit").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllMenus();
    const r = ALL.find((x) => x.key === b.closest(".te-card").dataset.key);
    if (r) openEntryModal(r);
  }));
  list.querySelectorAll(".menu-pop .resume").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllMenus();
    const r = ALL.find((x) => x.key === b.closest(".te-card").dataset.key);
    if (r) resumeEntry(r);
  }));
  // Clicking a card (outside its menu) selects it; the details panel then
  // carries the actions. Double-click keeps the old shortcut to the editor.
  list.querySelectorAll(".te-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".te-menu")) return;
      selectEntry(card.dataset.key);
    });
    card.addEventListener("dblclick", (e) => {
      if (e.target.closest(".te-menu")) return;
      const r = ALL.find((x) => x.key === card.dataset.key);
      if (r) openEntryModal(r);
    });
  });

  renderTimeline();

  // Drop a selection whose record is gone (deleted, or edited out of view), so
  // the panel never describes a record that no longer exists.
  if (ENTRY_SELECTED && !ALL.some((x) => x.key === ENTRY_SELECTED)) ENTRY_SELECTED = null;
  markEntrySelection();
  renderEntryDetails();
}
let emKey = null;   // key of the record being edited, or null for a new entry
let emTags = [];    // tag keys currently on the entry
let emAdding = false;
function emError(text) { document.getElementById("em-msg").textContent = text || ""; }
function renderEmTags() {
  const host = document.getElementById("em-tags");
  host.innerHTML = emTags.length
    ? emTags.map((t) => {
        const c = colorFor(t);
        return `<span class="em-tag-chip" style="background:${c}26;color:${c}">${escapeHtml(labelFor(t) || ("#" + t))}<button class="x" data-t="${escapeHtml(t)}" type="button" aria-label="Remove">×</button></span>`;
      }).join("")
    : `<span class="em-none">${escapeHtml(t("No tags yet."))}</span>`;
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
    (items || `<div class="em-tag-empty">${escapeHtml(t("No saved tags"))}</div>`) +
    '<div class="em-tag-sep"></div>' +
    `<button type="button" class="em-tag-new">＋ ${escapeHtml(t("New tag…"))}</button>`;

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
  const tag = normalizeTag(raw);
  if (tag && !emTags.includes(tag)) emTags.push(tag);
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
  document.getElementById("em-title").textContent = rec ? t("Edit entry") : t("New entry");
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
  if (isNaN(t1) || isNaN(t2)) { emError(t("Enter a valid start and end time.")); return; }
  if (t2 < t1) { emError(t("End must be after start.")); return; }
  let ds = descText;
  if (emTags.length) ds = (descText + " " + emTags.map((t) => "#" + t).join(" ")).trim();
  const editing = !!emKey;
  const key = emKey || randomKey();
  const ok = await putRecord({ key, mt: Math.floor(Date.now() / 1000), t1, t2, ds });
  if (!ok) { emError(t("Failed to save.")); return; }
  toast(editing ? t("Entry updated") : t("Entry saved"), "ok");
  closeEntryModal();
  await loadAll();
  renderEntriesPage();
}
async function deleteEntryModal() {
  const r = emKey ? ALL.find((x) => x.key === emKey) : null;
  if (!r) return;
  if (await deleteEntry(r)) closeEntryModal();
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
  if (period === "month") return t("{month} {year}", { month: monthShort(d.getMonth()), year: y });
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
    if (row[0] === "total") html += `<tr class="total"><th class="num">${escapeHtml(row[1])}</th><th colspan="4">${escapeHtml(t("Total"))}</th></tr>`;
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
    if (row[0] === "total") body += `<tr class="tot"><td class="n">${escapeHtml(row[1])}</td><td colspan="4">${escapeHtml(t("Total"))}</td></tr>`;
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
  registerRefresh(renderEntriesPage);

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

registerPage("week-days", initEntries);
