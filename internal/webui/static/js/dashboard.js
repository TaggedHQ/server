// dashboard.js -- everything only the dashboard page needs.
// core.js holds what every page shares and is loaded first; the
// registerPage call at the bottom hooks this into its page registry.

function weekRange(d) {
  const off = weekStartOffset(d);
  const s = midnight(addDays(d, -off)).getTime() / 1000;
  return [s, s + 7 * 86400];
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
function countInRange(t1, t2) {
  let n = 0;
  for (const r of ALL) if (r.t1 >= t1 && r.t1 < t2) n++;
  return n;
}
let calMonth = midnight(new Date());
function renderDonut(segments, totalSec) {
  document.getElementById("donut").innerHTML = donutSVG(segments, totalSec);
}
function renderDashboard() {
  const [ds, de] = dayRange(selDate);
  const dayRecs = ALL.filter((r) => r.t1 >= ds && r.t1 < de);
  const dayTotal = dayRecs.reduce((a, r) => a + recDur(r), 0);
  const isToday = dayKey(selDate) === dayKey(new Date());

  // Header date control
  document.getElementById("today-btn").textContent = isToday ? t("Today") : t("{d} {month}", { d: selDate.getDate(), month: monthShort(selDate.getMonth()) });
  // Lower case on purpose: this reads inside "Total (today)", so it is its own
  // key rather than a reuse of the button's "Today".
  document.getElementById("tile-scope").textContent = isToday ? t("today") : t("day");

  // Tile: total + daily goal
  const dailyGoalSec = GOALS.daily * 3600;
  document.getElementById("tile-total").textContent = fmtHM(dayTotal);
  document.getElementById("tile-total-goal").textContent = t("Goal {duration}", { duration: fmtHM(dailyGoalSec) });
  document.getElementById("tile-total-bar").style.width = Math.min(100, dailyGoalSec ? (dayTotal / dailyGoalSec) * 100 : 0) + "%";

  // Tile: entries + delta vs previous day
  const [ps] = dayRange(addDays(selDate, -1));
  const prevCount = countInRange(ps, ds);
  const delta = dayRecs.length - prevCount;
  document.getElementById("tile-entries").textContent = dayRecs.length;
  const deltaEl = document.getElementById("tile-entries-delta");
  // The sign travels inside the placeholder so a translation can put the count
  // wherever its grammar needs it.
  deltaEl.textContent = t("{delta} vs. previous day", { delta: (delta >= 0 ? "+" : "") + delta });
  deltaEl.className = "sub" + (delta > 0 ? " pos" : "");

  // Tile: longest block
  let longest = null;
  for (const r of dayRecs) if (!longest || recDur(r) > recDur(longest)) longest = r;
  document.getElementById("tile-longest").textContent = longest ? fmtHM(recDur(longest)) : fmtHM(0);
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
    legend.innerHTML = `<div class="legend-row" style="color:var(--text-3)">${escapeHtml(t("No entries for this day."))}</div>`;
    tagsList.innerHTML = `<div class="tag-row" style="color:var(--text-3)">${escapeHtml(t("No tags"))}</div>`;
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
  document.getElementById("tile-toptag-dur").textContent = top ? fmtHM(top.sec) : fmtHM(0);
  document.getElementById("tile-toptag-pct").textContent = top && dayTotal ? Math.round((top.sec / dayTotal) * 100) + "%" : "0%";

  // Entries of the selected day (most recent first, up to 5)
  const dayEntries = dayRecs.slice().sort((a, b) => b.t1 - a.t1).slice(0, 5);
  document.getElementById("entries-list").innerHTML = dayEntries.length ? dayEntries.map((r) => {
    const k = tagKeyOf(r.ds);
    return `<div class="entry"><div class="e-time"><div class="t1">${clock(r.t1)}</div><div class="t2">${clock(r.t2)}</div></div><div class="e-desc">${escapeHtml(r.ds || t("(no description)"))}</div>${badge(k)}<div class="e-dur">${fmtHM(recDur(r))}</div></div>`;
  }).join("") : `<div class="empty">${escapeHtml(t("No entries for this day."))}</div>`;

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
  document.getElementById("cal-title").textContent = t("{month} {year}", { month: monthName(calMonth.getMonth()), year: calMonth.getFullYear() });
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

  registerRefresh(renderDashboard);
  renderDashboard();
}

registerPage("cal-grid", initDashboard);
