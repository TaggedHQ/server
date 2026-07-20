// shifts.js -- everything only the shifts page needs.
// core.js holds what every page shares and is loaded first; the
// registerPage call at the bottom hooks this into its page registry.

// A week grid of planned shifts, split into two sections: open shifts the group
// still needs to fill, and scheduled shifts naming who is on which day.
//
// The whole page is one round-trip: GET api/v2/shifts?from=...&to=... returns
// the shifts, the groups the caller may see, and the catalog (roles, locations,
// working areas) they refer to. That is one endpoint rather than several because
// the grid cannot draw anything useful from a subset -- it needs the shifts, the
// people they name and the colours to draw them all for the same week -- and
// the server already assembles all three from the same permission check.
//
// Managers plan; members pick up. The two roles are the same page with different
// affordances: `manage` on a group unlocks the add and edit buttons; being a
// `member` of the group unlocks Pick up on any open shift there. See shifts.go
// for how those are decided; the page just draws what the API says.

let PL_DATA = { shifts: [], groups: [], roles: [], locations: [], areas: [], me: "" };
let PL_WEEK = null;              // Date: midnight of the displayed week's first day
let PL_CAL = null;               // Date: first of the month the mini calendar shows
let PL_SEL = null;               // id of the selected shift
let PL_COLLAPSED = new Set();    // group ids collapsed in the grid
let PL_TAB = "schedule";
let PL_EDIT = null;              // {id} when editing, {group, date} when creating
// Notes are a per-day, per-group memo kept in localStorage. They are not a
// server concept -- they are the planner's own working scratch, so they travel
// with the browser rather than adding a table just to remember "stocktake".
let PL_NOTES = loadNotes();
// Filters are what the pill row along the top holds. Each is a Set of selected
// values; an empty set means "no filter", not "match nothing". This matches how
// the mockup labels them ("Location 1", "Working area 1", "Role All").
let PL_FILTER = { location: new Set(), area: new Set(), role: new Set(), tag: new Set() };
let PL_FILTER_OPEN = null;       // which filter menu is on screen, so a second click closes it
function shiftsMsg() { return document.getElementById("shifts-msg"); }
function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function plDays() { return Array.from({ length: 7 }, (_, i) => addDays(PL_WEEK, i)); }
function shiftContractedMinutes() { return 40 * 60; }
// shiftMinutes returns a shift's length, treating an end at or before the start
// as running past midnight (a 22:00 – 06:00 night is 8h, not -16h).
function shiftMinutes(s) {
  if (s.type === "absence") return 0;
  const [sh, sm] = s.start.split(":").map(Number);
  const [eh, em] = s.end.split(":").map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60;
  return mins;
}
function plTotalMins(list) { return list.reduce((a, s) => a + shiftMinutes(s), 0); }
function shiftIsOpen(s) { return s.type !== "absence" && (s.assignees || []).length < (s.slots || 1); }
function shiftAssignees(s) { return s.assignees || []; }
function shiftUsernames(s) { return shiftAssignees(s).map((a) => a.user); }
function groupOf(id) { return PL_DATA.groups.find((g) => g.id === id); }
function memberOf(username) {
  for (const g of PL_DATA.groups) {
    const m = (g.members || []).find((x) => x.username === username);
    if (m) return { group: g, member: m };
  }
  return null;
}
function plMemberName(m) { return displayName(m.username, m.profile); }
function plMemberInitials(m) { return initials(m.username, m.profile); }
function plName(username) { const m = memberOf(username); return m ? plMemberName(m.member) : username; }
function roleDef(id) { return PL_DATA.roles.find((r) => r.id === id) || null; }
function roleColor(id) { const r = roleDef(id); return r ? r.color : "var(--stroke-strong)"; }
function roleName(id) { const r = roleDef(id); return r ? r.name : ""; }
function locName(id) { const l = PL_DATA.locations.find((x) => x.id === id); return l ? l.name : ""; }
function areaName(id) { const a = PL_DATA.areas.find((x) => x.id === id); return a ? a.name : ""; }
// Filters apply on top of what the API already returned. Doing it here rather
// than round-tripping means opening the Role menu is instant, and the day totals
// under the grid always reflect what the viewer is actually looking at.
function applyFilters(list) {
  return list.filter((s) => {
    if (PL_FILTER.location.size && !PL_FILTER.location.has(s.location || "")) return false;
    if (PL_FILTER.area.size && !PL_FILTER.area.has(s.area || "")) return false;
    if (PL_FILTER.role.size && !PL_FILTER.role.has(s.role || "")) return false;
    if (PL_FILTER.tag.size) {
      const tags = new Set(s.tags || []);
      let hit = false;
      for (const t of PL_FILTER.tag) if (tags.has(t)) { hit = true; break; }
      if (!hit) return false;
    }
    return true;
  });
}
function weekShifts() {
  const from = ymd(PL_WEEK), to = ymd(addDays(PL_WEEK, 6));
  return applyFilters(PL_DATA.shifts.filter((s) => s.date >= from && s.date <= to));
}
// One endpoint fills the page, one per mutation writes back. Every write is
// followed by a reload of the visible week: the server is the source of truth,
// and a claim by another person moves the shift out from under an out-of-date
// local copy.
async function loadShifts() {
  const from = ymd(PL_WEEK), to = ymd(addDays(PL_WEEK, 6));
  try {
    const r = await apiFetch(`shifts?from=${from}&to=${to}`);
    if (!r.ok) throw new Error(await r.text());
    // An empty list arrives as JSON null from a Go nil slice, and the render
    // path indexes into all five without asking. Normalising on the way in
    // keeps that guard in one place instead of at every .map call site.
    const raw = await r.json();
    PL_DATA = {
      me: raw.me || "",
      shifts: raw.shifts || [],
      groups: (raw.groups || []).map((g) => Object.assign({}, g, { members: g.members || [] })),
      roles: raw.roles || [],
      locations: raw.locations || [],
      areas: raw.areas || [],
    };
    if (PL_SEL && !PL_DATA.shifts.some((s) => s.id === PL_SEL)) PL_SEL = null;
    renderShifts();
  } catch (err) {
    showMsg(shiftsMsg(), "Could not load shifts: " + err.message, "error");
  }
}
function renderPlTiles() {
  const list = weekShifts();
  const scheduled = list.filter((s) => s.type !== "absence" && !shiftIsOpen(s));
  const openList = list.filter((s) => shiftIsOpen(s));
  const absences = list.filter((s) => s.type === "absence");
  // A slot needing two people counts as two shifts of load, so plTotalMins is
  // multiplied by the fraction filled -- one taker on a two-slot 8h shift is
  // 8h, not 16h. Contract math treats the shift as many-people-many-hours.
  const load = scheduled.reduce((a, s) => a + shiftMinutes(s) * shiftAssignees(s).length, 0);
  const openMins = openList.reduce((a, s) => a + shiftMinutes(s) * ((s.slots || 1) - shiftAssignees(s).length), 0);
  const total = load + openMins;
  const covered = total > 0 ? Math.round((load / total) * 100) : 100;
  const members = PL_DATA.groups.reduce((a, g) => a + (g.members || []).length, 0);
  const contracted = members * shiftContractedMinutes();
  const over = Math.max(0, load - contracted);
  const openSlots = openList.reduce((a, s) => a + ((s.slots || 1) - shiftAssignees(s).length), 0);
  const tiles = [
    { k: "Total scheduled", v: fmtHM(load * 60), sub: `${scheduled.length} shift${scheduled.length === 1 ? "" : "s"} across ${members} member${members === 1 ? "" : "s"}` },
    { k: "Coverage", v: covered + "%", sub: openSlots ? `${openSlots} slot${openSlots === 1 ? "" : "s"} unfilled` : "All shifts covered", pos: !openSlots },
    { k: "Overtime (est.)", v: fmtHM(over * 60), sub: load ? `${((over / load) * 100).toFixed(1)}% of total` : "—" },
    { k: "Open shifts", v: String(openList.length), sub: "This week" },
    { k: "Absences", v: String(absences.length), sub: "This week" },
  ];
  document.getElementById("sh-tiles").innerHTML = tiles.map((t) => `
    <div class="tile">
      <div class="k">${escapeHtml(t.k)}</div>
      <div class="v">${escapeHtml(t.v)}</div>
      <div class="sub${t.pos ? " pos" : ""}">${escapeHtml(t.sub)}</div>
    </div>`).join("");
}
function renderPlFilters() {
  const host = document.getElementById("pl-filters");
  const defs = [
    { key: "location", label: "Location", opts: PL_DATA.locations.map((l) => ({ v: l.id, n: l.name })) },
    { key: "area", label: "Working area", opts: PL_DATA.areas.map((a) => ({ v: a.id, n: a.name })) },
    { key: "role", label: "Role", opts: PL_DATA.roles.map((r) => ({ v: r.id, n: r.name })) },
    { key: "tag", label: "Tags", opts: collectTagOptions() },
  ];
  host.innerHTML = defs.map((d) => {
    const sel = PL_FILTER[d.key];
    const on = sel.size > 0;
    const count = on ? `<span class="pl-fc">${sel.size}</span>` : `<span class="muted" style="font-size:.72rem">All</span>`;
    const clear = on ? `<span class="pl-fx" data-clear="${escapeHtml(d.key)}" title="Clear">×</span>` : "";
    return `<div class="pl-filter${on ? " on" : ""}" data-filter="${escapeHtml(d.key)}">
      <span class="pl-fl">${escapeHtml(d.label)}</span>
      ${count}
      <svg class="pl-fcaret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      ${clear}
    </div>`;
  }).join("");
  host.querySelectorAll(".pl-filter").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.matches("[data-clear]")) {
        PL_FILTER[e.target.dataset.clear].clear();
        renderShifts();
        return;
      }
      openFilterMenu(el, el.dataset.filter, defs.find((x) => x.key === el.dataset.filter).opts);
    });
  });
}
function collectTagOptions() {
  const seen = new Map();
  for (const s of PL_DATA.shifts) for (const t of (s.tags || [])) seen.set(t, t);
  return Array.from(seen.values()).sort().map((v) => ({ v, n: v }));
}
function openFilterMenu(anchor, key, opts) {
  if (PL_FILTER_OPEN && PL_FILTER_OPEN.remove) PL_FILTER_OPEN.remove();
  if (PL_FILTER_OPEN && PL_FILTER_OPEN.dataset && PL_FILTER_OPEN.dataset.key === key) { PL_FILTER_OPEN = null; return; }
  const menu = document.createElement("div");
  menu.className = "pl-fmenu";
  menu.dataset.key = key;
  const sel = PL_FILTER[key];
  menu.innerHTML = opts.length
    ? opts.map((o) => `<label><input type="checkbox" value="${escapeHtml(o.v)}" ${sel.has(o.v) ? "checked" : ""}> ${escapeHtml(o.n)}</label>`).join("")
    : `<label class="muted" style="cursor:default">Nothing to filter</label>`;
  anchor.appendChild(menu);
  PL_FILTER_OPEN = menu;
  menu.querySelectorAll("input").forEach((cb) => cb.addEventListener("change", () => {
    if (cb.checked) sel.add(cb.value); else sel.delete(cb.value);
    renderPlFilters();
    renderPlanner();
    renderPlTiles();
  }));
  // Click outside closes it. Registered on the next tick so this very click
  // does not immediately kill the menu we just opened.
  setTimeout(() => {
    const off = (e) => { if (!menu.contains(e.target)) { menu.remove(); PL_FILTER_OPEN = null; document.removeEventListener("mousedown", off); } };
    document.addEventListener("mousedown", off);
  }, 0);
}
// Each visible group renders as two sections: OPEN SHIFTS (a Manager's + Add
// column plus one row of open cells per day) and SCHEDULED SHIFTS (one row per
// member). Every group is drawn in its own block so a member's row stays under
// the group they are in, which is how the mockup reads.
function renderPlanner() {
  const grid = document.getElementById("pl-grid");
  const days = plDays();
  const todayKey = ymd(new Date());
  const list = weekShifts();
  const dayNoteKey = (gid, date) => gid + "|" + date;

  // Column headers with a day-note line under each date.
  let html = `<div class="pl-head pl-mem"><span></span></div>`;
  html += days.map((d) => {
    const key = ymd(d);
    const todayCls = key === todayKey ? " today" : "";
    return `<div class="pl-head${todayCls}">
      <div>${dowShort(d.getDay())} ${d.getDate()}</div>
      <button class="pl-note" data-note-day="${key}" title="Day note">Notes</button>
    </div>`;
  }).join("");

  // Nothing to plan against. The roster is built on groups, so this is the
  // state a fresh server lands in, and a bare header strip would read as a
  // broken page rather than an unfinished setup. Point at the fix instead.
  if (!PL_DATA.groups.length) {
    grid.innerHTML = html + `<div class="pl-band" style="grid-column:1 / -1">No groups</div>
      <div style="grid-column:1 / -1" class="um-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3"/><path d="M6 20v-1a6 6 0 0 1 12 0v1"/></svg>
        <p>Shifts are planned per group. You are not in a group, and you do not control one.</p>
      </div>`;
    return;
  }

  for (const g of PL_DATA.groups) {
    const gShifts = list.filter((s) => s.group === g.id);
    const collapsed = PL_COLLAPSED.has(g.id);
    const totalMins = gShifts
      .filter((s) => s.type !== "absence")
      .reduce((a, s) => a + shiftMinutes(s) * shiftAssignees(s).length, 0);
    html += `<div class="pl-group${collapsed ? " collapsed" : ""}" data-group="${escapeHtml(g.id)}">
      <svg class="pl-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      <span class="pl-gname">${escapeHtml(g.name)}</span>
      <span class="pl-gtot">${escapeHtml(fmtHM(totalMins * 60))} scheduled</span>
    </div>`;
    if (collapsed) continue;

    // OPEN SHIFTS section: a header band, the "+ Add shift" cell, and the row
    // of open-slot cards per day. Even a group with nothing open shows the row
    // so a manager has a place to click Add.
    html += `<div class="pl-band">Open shifts</div>`;
    const addCell = g.manage
      ? `<button class="pl-empty" data-add-open="${escapeHtml(g.id)}"><span>+ Add shift</span></button>`
      : `<span class="muted" style="padding:12px 16px">Open shifts</span>`;
    html += `<div class="pl-mem" style="border-right:1px solid var(--stroke)">${addCell}</div>`;
    html += days.map((d) => {
      const key = ymd(d);
      const cellShifts = gShifts.filter((s) => s.date === key && shiftIsOpen(s));
      const cls = (key === todayKey ? " today" : "") + (d.getDay() === 0 || d.getDay() === 6 ? " weekend" : "");
      const cards = cellShifts.map((s) => plChip(s, PL_DATA.me)).join("");
      const add = g.manage ? `<button class="pl-empty" data-add-open="${escapeHtml(g.id)}" data-date="${escapeHtml(key)}"><span>+</span></button>` : "";
      return `<div class="pl-cell${cls}${cellShifts.length ? " has" : ""}">${cards}${add}</div>`;
    }).join("");
    // Group hours strip under open shifts.
    html += `<div class="pl-tot pl-mem">Group hours</div>`;
    html += days.map((d) => {
      const key = ymd(d);
      const mins = gShifts.filter((s) => s.date === key && s.type !== "absence")
        .reduce((a, s) => a + shiftMinutes(s) * ((s.slots || 1) - shiftAssignees(s).length + shiftAssignees(s).length), 0);
      return `<div class="pl-tot">${mins ? escapeHtml(fmtHM(mins * 60)) : ""}</div>`;
    }).join("");

    // SCHEDULED SHIFTS: one row per member. Members without any shift this week
    // still render, because seeing an empty row is how a manager notices they
    // have not been given one.
    html += `<div class="pl-band">Scheduled shifts</div>`;
    for (const m of (g.members || [])) {
      const own = gShifts.filter((s) => s.type !== "absence" && shiftUsernames(s).includes(m.username));
      const ownMins = own.reduce((a, s) => a + shiftMinutes(s), 0);
      const contracted = shiftContractedMinutes();
      const cls = ownMins > contracted ? " over" : ownMins === contracted ? " full" : "";
      html += `<div class="pl-mem">
        <span class="avatar sm">${escapeHtml(plMemberInitials(m))}</span>
        <span style="min-width:0;flex:1">
          <div class="pl-mn">${escapeHtml(plMemberName(m))}</div>
          <div class="pl-mr">${escapeHtml((m.profile && m.profile.job) || "")}</div>
        </span>
        <span class="pl-load${cls}">${escapeHtml(fmtHM(ownMins * 60))}/${escapeHtml(fmtHM(contracted * 60))}</span>
      </div>`;
      html += days.map((d) => {
        const key = ymd(d);
        const cellShifts = gShifts.filter((s) => s.date === key
          && (s.type === "absence" ? shiftUsernames(s).includes(m.username)
            : shiftUsernames(s).includes(m.username)));
        const cls = (key === todayKey ? " today" : "") + (d.getDay() === 0 || d.getDay() === 6 ? " weekend" : "");
        const cards = cellShifts.map((s) => plChip(s, PL_DATA.me)).join("");
        const add = g.manage ? `<button class="pl-empty" data-add-user="${escapeHtml(m.username)}" data-group="${escapeHtml(g.id)}" data-date="${escapeHtml(key)}"><span>+</span></button>` : "";
        return `<div class="pl-cell${cls}${cellShifts.length ? " has" : ""}">${cards}${add}</div>`;
      }).join("");
    }
    // Per-day totals under scheduled shifts.
    html += `<div class="pl-tot pl-mem">Day total</div>`;
    html += days.map((d) => {
      const key = ymd(d);
      const mins = gShifts.filter((s) => s.date === key && s.type !== "absence" && !shiftIsOpen(s))
        .reduce((a, s) => a + shiftMinutes(s) * shiftAssignees(s).length, 0);
      return `<div class="pl-tot">${mins ? escapeHtml(fmtHM(mins * 60)) : "—"}</div>`;
    }).join("");
  }
  grid.innerHTML = html;

  grid.querySelectorAll(".pl-group").forEach((el) => el.addEventListener("click", () => {
    const id = el.dataset.group;
    if (PL_COLLAPSED.has(id)) PL_COLLAPSED.delete(id); else PL_COLLAPSED.add(id);
    renderPlanner();
  }));
  grid.querySelectorAll(".pl-chip").forEach((el) => el.addEventListener("click", (e) => {
    e.stopPropagation();
    PL_SEL = el.dataset.shift;
    renderPlanner();
    renderPlDetails();
  }));
  grid.querySelectorAll("[data-add-open]").forEach((el) => el.addEventListener("click", (e) => {
    e.stopPropagation();
    openShiftModal(null, { group: el.dataset.addOpen, date: el.dataset.date || ymd(PL_WEEK), open: true });
  }));
  grid.querySelectorAll("[data-add-user]").forEach((el) => el.addEventListener("click", (e) => {
    e.stopPropagation();
    openShiftModal(null, { group: el.dataset.group, date: el.dataset.date, user: el.dataset.addUser });
  }));
  grid.querySelectorAll("[data-note-day]").forEach((el) => {
    const day = el.dataset.noteDay;
    const notes = PL_DATA.groups.filter((g) => g.manage).map((g) => PL_NOTES[dayNoteKey(g.id, day)]).filter(Boolean);
    if (notes.length) { el.textContent = notes[0]; el.classList.add("set"); }
    el.addEventListener("click", (e) => { e.stopPropagation(); openDayNote(day); });
  });
}
// plChip renders one shift card. `me` is the viewer's username, so the card can
// show "you're on this" without another lookup.
function plChip(s, me) {
  const c = roleColor(s.role);
  const sel = s.id === PL_SEL ? " selected" : "";
  const openCls = shiftIsOpen(s) ? " open" : "";
  const absCls = s.type === "absence" ? " absence" : "";
  const mine = shiftUsernames(s).includes(me) ? " mine" : "";
  const need = (s.slots || 1) - shiftAssignees(s).length;
  const slotsBadge = (s.slots || 1) > 1
    ? `<span class="pl-slots">${escapeHtml(String(need > 0 ? need : (s.slots || 1)))}</span>` : "";
  const roleLine = `<div class="pl-role">
      <span class="pl-rn">${escapeHtml(roleName(s.role) || (s.type === "absence" ? "Absence" : "Shift"))}</span>
      ${slotsBadge}
    </div>`;
  const timeLine = s.type === "absence"
    ? `<div class="pl-t">Away</div>`
    : `<div class="pl-t">${escapeHtml(s.start)} – ${escapeHtml(s.end)}</div>
       <div class="pl-h">${escapeHtml(fmtHM(shiftMinutes(s) * 60))}</div>`;
  const locLine = s.location || s.area
    ? `<div class="pl-loc">${escapeHtml([locName(s.location), areaName(s.area)].filter(Boolean).join(" · "))}</div>` : "";
  return `<button class="pl-chip${openCls}${absCls}${sel}${mine}" style="--c:${c}" data-shift="${escapeHtml(s.id)}">
    ${roleLine}${timeLine}${locLine}
  </button>`;
}
function renderPlDetails() {
  const host = document.getElementById("sh-details");
  const s = PL_DATA.shifts.find((x) => x.id === PL_SEL);
  if (!s) {
    host.innerHTML = `<div class="um-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4M16 3v4"/></svg>
      <p>Select a shift to see its details.</p>
    </div>`;
    return;
  }
  const g = groupOf(s.group);
  const canManage = g && g.manage;
  const isMember = g && g.member;
  const me = PL_DATA.me;
  const mine = shiftAssignees(s).find((a) => a.user === me);
  const canClaim = isMember && shiftIsOpen(s) && !mine;
  // Handing back a shift you took yourself: allowed. One a manager put you on:
  // not; see releaseShift. The button appears only when it will work.
  const canRelease = mine && mine.by === me;
  const c = roleColor(s.role);
  const d = new Date(s.date + "T00:00:00");
  const when = s.type === "absence" ? "Absent all day"
    : `${s.start} – ${s.end} (${fmtHM(shiftMinutes(s) * 60)})`;
  const need = (s.slots || 1) - shiftAssignees(s).length;
  const cover = s.type === "absence" ? "" : `<div class="sd-row">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/></svg>
      ${escapeHtml(shiftAssignees(s).length + " / " + (s.slots || 1))} covered
      ${need > 0 ? `<span class="badge" style="background:color-mix(in srgb, ${c} 16%, transparent);color:${c}">${need} open</span>` : ""}
    </div>`;
  const people = shiftAssignees(s).length
    ? shiftAssignees(s).map((a) => `<div class="sd-row">
        <span class="avatar sm" style="width:22px;height:22px;font-size:.62rem">${escapeHtml(plMemberInitials({ username: a.user, profile: (memberOf(a.user) && memberOf(a.user).member.profile) || {} }))}</span>
        <span>${escapeHtml(plName(a.user))}</span>
        <span class="muted" style="font-size:.68rem;margin-left:auto">${a.by === a.user ? "picked up" : "assigned"}</span>
      </div>`).join("")
    : `<div class="sd-row muted">Unassigned</div>`;
  const tags = (s.tags && s.tags.length)
    ? `<div class="sd-row" style="gap:5px;flex-wrap:wrap">${s.tags.map((t) => `<span class="badge muted">${escapeHtml(t)}</span>`).join("")}</div>` : "";

  host.innerHTML = `
    <div class="sd-when">${escapeHtml(when)}</div>
    <div class="sd-date">${escapeHtml(t("{weekday}, {d} {month} {year}", { weekday: weekdayName(d.getDay()), d: d.getDate(), month: monthName(d.getMonth()), year: d.getFullYear() }))}</div>
    <div class="sd-row"><span class="sd-dot" style="--c:${c}"></span>${escapeHtml(roleName(s.role) || (s.type === "absence" ? "Absence" : "Shift"))}</div>
    ${s.location || s.area ? `<div class="sd-row">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>
      ${escapeHtml([locName(s.location), areaName(s.area)].filter(Boolean).join(" · "))}
    </div>` : ""}
    ${cover}
    ${people}
    ${s.note ? `<div class="sd-row"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h12l4 4v12H4z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>${escapeHtml(s.note)}</div>` : ""}
    ${tags}
    <div class="sd-row" style="gap:6px;flex-wrap:wrap">
      <span class="badge muted">${escapeHtml(g ? g.name : s.group)}</span>
      ${s.type === "absence" ? `<span class="badge" style="background:color-mix(in srgb, #E5484D 16%, transparent);color:#E5484D">Absence</span>` : ""}
    </div>
    <div class="sd-actions">
      ${canClaim ? `<button id="sd-claim">Pick up</button>` : ""}
      ${canRelease ? `<button class="secondary btn-sm" id="sd-release">Hand back</button>` : ""}
      ${canManage ? `<button class="secondary btn-sm" id="sd-edit">Edit shift</button>` : ""}
      ${canManage ? `<button class="danger-btn" id="sd-del">Delete shift</button>` : ""}
    </div>`;
  const bind = (id, fn) => { const el = host.querySelector(id); if (el) el.addEventListener("click", fn); };
  bind("#sd-edit", () => openShiftModal(s.id));
  bind("#sd-del", () => deleteShift(s));
  bind("#sd-claim", () => claimShift(s));
  bind("#sd-release", () => releaseShift(s));
}
function renderPlStatus() {
  const list = weekShifts();
  const totals = PL_DATA.groups.map((g) => ({
    name: g.name,
    mins: list.filter((s) => s.group === g.id && s.type !== "absence")
      .reduce((a, s) => a + shiftMinutes(s) * shiftAssignees(s).length, 0),
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
  // The legend is a swatch per role, plus the two special states. A role that is
  // not in the catalog would not appear elsewhere on the page either, so the
  // list is anchored on the API data rather than a hardcoded set.
  const swatches = PL_DATA.roles.map((r) => ({ label: r.name, color: r.color, window: "" }))
    .concat([
      { label: "Open shift", color: "var(--stroke-strong)", window: "unassigned" },
      { label: "Absence", color: "#E5484D", window: "away" },
    ]);
  document.getElementById("sh-legend").innerHTML = swatches.map((k) => `
    <div class="sh-leg"><span class="dot" style="--c:${k.color}"></span>${escapeHtml(k.label)} ${k.window ? `<span class="muted">(${escapeHtml(k.window)})</span>` : ""}</div>`).join("");
}
function renderPlCal() {
  const grid = document.getElementById("sh-cal-grid");
  document.getElementById("sh-cal-title").textContent = t("{month} {year}", { month: monthName(PL_CAL.getMonth()), year: PL_CAL.getFullYear() });
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
  for (const g of PL_DATA.groups) {
    for (const m of (g.members || [])) {
      const own = list.filter((s) => s.type !== "absence" && shiftUsernames(s).includes(m.username));
      rows.push(`<tr>
        <td>
          <div class="um-user"><span class="avatar sm">${escapeHtml(plMemberInitials(m))}</span><span class="um-name">${escapeHtml(plMemberName(m))}</span></div>
          <div class="rl-desc">${escapeHtml((m.profile && m.profile.job) || "")}</div>
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
  renderPlFilters();
  renderPlTiles();
  renderPlanner();
  renderPlDetails();
  renderPlStatus();
  renderPlCal();
  renderPlTeam();
  renderPlLegend();
}
function setPlWeek(d) {
  PL_WEEK = weekStartOf(d);
  PL_CAL = new Date(PL_WEEK.getFullYear(), PL_WEEK.getMonth(), 1);
  loadShifts();
}
function loadNotes() {
  try { return JSON.parse(localStorage.getItem("shift_day_notes") || "{}"); } catch { return {}; }
}
function saveNotes() { localStorage.setItem("shift_day_notes", JSON.stringify(PL_NOTES)); }
function openDayNote(day) {
  // The note is per group, but a member only ever sees one group's, so this
  // simple modal edits every visible group's note for the day in one field: the
  // grid then draws the same text under that column for the groups it applies
  // to. Different notes per group in the same viewer are rare enough that
  // asking for them here would be more setup than most sessions need.
  const gid = (PL_DATA.groups.find((g) => g.manage) || PL_DATA.groups[0] || {}).id;
  if (!gid) return;
  const key = gid + "|" + day;
  document.getElementById("sh-note-input").value = PL_NOTES[key] || "";
  document.getElementById("sh-note-title").textContent = "Note for " + day;
  document.getElementById("sh-note-modal").hidden = false;
  document.getElementById("sh-note-input").focus();
  document.getElementById("sh-note-save").onclick = () => {
    const v = document.getElementById("sh-note-input").value.trim();
    if (v) PL_NOTES[key] = v; else delete PL_NOTES[key];
    saveNotes();
    document.getElementById("sh-note-modal").hidden = true;
    renderPlanner();
  };
  document.getElementById("sh-note-cancel").onclick = () => { document.getElementById("sh-note-modal").hidden = true; };
}
function openShiftModal(id, seed) {
  const s = id ? PL_DATA.shifts.find((x) => x.id === id) : null;
  PL_EDIT = s ? { id: s.id, group: s.group } : (seed || {});
  document.getElementById("sh-modal-title").textContent = s ? "Edit shift" : "New shift";
  document.getElementById("sh-modal-msg").innerHTML = "";

  const manageableGroups = PL_DATA.groups.filter((g) => g.manage);
  const groupSel = document.getElementById("sh-f-group");
  groupSel.innerHTML = manageableGroups.map((g) =>
    `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join("");
  groupSel.value = s ? s.group : (seed && seed.group) || (manageableGroups[0] && manageableGroups[0].id) || "";
  // Editing a shift never moves it between groups (see saveShift), and the
  // picker offering a value that would be rejected is worse than leaving it
  // read-only for that case.
  groupSel.disabled = !!s;

  const roleSel = document.getElementById("sh-f-role");
  roleSel.innerHTML = `<option value="">No role</option>` + PL_DATA.roles.map((r) =>
    `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`).join("");
  roleSel.value = s ? (s.role || "") : "";

  const locSel = document.getElementById("sh-f-loc");
  locSel.innerHTML = `<option value="">Any</option>` + PL_DATA.locations.map((l) =>
    `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join("");
  locSel.value = s ? (s.location || "") : "";

  const areaSel = document.getElementById("sh-f-area");
  areaSel.innerHTML = `<option value="">Any</option>` + PL_DATA.areas.map((a) =>
    `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`).join("");
  areaSel.value = s ? (s.area || "") : "";

  document.getElementById("sh-f-date").value = s ? s.date : (seed && seed.date) || ymd(PL_WEEK);
  document.getElementById("sh-f-start").value = s ? s.start : "09:00";
  document.getElementById("sh-f-end").value = s ? s.end : "17:00";
  document.getElementById("sh-f-slots").value = String(s ? (s.slots || 1) : 1);
  document.getElementById("sh-f-type").value = s ? (s.type || "shift") : "shift";
  document.getElementById("sh-f-tags").value = s ? (s.tags || []).join(", ") : "";
  document.getElementById("sh-f-note").value = s ? (s.note || "") : "";

  renderAssignPicker(groupSel.value, s ? shiftUsernames(s) : (seed && seed.user ? [seed.user] : []));
  groupSel.addEventListener("change", () => renderAssignPicker(groupSel.value, [])); // fresh group → clear picks

  document.getElementById("sh-modal").hidden = false;
  document.getElementById("sh-f-start").focus();
}
function renderAssignPicker(gid, chosen) {
  const g = groupOf(gid);
  const host = document.getElementById("sh-f-assign");
  const members = g ? (g.members || []) : [];
  if (!members.length) { host.innerHTML = `<label class="muted" style="cursor:default">This group has no members</label>`; return; }
  const picked = new Set(chosen);
  host.innerHTML = members.map((m) =>
    `<label><input type="checkbox" value="${escapeHtml(m.username)}" ${picked.has(m.username) ? "checked" : ""}> ${escapeHtml(plMemberName(m))}</label>`).join("");
}
function closeShiftModal() { document.getElementById("sh-modal").hidden = true; PL_EDIT = null; }
async function saveShift() {
  const msg = document.getElementById("sh-modal-msg");
  const groupSel = document.getElementById("sh-f-group");
  const type = document.getElementById("sh-f-type").value;
  const date = document.getElementById("sh-f-date").value;
  const start = document.getElementById("sh-f-start").value;
  const end = document.getElementById("sh-f-end").value;
  let slots = Math.max(1, parseInt(document.getElementById("sh-f-slots").value || "1", 10));
  const role = document.getElementById("sh-f-role").value;
  const loc = document.getElementById("sh-f-loc").value;
  const area = document.getElementById("sh-f-area").value;
  const tags = document.getElementById("sh-f-tags").value.split(",").map((t) => t.trim()).filter(Boolean);
  const note = document.getElementById("sh-f-note").value.trim();
  const picked = Array.from(document.querySelectorAll("#sh-f-assign input:checked")).map((i) => i.value);

  if (!date) { showMsg(msg, "Pick a date", "error"); return; }
  if (type !== "absence" && (!start || !end)) { showMsg(msg, "Enter a start and end time", "error"); return; }
  if (type !== "absence" && start === end) { showMsg(msg, "Start and end cannot be the same", "error"); return; }
  if (type === "absence" && picked.length !== 1) { showMsg(msg, "An absence names one person", "error"); return; }
  if (picked.length > slots) slots = picked.length;

  const body = {
    id: PL_EDIT && PL_EDIT.id, group: groupSel.value, date, start, end,
    role, location: loc, area, tags, type, slots, note, assign: picked,
  };
  try {
    const r = await apiFetch("shifts", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json()).error || await r.text());
    const out = await r.json();
    PL_SEL = out.shift.id;
    closeShiftModal();
    setPlWeek(new Date(date + "T00:00:00"));
    showMsg(shiftsMsg(), PL_EDIT && PL_EDIT.id ? "Shift updated" : "Shift added", "ok");
  } catch (err) {
    showMsg(msg, err.message || "Could not save the shift", "error");
  }
}
async function deleteShift(s) {
  if (!(await confirmModal({
    title: "Delete shift",
    body: `Delete this shift on ${s.date}?`,
  }))) return;
  try {
    const r = await apiFetch("shifts/shift", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: s.id }) });
    if (!r.ok) throw new Error(await r.text());
    if (PL_SEL === s.id) PL_SEL = null;
    loadShifts();
    showMsg(shiftsMsg(), "Shift deleted", "ok");
  } catch (err) {
    showMsg(shiftsMsg(), "Could not delete the shift: " + err.message, "error");
  }
}
async function claimShift(s) {
  try {
    const r = await apiFetch("shifts/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: s.id }) });
    if (!r.ok) throw new Error(await r.text());
    loadShifts();
    showMsg(shiftsMsg(), "You are on the shift", "ok");
  } catch (err) {
    showMsg(shiftsMsg(), "Could not pick up the shift: " + err.message, "error");
  }
}
async function releaseShift(s) {
  if (!(await confirmModal({
    title: "Hand back",
    body: `Hand back the shift on ${s.date}?`,
  }))) return;
  try {
    const r = await apiFetch("shifts/release", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: s.id }) });
    if (!r.ok) throw new Error(await r.text());
    loadShifts();
    showMsg(shiftsMsg(), "Shift handed back", "ok");
  } catch (err) {
    showMsg(shiftsMsg(), "Could not hand back the shift: " + err.message, "error");
  }
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

registerPage("pl-grid", initShifts);
