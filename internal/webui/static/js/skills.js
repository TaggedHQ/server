// skills.js -- everything only the skills page needs.
// core.js holds what every page shares and is loaded first; the
// registerPage call at the bottom hooks this into its page registry.

// skIconHtml renders a skill's badge: its icon where it has one, and the
// two-letter mark otherwise. Entries created before the picker existed have only
// a mark, so both paths stay live rather than one being a migration step.
function skIconHtml(s, cls = "") {
  const c = `sk-ic${cls ? " " + cls : ""}`;
  const color = skColor(s);
  if (s.icon) {
    return `<span class="${c}" style="--c:${color}"><i class="${faClass(escapeHtml(s.icon), s.icon_style)}"></i></span>`;
  }
  return `<span class="${c}" style="--c:${color}">${escapeHtml(s.mark || "?")}</span>`;
}
// setSkillIcon keeps the create/edit skill sheet's icon control in step.
function setSkillIcon(name, style) { iconField("new-skill", name, style); }
// An open catalog: any account may add a skill and rate itself against it, and
// everyone sees who holds what. That visibility is the feature, not a leak --
// the page exists so you can find the person to ask.
//
// Two halves with different owners. The categories and the proficiency scale are
// admin-owned (Admin · Skills) because they are the vocabulary every rating is
// expressed in; the catalog and the ratings are open. Everything here comes from
// the server: the axes and the catalog from setup.json, the ratings from each
// user's own store.

let SKILL_LEVELS = [];  // [{n,label}] the server's proficiency scale, low to high
let SKILL_CATS = [];    // [{key,label,color}]
let SKILLS = [];        // [{id,name,mark,cat,desc,scale,creator,added,archived}]
let SK_RATINGS = {};    // skill id -> [{username,level,note}], strongest first
let SK_PEOPLE = [];     // accounts the viewer may assign and approve for
let SK_DIR = {};        // username -> {profile, avatar} for everyone holding a skill
let SK_USERS = 0;       // accounts on the server, the denominator for coverage
let SK_SELECTED = null;
let SK_PAGE = 1;
const SK_PER_PAGE = 10;
function skillsMsg() { return document.getElementById("skills-msg"); }
// catDef and levelDef tolerate ids the server no longer defines: a category can
// be renamed or a scale shortened between two renders, and a half-stale page
// must degrade to a readable label rather than throw.
function catDef(key) {
  return SKILL_CATS.find((c) => c.key === key) || { key, label: key || "Uncategorised", color: "#8A8F98" };
}
function levelDef(n) { return SKILL_LEVELS.find((l) => l.n === n) || { n, label: "Level " + n }; }
// lvColor maps a rung onto the five-stop --lv-* ramp. The scale is operator-
// defined and may have anywhere from 2 to 10 rungs, so the ramp is sampled by
// position rather than indexed directly: low always reads cool, high always
// reads hot, whatever the length.
function lvColor(n) {
  const span = Math.max(1, SKILL_LEVELS.length - 1);
  const i = Math.min(5, Math.max(1, Math.round(1 + ((n - 1) / span) * 4)));
  return `var(--lv-${i})`;
}
// skHolders returns everyone holding a skill, strongest first (the server sorts
// it, so the top of the list is who to ask).
function skHolders(skill) { return SK_RATINGS[skill.id] || []; }
// skUsable is the same test the server sorts by: an assignment only counts if
// it is approved and still in date. Coverage that included pending or lapsed
// holders would answer "who could do this once" rather than "who can today",
// which is the question the page exists to answer.
function skUsable(h) { return h.status !== "pending" && !h.expired; }
function skCurrent(skill) { return skHolders(skill).filter(skUsable); }
// skCounts returns how many accounts sit at each rung, indexed by level.
// Only usable assignments are counted, for the reason above.
function skCounts(skill) {
  const counts = new Array(SKILL_LEVELS.length + 1).fill(0);
  for (const h of skCurrent(skill)) counts[h.level] = (counts[h.level] || 0) + 1;
  return counts;
}
function skRated(skill) { return skCurrent(skill).length; }
// Coverage is the share of accounts that hold the skill at all -- not how good
// they are at it, which is what the level distribution is for.
function skCoverage(skill) {
  return SK_USERS ? Math.round((skRated(skill) / SK_USERS) * 100) : 0;
}
// mine returns the viewer's own assignment, whatever its state.
function myAssignment(skill) {
  return skHolders(skill).find((h) => h.username === window.TT_USER) || null;
}
// myLevel is the viewer's own rating, or 0 if they have not claimed the skill.
function myLevel(skill) {
  const mine = myAssignment(skill);
  return mine ? mine.level : 0;
}
// validityLabel renders a skill's renewal period the way the picker offers it.
function validityLabel(months) {
  if (!months) return "Never";
  if (months === 12) return "1 year";
  if (months === 36) return "3 years";
  return `${months} months`;
}
// skColor is the badge colour: the skill's own where it sets one, otherwise its
// category's, so a family of skills reads as a family by default.
function skColor(s) { return s.color || catDef(s.cat).color; }
// canManageHolder mirrors canManage on the server: a controller of the group
// the holder belongs to, or anyone with skills.manage. Group membership is not
// exposed to this page, so a plain controller relies on the server's answer --
// the buttons show for skills.manage, and a 403 is reported if the server
// disagrees.
function canApproveAny() { return (window.TT_CAPS || []).includes("skills.manage"); }
function isController() { return !!window.TT_IS_CONTROLLER || canApproveAny(); }
// canEditSkill mirrors the server's rule exactly (see canEditSkill in skills.go):
// the creator, or anyone holding skills.manage. The page hides what the server
// would refuse; the server is still the one enforcing it.
function canEditSkill(s) {
  if ((window.TT_CAPS || []).includes("skills.manage")) return true;
  return !!s.creator && s.creator === window.TT_USER;
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
    if (lv && !skCounts(s)[Number(lv)]) return false;
    if (q && !s.name.toLowerCase().includes(q) && !(s.desc || "").toLowerCase().includes(q)) return false;
    return true;
  });
}
function renderSkTiles() {
  const active = skActive();
  const cats = [...new Set(active.map((s) => s.cat))];
  const cov = active.length ? Math.round(active.reduce((a, s) => a + skCoverage(s), 0) / active.length) : 0;
  // Skills the team has real depth in: somebody sits in the top third of the
  // scale. An *average* that high would need nearly everyone at the top, so it
  // read 0 for every plausible roster and told you nothing.
  const deep = Math.max(2, Math.ceil(SKILL_LEVELS.length * 0.67));
  const expert = active.filter((s) => skCounts(s).slice(deep).some((n) => n > 0)).length;
  // Skills nobody currently holds are the gap worth acting on: they are in the
  // catalogue because somebody decided they matter, and right now no one can do
  // them.
  const uncovered = active.filter((s) => skRated(s) === 0).length;
  const pending = active.reduce((a, s) => a + skHolders(s).filter((h) => h.status === "pending").length, 0);
  const tiles = [
    { k: "Skills defined", v: String(active.length), sub: `Across ${cats.length} categor${cats.length === 1 ? "y" : "ies"}` },
    { k: "Nobody holds", v: String(uncovered), sub: uncovered ? "No cover for these" : "Every skill is covered", pos: uncovered === 0 },
    { k: "Team coverage", v: cov + "%", sub: `Average across ${active.length} skill${active.length === 1 ? "" : "s"}` },
    { k: "Awaiting approval", v: String(pending), sub: pending ? "Claims needing a manager" : "Nothing waiting" },
  ];
  document.getElementById("sk-tiles").innerHTML = tiles.map((t) => `
    <div class="tile">
      <div class="k">${escapeHtml(t.k)}</div>
      <div class="v">${escapeHtml(t.v)}</div>
      <div class="sub${t.pos ? " pos" : ""}">${t.sub}</div>
    </div>`).join("");
}
// skLevelGlyph renders the scale as one bar per level, lit where somebody holds
// it. The viewer's own rung is ringed, so you can read your standing off the
// table without opening the detail panel.
function skLevelGlyph(skill) {
  const counts = skCounts(skill);
  const mine = myLevel(skill);
  const bars = [];
  for (let n = 1; n <= skill.scale; n++) {
    const on = counts[n] > 0;
    const cls = `sk-lv${on ? " on" : ""}${n === mine ? " mine" : ""}`;
    const who = n === mine ? " · you" : "";
    bars.push(`<span class="${cls}" style="--c:${lvColor(n)}" title="${escapeHtml(levelDef(n).label)}: ${counts[n] || 0}${who}">
      <i></i><span>${n}</span>
    </span>`);
  }
  return `<div class="sk-levels">${bars.join("")}</div>`;
}
// openRowMenu toggles a row's action popover and pins it to the button.
//
// The skills table lives inside .table-wrap, which scrolls horizontally -- and a
// box with overflow on one axis clips the other too, so an absolutely-positioned
// menu inside it gets cut off at the table's edge. Switching to fixed
// positioning takes the menu out of that clipping context entirely; the price is
// that the coordinates have to be set here rather than in CSS.
function openRowMenu(btn, pop) {
  const wasOpen = pop.classList.contains("open");
  closeAllMenus();
  if (wasOpen) return;

  pop.classList.add("open", "menu-pop-fixed");
  const r = btn.getBoundingClientRect();
  const h = pop.offsetHeight;
  const w = pop.offsetWidth;
  // Flip above the button when there is not room below, so the last row's menu
  // is never half off-screen.
  const below = window.innerHeight - r.bottom;
  const top = below < h + 8 && r.top > h + 8 ? r.top - h - 4 : r.bottom + 4;
  pop.style.top = `${Math.max(8, top)}px`;
  pop.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
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
      const rated = skRated(s);
      // Only offer the destructive actions the server would accept.
      const owned = canEditSkill(s);
      return `<tr class="um-row${sel}" data-s="${escapeHtml(s.id)}">
        <td>
          <div class="um-user">
            ${skIconHtml(s)}
            <span class="um-name">${escapeHtml(s.name)}${s.archived ? ' <span class="badge muted">Archived</span>' : ""}</span>
          </div>
        </td>
        <td><span class="sk-cat"><span class="sk-dot" style="--c:${c.color}"></span>${escapeHtml(c.label)}</span></td>
        <td>${skLevelGlyph(s)}</td>
        <td>
          <div class="sk-cov">
            <span class="sk-pct">${cov}%</span>
            <div class="bar"><span style="width:${cov}%"></span></div>
            <span class="muted sk-cov-n">${rated}/${SK_USERS}</span>
          </div>
        </td>
        <td>
          <div class="te-menu">
            <button class="sk-menu-btn" aria-label="Actions">⋯</button>
            <div class="menu-pop">
              <button class="sk-m-details">Details</button>
              ${owned ? `<button class="sk-m-edit">Edit</button>
              <button class="sk-m-archive">${s.archived ? "Restore" : "Archive"}</button>
              <button class="sk-m-delete danger-btn">Delete</button>` : ""}
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
    openRowMenu(btn, btn.nextElementSibling);
  }));
  const rowSkill = (el) => SKILLS.find((x) => x.id === el.closest(".um-row").dataset.s);
  body.querySelectorAll(".sk-m-details").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation(); closeAllMenus(); selectSkill(rowSkill(b).id);
  }));
  body.querySelectorAll(".sk-m-edit").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation(); closeAllMenus(); openSkillSheet(rowSkill(b));
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
// skDirEntry is the profile/avatar for one holder. The skills endpoint serves
// its own directory (the groups one needs groups.manage, which the people who
// curate the catalogue do not necessarily hold), so this reads from that.
function skDirEntry(username) { return SK_DIR[username] || {}; }
// skPersonRow renders one holder the way the groups page renders a member:
// avatar, display name, login underneath when it differs. The trailing slot
// carries whatever that list needs to say about them -- a level, a status, or
// the approve/reject pair.
function skPersonRow(username, trailing = "") {
  const d = skDirEntry(username);
  const name = displayName(username, d.profile);
  const you = username === window.TT_USER;
  // The level, status and expiry go *inside* the name column rather than beside
  // it. The panel is a ~400px side rail, and a person's name plus three pieces
  // of assignment state cannot share one line there without colliding -- so they
  // stack under the name, indented to it.
  return `<div class="gr-person sk-person">
    ${avatarHtml(username, d.profile, d.avatar)}
    <span class="gr-person-text">
      <span class="gr-person-name">${escapeHtml(name)}${you ? " (you)" : ""}</span>
      ${name !== username ? `<span class="gr-person-sub">${escapeHtml(username)}</span>` : ""}
      ${trailing}
    </span>
  </div>`;
}
// skStatusBadge says why an assignment does or does not count today. Pending and
// expired are both "not usable", but for different reasons, so they read
// differently rather than collapsing into one label.
function skStatusBadge(h) {
  if (h.status === "pending") return `<span class="badge warn">Pending</span>`;
  if (h.expired) return `<span class="badge muted">Expired</span>`;
  return `<span class="badge ok">Active</span>`;
}
function renderSkDetails() {
  const host = document.getElementById("skill-details");
  const s = SKILLS.find((x) => x.id === SK_SELECTED);
  if (!s) {
    host.classList.remove("filled");
    host.innerHTML = `<div class="um-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3z"/></svg>
      <p>Select a skill to see what it requires and who holds it.</p>
    </div>`;
    return;
  }
  host.classList.add("filled");

  const c = catDef(s.cat);
  const counts = skCounts(s);
  const rated = skRated(s);
  const holders = skHolders(s);
  const segs = SKILL_LEVELS.slice(0, s.scale)
    .map((l) => ({ sec: counts[l.n] || 0, color: lvColor(l.n), label: l.label, n: l.n }))
    .filter((x) => x.sec > 0);
  const owned = canEditSkill(s);
  const canAssign = SK_PEOPLE.length > 0;

  // Head: the badge, the name, and the two facts that identify it -- which
  // category it belongs to and whether it is still in use.
  const head = `<div class="ud-head">
    ${skIconHtml(s, "lg")}
    <div class="ud-id">
      <div class="ud-name">${escapeHtml(s.name)}</div>
      <div class="sk-head-meta">
        <span class="sk-cat"><span class="sk-dot" style="--c:${c.color}"></span>${escapeHtml(c.label)}</span>
        <span class="badge ${s.archived ? "muted" : "ok"}">${s.archived ? "Archived" : "Active"}</span>
      </div>
      ${s.desc
        ? `<p class="gr-desc">${escapeHtml(s.desc)}</p>`
        : `<p class="gr-desc ud-unset">No description</p>`}
    </div>
  </div>`;

  // Requirements as label/value rows, which is what they are: the rules a
  // holder has to satisfy, read top to bottom.
  const requirements = udCard("Requirements",
    udRow("Renew every", escapeHtml(validityLabel(s.validity_months)), s.validity_months ? "" : "ud-unset") +
    udRow("Requires certificate", s.requires_proof ? "✔" : "—", s.requires_proof ? "" : "ud-unset") +
    udRow("Requires manager approval", s.requires_approval ? "✔" : "—", s.requires_approval ? "" : "ud-unset"));

  // Holders, with the approve/reject pair inline on anything still pending.
  const holdersBody = holders.length
    ? `<div class="gr-people">${holders.map((h) => {
        const canDecide = canAssign && h.status === "pending" && h.username !== window.TT_USER;
        const trailing = `<span class="sk-person-meta">
          <span class="sk-person-lv">${escapeHtml(levelDef(h.level).label)}</span>
          ${skStatusBadge(h)}
          ${h.expires_at ? `<span class="sk-person-exp muted">${h.expired ? "expired" : "until"} ${escapeHtml(h.expires_at)}</span>` : ""}
        </span>
        ${canDecide ? `<span class="sd-approve">
          <button class="secondary btn-sm sk-approve" data-u="${escapeHtml(h.username)}">Approve</button>
          <button class="danger-link sk-reject" data-u="${escapeHtml(h.username)}">Reject</button>
        </span>` : ""}`;
        return skPersonRow(h.username, trailing);
      }).join("")}</div>`
    : `<p class="muted um-note">Nobody holds this skill yet.</p>`;

  const holdersCard = udCard(`Holders${holders.length ? ` · ${holders.length}` : ""}`, holdersBody,
    canAssign && !s.archived ? `<button class="secondary btn-sm" id="sk-assign">Assign</button>` : "");

  // Coverage only earns the donut once somebody actually holds the skill; an
  // empty ring next to "0 of 6" says nothing the number has not already said.
  const coverageCard = udCard("Coverage",
    rated === 0
      ? `<p class="muted um-note">No cover: nobody can do this today.</p>`
      : `<div class="sd-dist">
          <div class="donut-wrap">
            <svg viewBox="0 0 42 42" width="88" height="88">${donutSVG(segs, rated)}</svg>
            <div class="donut-center"><div><div class="d-total">${skCoverage(s)}%</div><div class="d-label">Coverage</div></div></div>
          </div>
          <div class="legend">
            ${segs.map((x) => `<div class="legend-row">
              <span class="dot" style="background:${x.color}"></span>
              <span class="legend-name">${x.n} ${escapeHtml(x.label)}</span>
              <span class="legend-pct">${x.sec}</span>
            </div>`).join("")}
          </div>
        </div>
        <p class="muted um-note" style="margin-top:10px">${rated} of ${SK_USERS} account${SK_USERS === 1 ? "" : "s"} can do this today.</p>`);

  // Provenance sits last: useful when auditing, never the first thing you need.
  const about = udCard("About",
    udRow("Added", escapeHtml(s.added || "—")) +
    udRow("Added by", escapeHtml(s.creator || "—"), s.creator ? "" : "ud-unset") +
    udRow("Levels", `${s.scale} of ${SKILL_LEVELS.length}`));

  const actions = owned ? `<div class="ud-danger">
    <button class="secondary" id="sk-edit">Edit skill</button>
    <button class="secondary" id="sk-archive">${s.archived ? "Restore skill" : "Archive skill"}</button>
    <button class="danger-btn" id="sk-delete">Delete skill</button>
  </div>` : "";

  host.innerHTML = head + requirements + holdersCard + coverageCard + about + actions;

  const on = (sel, fn) => { const el = host.querySelector(sel); if (el) el.addEventListener("click", fn); };
  on("#sk-assign", () => openAssign(s, ""));
  host.querySelectorAll(".sk-approve").forEach((b) =>
    b.addEventListener("click", () => decideSkill(s, b.dataset.u, false)));
  host.querySelectorAll(".sk-reject").forEach((b) =>
    b.addEventListener("click", () => decideSkill(s, b.dataset.u, true)));
  on("#sk-edit", () => openSkillSheet(s));
  on("#sk-archive", () => toggleArchiveSkill(s));
  on("#sk-delete", () => deleteSkill(s));
}
// One sheet serves both "claim it for myself" and "assign it to somebody",
// because the two capture identical details and differ only in who they land on.

let AS_SKILL = null;
// AS_TARGET is null for a self-claim, or a username (possibly "" until picked)
// when a manager is assigning.
let AS_TARGET = null;
function assignModal() { return document.getElementById("assign-modal"); }
function closeAssign() { assignModal().hidden = true; }
function openAssign(s, target) {
  AS_SKILL = s;
  AS_TARGET = target;
  const m = assignModal();
  const self = target === null;
  const mine = self ? myAssignment(s) : null;

  m.querySelector("#as-title").textContent = self ? `Claim ${s.name}` : `Assign ${s.name}`;
  m.querySelector("#as-sub").textContent = self
    ? (s.requires_approval ? "A manager has to approve this before it counts." : "Everyone can see what you claim.")
    : "Assigning counts as your approval.";
  m.querySelector("#as-msg").innerHTML = "";

  // The person picker only appears for a manager assignment. It lists everyone
  // the page knows about; the server is the one that decides who the caller
  // actually manages, and says so if not.
  const whoRow = m.querySelector("#as-who-row");
  whoRow.hidden = self;
  if (!self) {
    m.querySelector("#as-who").innerHTML = SK_PEOPLE.length
      ? SK_PEOPLE.map((u) => `<option value="${escapeHtml(u)}">${escapeHtml(u)}</option>`).join("")
      : `<option value="">Nobody to assign to</option>`;
  }

  m.querySelector("#as-level").innerHTML = SKILL_LEVELS.slice(0, s.scale)
    .map((l) => `<option value="${l.n}"${mine && mine.level === l.n ? " selected" : ""}>${l.n} · ${escapeHtml(l.label)}</option>`)
    .join("");

  const certBlock = m.querySelector("#as-cert-block");
  // The fields show whenever the skill tracks a certificate. They are only
  // *required* when the skill says so, which the server enforces.
  certBlock.hidden = !s.requires_proof;
  m.querySelector("#as-cert-number").value = mine && mine.cert ? (mine.cert.number || "") : "";
  m.querySelector("#as-cert-issuer").value = mine && mine.cert ? (mine.cert.issuer || "") : "";
  m.querySelector("#as-cert-date").value = mine && mine.cert ? (mine.cert.issue_date || "") : "";
  m.querySelector("#as-note").value = mine ? (mine.note || "") : "";

  m.hidden = false;
}
async function submitAssign() {
  const m = assignModal();
  const msg = m.querySelector("#as-msg");
  const self = AS_TARGET === null;
  const body = {
    skill_id: AS_SKILL.id,
    level: Number(m.querySelector("#as-level").value),
    note: m.querySelector("#as-note").value.trim(),
    cert: {
      number: m.querySelector("#as-cert-number").value.trim(),
      issuer: m.querySelector("#as-cert-issuer").value.trim(),
      issue_date: m.querySelector("#as-cert-date").value,
    },
  };
  if (!self) {
    body.username = m.querySelector("#as-who").value;
    if (!body.username) { showMsg(msg, "Pick somebody to assign this to", "error"); return; }
  }
  const r = await apiFetch(self ? "skills/mine" : "skills/assign", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) { showMsg(msg, await r.text(), "error"); return; }
  closeAssign();
  showMsg(skillsMsg(), self
    ? (AS_SKILL.requires_approval ? `Claimed ${AS_SKILL.name} — waiting for approval` : `Claimed ${AS_SKILL.name}`)
    : `Assigned ${AS_SKILL.name} to ${body.username}`, "ok");
  await refreshSkills();
}
// decideSkill approves or rejects one pending assignment. Both the catalogue
// page and My Skills call it, so the message target and the reload are passed
// in rather than assumed.
async function decideSkill(s, username, reject, msgFn) {
  const msgEl = (msgFn || skillsMsg)();
  if (reject && !(await confirmModal({
    title: `Reject ${s.name} for ${username}`,
    body: "The claim is removed. They can claim it again with better evidence.",
  }))) return;
  const r = await apiFetch("skills/approve", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, skill_id: s.id, reject: !!reject }),
  });
  if (!r.ok) { showMsg(msgEl, await r.text(), "error"); return; }
  showMsg(msgEl, reject ? `Rejected ${s.name} for ${username}` : `Approved ${s.name} for ${username}`, "ok");
  if (typeof MS_MINE !== "undefined" && document.getElementById("ms-body")) await refreshMySkills();
  else await refreshSkills();
}
// loadSkills fetches the catalog, both axes and every account's ratings in one
// call. The server assembles the ratings by walking each user's store, so this
// is deliberately one request rather than one per skill.
async function loadSkills() {
  const r = await apiFetch("skills");
  if (!r.ok) { showMsg(skillsMsg(), await r.text(), "error"); return false; }
  const d = await r.json();
  SKILLS = d.skills || [];
  SKILL_CATS = d.categories || [];
  SKILL_LEVELS = d.levels || [];
  SK_RATINGS = d.ratings || {};
  SK_DIR = d.directory || {};
  SK_USERS = d.users || 0;
  // Who the viewer may assign for is the server's call: the group list a
  // controller would need to work it out is closed to them.
  const who = await apiFetch("skills/manageable");
  SK_PEOPLE = who.ok ? ((await who.json()).users || []) : [];
  return true;
}
// setMyLevel records the viewer's own rating. Level 0 clears the claim.
async function setMyLevel(s, level) {
  const r = await apiFetch("skills/mine", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skill_id: s.id, level }),
  });
  if (!r.ok) { showMsg(skillsMsg(), await r.text(), "error"); return; }
  showMsg(skillsMsg(), level
    ? `You are now ${levelDef(level).label} at ${s.name}`
    : `Cleared your rating for ${s.name}`, "ok");
  await refreshSkills();
}
async function toggleArchiveSkill(s) {
  const r = await apiFetch("skills/skill", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: s.id, archived: !s.archived }),
  });
  if (!r.ok) { showMsg(skillsMsg(), await r.text(), "error"); return; }
  showMsg(skillsMsg(), s.archived ? `Restored ${s.name}` : `Archived ${s.name}`, "ok");
  await refreshSkills();
}
async function deleteSkill(s) {
  if (!(await confirmModal({
    title: `Delete skill "${s.name}"`,
    body: "It disappears from everyone's catalog. Ratings are kept, so re-creating it under the same name restores them.",
  }))) return;
  const r = await apiFetch("skills/skill", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: s.id }),
  });
  if (!r.ok) { showMsg(skillsMsg(), await r.text(), "error"); return; }
  if (SK_SELECTED === s.id) SK_SELECTED = null;
  showMsg(skillsMsg(), `Deleted ${s.name}`, "ok");
  await refreshSkills();
}
async function createSkill() {
  const msg = document.getElementById("create-skill-msg");
  const name = document.getElementById("new-skill-name").value.trim();
  if (!name) { showMsg(msg, "Enter a skill name", "error"); return; }

  const editing = SK_EDIT_ID !== null;
  const body = {
    name,
    cat: document.getElementById("new-skill-cat").value,
    desc: document.getElementById("new-skill-desc").value.trim(),
    icon: document.getElementById("new-skill-icon").value,
    icon_style: document.getElementById("new-skill-icon-style").value,
    color: document.getElementById("new-skill-color").value,
    validity_months: Number(document.getElementById("new-skill-validity").value),
    requires_proof: document.getElementById("new-skill-proof").checked,
    requires_approval: document.getElementById("new-skill-approval").checked,
  };
  if (editing) body.id = SK_EDIT_ID;

  const r = await apiFetch(editing ? "skills/skill" : "skills", {
    method: editing ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) { showMsg(msg, await r.text(), "error"); return; }
  const d = await r.json();
  closeAddSkill();
  // Select what was just written, so the detail panel shows the result.
  SK_SELECTED = d.skill ? d.skill.id : SK_SELECTED;
  showMsg(skillsMsg(), editing ? `Saved ${name}` : `Created ${name}`, "ok");
  await refreshSkills();
}
// refreshSkills re-reads server state and repaints. Every mutation goes through
// it rather than patching the local arrays: ratings are assembled server-side
// from every account's store, so a local edit could not reproduce them anyway.
async function refreshSkills() {
  if (await loadSkills()) renderSkills();
}
function renderSkills() {
  renderSkFilters();
  renderSkTiles();
  renderSkTable();
  renderSkDetails();
}
// renderSkFilters fills the category and level dropdowns from the server's axes,
// preserving the current selection: an admin may reshape either one while the
// page is open.
function renderSkFilters() {
  const catSel = document.getElementById("sk-cat-filter");
  const lvSel = document.getElementById("sk-level-filter");
  const newCat = document.getElementById("new-skill-cat");
  const keepCat = catSel.value, keepLv = lvSel.value, keepNew = newCat.value;
  const opt = (c) => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.label)}</option>`;
  // The filter offers every category, so existing skills in an archived one stay
  // findable. The create/edit picker offers only active ones -- the server
  // refuses a new skill in an archived category, so the picker shouldn't tempt.
  catSel.innerHTML = `<option value="">All categories</option>` + SKILL_CATS.map(opt).join("");
  newCat.innerHTML = SKILL_CATS.filter((c) => !c.archived).map(opt).join("");
  lvSel.innerHTML = `<option value="">All levels</option>` +
    SKILL_LEVELS.map((l) => `<option value="${l.n}">${l.n} · ${escapeHtml(l.label)}</option>`).join("");
  catSel.value = keepCat;
  lvSel.value = keepLv;
  if (keepNew) newCat.value = keepNew;
}
// exportSkills downloads the catalog as JSON, ratings resolved.
function exportSkills() {
  const out = SKILLS.map((s) => ({
    id: s.id, name: s.name, category: s.cat, description: s.desc,
    scale: s.scale, archived: !!s.archived, added: s.added, creator: s.creator,
    levels: SKILL_LEVELS.slice(0, s.scale).map((l) => l.label),
    holders: skHolders(s).map((h) => ({ username: h.username, level: h.level, level_label: levelDef(h.level).label })),
  }));
  const blob = new Blob([JSON.stringify({ skills: out }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "skills.json";
  a.click();
  URL.revokeObjectURL(a.href);
  showMsg(skillsMsg(), `Exported ${out.length} skills`, "ok");
}
// SK_EDIT_ID is the skill the sheet is editing, or null when creating one.
let SK_EDIT_ID = null;
// openSkillSheet serves both jobs. Passing a skill fills the form from it and
// switches the sheet to editing; passing nothing opens a blank one.
function openSkillSheet(s) {
  SK_EDIT_ID = s ? s.id : null;
  const set = (id, v) => { document.getElementById(id).value = v; };
  document.getElementById("create-skill-msg").innerHTML = "";
  document.getElementById("skill-sheet-title").textContent = s ? `Edit ${s.name}` : "New skill";
  document.getElementById("create-skill").textContent = s ? "Save" : "Create";

  set("new-skill-name", s ? s.name : "");
  set("new-skill-desc", s ? (s.desc || "") : "");
  set("new-skill-validity", String(s ? (s.validity_months || 0) : 0));
  document.getElementById("new-skill-proof").checked = !!(s && s.requires_proof);
  document.getElementById("new-skill-approval").checked = !!(s && s.requires_approval);

  // The colour well cannot represent "inherit the category", so an unset colour
  // shows the category's own -- which is what the badge renders anyway.
  const color = s ? skColor(s) : "#4C82F7";
  set("new-skill-color", color);
  setSkillIcon(s && s.icon ? s.icon : "", s ? s.icon_style : "");
  document.getElementById("new-skill-icon-preview").style.setProperty("--c", color);

  // The category list is filled by renderSkFilters; select after, or the value
  // would be set against an empty list.
  if (s) {
    const catSel = document.getElementById("new-skill-cat");
    // Editing a skill whose category was archived after it was filed: the
    // archived category is not in the picker, so add it back for this skill
    // rather than silently snapping the value to a different one.
    if (![...catSel.options].some((o) => o.value === s.cat)) {
      const c = SKILL_CATS.find((x) => x.key === s.cat);
      if (c) catSel.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(c.key)}">${escapeHtml(c.label)}</option>`);
    }
    catSel.value = s.cat;
  }

  document.getElementById("add-skill-modal").hidden = false;
  document.getElementById("new-skill-name").focus();
}
// openAddSkill is the "Add skill" button's entry point.
function openAddSkill() { openSkillSheet(null); }
function closeAddSkill() { document.getElementById("add-skill-modal").hidden = true; }
async function initSkills() {
  // This page defines the catalogue, so it takes the capability. Users reach
  // skills through My Skills, which only offers what is defined here.
  if (!(await requireCap("skills.manage"))) return;
  try {
    const who = await apiFetch("whoami");
    if (who.ok) {
      const d = await who.json();
      window.TT_USER = d.username;
      window.TT_CAPS = d.caps || [];
      window.TT_IS_CONTROLLER = !!d.is_controller;
    }
  } catch (e) { /* fall through: the page still renders, minus the "you" markers */ }

  const rerender = () => { SK_PAGE = 1; renderSkTable(); };
  document.getElementById("sk-search").addEventListener("input", rerender);
  document.getElementById("sk-cat-filter").addEventListener("change", rerender);
  document.getElementById("sk-level-filter").addEventListener("change", rerender);
  document.getElementById("sk-archived").addEventListener("change", () => { SK_PAGE = 1; renderSkills(); });

  document.getElementById("add-skill-btn").addEventListener("click", openAddSkill);
  document.getElementById("add-skill-cancel").addEventListener("click", closeAddSkill);
  document.getElementById("create-skill").addEventListener("click", createSkill);
  wireIconPicker();
  document.getElementById("export-skills-btn").addEventListener("click", exportSkills);
  document.getElementById("add-skill-modal").addEventListener("click", (e) => {
    if (e.target.id === "add-skill-modal") closeAddSkill();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAddSkill(); });
  // The row menus are popovers: any click elsewhere dismisses them.
  document.addEventListener("click", closeAllMenus);

  await refreshSkills();
}
// The user-facing half of the feature. Skills are defined elsewhere (the Skills
// section, gated on skills.manage); here you only pick from what exists: choose
// a category, then a skill filed under it. That is the whole point of a
// catalogue -- everyone's "Forklift" is the same Forklift, with the same renewal
// period and the same evidence rules attached.
//
// A manager sees a second panel for the people in the groups they control:
// assigning on their behalf, and clearing the approvals their claims are
// waiting on.

let MS_MINE = [];    // my assignments, joined to their catalog entry
// MS_ROWS is every assignment on the server, one row per (person, skill), joined
// to its catalog entry. The skills endpoint already returns the whole picture,
// so the company-wide view costs no extra request -- what changes between the
// two scopes is which rows are listed and which of them can be acted on.
let MS_ROWS = [];
let MS_SEL = null;    // "<username>|<skill_id>" of the selected row
let MS_TARGET = null; // null = picking for myself, username = assigning to them
function msMsg() { return document.getElementById("ms-msg"); }
function msPickModal() { return document.getElementById("ms-pick-modal"); }
// msJoin pairs one assignment with the catalog entry it points at. An
// assignment whose skill has since been deleted is dropped rather than rendered
// as a nameless row.
function msJoin(holderRows) {
  return holderRows
    .map((h) => ({ ...h, skill: SKILLS.find((s) => s.id === h.skill_id) }))
    .filter((r) => r.skill);
}
// msStatusBadge renders the three states an assignment can be in. Pending and
// expired are both "not usable today", but for different reasons, so they read
// differently rather than collapsing into one label.
function msStatusBadge(r) {
  if (r.status === "pending") return `<span class="badge warn">Awaiting approval</span>`;
  if (r.expired) return `<span class="badge muted">Expired</span>`;
  return `<span class="badge ok">Active</span>`;
}
function renderMsTiles() {
  const active = MS_MINE.filter((r) => r.status !== "pending" && !r.expired);
  const pending = MS_MINE.filter((r) => r.status === "pending");
  const expired = MS_MINE.filter((r) => r.expired);
  // Anything lapsing inside 60 days is worth chasing now: renewals usually need
  // a course booked, not just a form filled in.
  const soon = active.filter((r) => {
    if (!r.expires_at) return false;
    const days = (new Date(r.expires_at) - new Date()) / 86400000;
    return days <= 60;
  });
  const tiles = [
    { k: "Active skills", v: String(active.length), sub: `Of ${SKILLS.filter((s) => !s.archived).length} in the catalogue` },
    { k: "Awaiting approval", v: String(pending.length), sub: pending.length ? "A manager needs to sign these off" : "Nothing waiting" },
    { k: "Expiring soon", v: String(soon.length), sub: soon.length ? "Within 60 days" : "Nothing due", pos: soon.length === 0 },
    { k: "Expired", v: String(expired.length), sub: expired.length ? "Renew to make these count again" : "None" },
  ];
  document.getElementById("ms-tiles").innerHTML = tiles.map((t) => `
    <div class="tile">
      <div class="k">${escapeHtml(t.k)}</div>
      <div class="v">${escapeHtml(t.v)}</div>
      <div class="sub${t.pos ? " pos" : ""}">${escapeHtml(t.sub)}</div>
    </div>`).join("");
}
function renderMsTable() {
  const body = document.getElementById("ms-body");
  if (!MS_MINE.length) {
    body.innerHTML = `<tr><td colspan="5" class="muted">You have no skills yet — use “Add skill” to pick one from the catalogue.</td></tr>`;
    document.getElementById("ms-count").textContent = "";
    return;
  }
  // Both tables feed the one side panel, so a row here selects the same way a
  // team row does -- the actions live in the panel rather than in the row.
  body.innerHTML = MS_MINE.map((r) => {
    const c = catDef(r.skill.cat);
    const sel = msRowKey(r) === MS_SEL ? " selected" : "";
    return `<tr class="um-row${sel}" data-k="${escapeHtml(msRowKey(r))}">
      <td>
        <div class="um-user">
          ${skIconHtml(r.skill)}
          <span class="um-name">${escapeHtml(r.skill.name)}</span>
        </div>
      </td>
      <td><span class="sk-cat"><span class="sk-dot" style="--c:${c.color}"></span>${escapeHtml(c.label)}</span></td>
      <td>${escapeHtml(levelDef(r.level).label)}</td>
      <td>${msStatusBadge(r)}</td>
      <td class="muted">${r.expires_at ? escapeHtml(r.expires_at) : "—"}</td>
    </tr>`;
  }).join("");
  document.getElementById("ms-count").textContent =
    `${MS_MINE.length} skill${MS_MINE.length === 1 ? "" : "s"}`;

  body.querySelectorAll(".um-row").forEach((tr) => tr.addEventListener("click", () => selectMsRow(tr.dataset.k)));
}
// selectMsRow drives the shared side panel from either table.
function selectMsRow(key) {
  MS_SEL = key;
  renderMsTable();
  renderMsTeam();
  renderMsTeamDetails();
}
// renderMsTeam draws the manager panel: everyone in the groups they control,
// their skills. A per-person list does not survive a real roster, so this is a
// table with the same toolbar the Skills page uses -- search, category, status --
// plus a scope switch. Acting on a row happens in the side panel, which keeps
// the row itself readable at any width.
// msCanManage reports whether the viewer may act on this person's assignments.
// The server decides who that is (skills/manageable); the company-wide scope
// lists everyone but only these rows carry actions.
function msCanManage(username) { return SK_PEOPLE.includes(username); }
// msRowKey identifies one assignment across renders.
function msRowKey(r) { return `${r.username}|${r.skill_id}`; }
// msScope is "team" (only people I manage) or "all" (everyone on the server).
function msScope() { return document.getElementById("ms-scope").value; }
// msPending counts the assignments waiting on this viewer specifically, which is
// what the badge reports: a pending claim I cannot approve is not my queue.
function msPending() {
  return MS_ROWS.filter((r) => r.status === "pending" && msCanManage(r.username)).length;
}
// msVisibleRows applies the toolbar: scope, search, category and status.
function msVisibleRows() {
  const q = (document.getElementById("ms-search").value || "").trim().toLowerCase();
  const cat = document.getElementById("ms-cat-filter").value;
  const status = document.getElementById("ms-status-filter").value;
  const scope = msScope();
  return MS_ROWS.filter((r) => {
    if (scope === "team" && !msCanManage(r.username)) return false;
    if (cat && r.skill.cat !== cat) return false;
    if (status === "pending" && r.status !== "pending") return false;
    if (status === "active" && !(r.status === "active" && !r.expired)) return false;
    if (status === "expired" && !r.expired) return false;
    if (q) {
      const name = displayName(r.username, skDirEntry(r.username).profile).toLowerCase();
      if (!name.includes(q) && !r.username.toLowerCase().includes(q) &&
          !r.skill.name.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}
function renderMsTeam() {
  const panel = document.getElementById("ms-team-panel");
  // A plain user manages nobody and sees no company data worth a panel until
  // somebody else records a skill; hiding it keeps their page to just their own.
  if (!SK_PEOPLE.length && MS_ROWS.every((r) => r.username === window.TT_USER)) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  // Somebody who manages nobody has no "my team" to speak of, so that option is
  // dropped and the scope pinned to everyone -- otherwise the page would default
  // them to a filter that can only ever be empty.
  const scopeSel = document.getElementById("ms-scope");
  const teamOpt = scopeSel.querySelector('option[value="team"]');
  if (!SK_PEOPLE.length) {
    teamOpt.hidden = true;
    scopeSel.value = "all";
  } else {
    teamOpt.hidden = false;
  }
  const scope = msScope();
  document.getElementById("ms-team-title").textContent =
    scope === "team" ? "Team skills" : "Everyone's skills";
  // Assigning is only meaningful for people the viewer manages.
  document.getElementById("ms-assign-btn").hidden = !SK_PEOPLE.length;

  const pending = msPending();
  const badge = document.getElementById("ms-pending-badge");
  badge.hidden = pending === 0;
  badge.textContent = `${pending} awaiting you`;

  const rows = msVisibleRows();
  // A selection the filters have hidden is dropped, so the side panel never
  // describes a row the reader can no longer see. My own skills count as
  // visible whatever the team filters say -- they are listed in the other
  // table, which these filters do not touch.
  const shown = new Set([...rows, ...MS_MINE].map(msRowKey));
  if (MS_SEL && !shown.has(MS_SEL)) MS_SEL = null;
  const body = document.getElementById("ms-team-body");
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="5" class="muted">${MS_ROWS.length
      ? "No skills match your filters."
      : "No skills recorded yet."}</td></tr>`;
  } else {
    body.innerHTML = rows.map((r) => {
      const d = skDirEntry(r.username);
      const name = displayName(r.username, d.profile);
      const sel = msRowKey(r) === MS_SEL ? " selected" : "";
      return `<tr class="um-row${sel}" data-k="${escapeHtml(msRowKey(r))}">
        <td>
          <div class="um-user">
            ${avatarHtml(r.username, d.profile, d.avatar)}
            <span class="um-name">${escapeHtml(name)}</span>
          </div>
        </td>
        <td>
          <div class="um-user">
            ${skIconHtml(r.skill)}
            <span class="um-name">${escapeHtml(r.skill.name)}</span>
          </div>
        </td>
        <td class="muted">${escapeHtml(levelDef(r.level).label)}</td>
        <td>${msStatusBadge(r)}</td>
        <td class="muted">${r.expires_at ? escapeHtml(r.expires_at) : "—"}</td>
      </tr>`;
    }).join("");
  }
  document.getElementById("ms-team-count").textContent =
    `${rows.length} of ${MS_ROWS.filter((r) => scope === "all" || msCanManage(r.username)).length} assignment${rows.length === 1 ? "" : "s"}`;

  body.querySelectorAll(".um-row").forEach((tr) => tr.addEventListener("click", () => selectMsRow(tr.dataset.k)));
}
// renderMsTeamDetails is the side panel: everything about one assignment, and
// the actions the viewer is allowed to take on it.
function renderMsTeamDetails() {
  const host = document.getElementById("ms-details");
  const r = MS_ROWS.find((x) => msRowKey(x) === MS_SEL);
  if (!r) {
    host.classList.remove("filled");
    host.innerHTML = `<div class="um-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3z"/></svg>
      <p>Select an entry to see its details${SK_PEOPLE.length ? " and approve it" : ""}.</p>
    </div>`;
    return;
  }
  host.classList.add("filled");
  const d = skDirEntry(r.username);
  const name = displayName(r.username, d.profile);
  const own = r.username === window.TT_USER;
  const manages = msCanManage(r.username);
  const cat = catDef(r.skill.cat);

  // What the viewer may do depends on whose entry it is.
  //
  // Your own: change the level or evidence, or drop the skill entirely.
  //
  // Someone you manage: approve or reject a pending claim, and nothing else.
  // A manager vouches for a claim, they do not author it -- letting them edit
  // the level or the certificate would make the record say something the holder
  // never claimed, and quietly erase the distinction between what was submitted
  // and what was approved.
  //
  // Anyone else: read-only.
  let actions;
  if (own) {
    actions = `<div class="ud-danger">
      <button class="secondary" id="ms-d-edit">Update my entry</button>
      <button class="danger-btn" id="ms-d-remove">Remove</button>
    </div>`;
  } else if (manages && r.status === "pending") {
    actions = `<div class="ud-danger">
      <button id="ms-d-ok">Approve</button>
      <button class="danger-btn" id="ms-d-no">Reject</button>
    </div>
    <p class="um-note muted" style="margin-top:8px">Approving records that you vouch for this. Only ${escapeHtml(name)} can change the level or the certificate.</p>`;
  } else if (manages && r.expired) {
    // The one thing a manager may write on somebody else's entry: fresh
    // evidence for a ticket that has lapsed. The level is not theirs to touch.
    actions = `<div class="ud-danger">
      <button id="ms-d-renew">Record renewal</button>
    </div>
    <p class="um-note muted" style="margin-top:8px">This lapsed on ${escapeHtml(r.expires_at)}. You can record the new certificate; the level stays as ${escapeHtml(name)} recorded it.</p>`;
  } else if (manages) {
    actions = `<p class="um-note muted" style="margin-top:12px">Nothing to approve. Only ${escapeHtml(name)} can change this entry.</p>`;
  } else {
    actions = `<p class="um-note muted" style="margin-top:12px">You can see this, but only ${escapeHtml(name)}'s own manager can approve it.</p>`;
  }

  host.innerHTML = `
    <div class="ud-head">
      ${skIconHtml(r.skill, "lg")}
      <div class="ud-id">
        <div class="ud-name">${escapeHtml(r.skill.name)}</div>
        <div class="sk-head-meta">
          <span class="sk-cat"><span class="sk-dot" style="--c:${cat.color}"></span>${escapeHtml(cat.label)}</span>
          ${msStatusBadge(r)}
        </div>
      </div>
    </div>

    ${udCard("Held by", `<div class="gr-person">
      ${avatarHtml(r.username, d.profile, d.avatar)}
      <span class="gr-person-text">
        <span class="gr-person-name">${escapeHtml(name)}</span>
        ${name !== r.username ? `<span class="gr-person-sub">${escapeHtml(r.username)}</span>` : ""}
      </span>
    </div>`)}

    ${udCard("Assignment",
      udRow("Level", escapeHtml(levelDef(r.level).label)) +
      udRow("Recorded", escapeHtml(r.assigned_at || "—"), r.assigned_at ? "" : "ud-unset") +
      udRow("By", escapeHtml(r.assigned_by || "—"), r.assigned_by ? "" : "ud-unset") +
      udRow("Valid until", r.expires_at ? escapeHtml(r.expires_at) : "Never expires", r.expires_at ? "" : "ud-unset") +
      (r.approved_by ? udRow("Approved by", escapeHtml(r.approved_by)) : ""))}

    ${r.cert && (r.cert.number || r.cert.issuer || r.cert.issue_date)
      ? udCard("Certificate",
          udRow("Number", escapeHtml(r.cert.number || "—"), r.cert.number ? "" : "ud-unset") +
          udRow("Issued by", escapeHtml(r.cert.issuer || "—"), r.cert.issuer ? "" : "ud-unset") +
          udRow("Issue date", escapeHtml(r.cert.issue_date || "—"), r.cert.issue_date ? "" : "ud-unset"))
      : ""}

    ${actions}`;

  const on = (sel, fn) => { const el = host.querySelector(sel); if (el) el.addEventListener("click", fn); };
  on("#ms-d-edit", () => openMsPick(null, r));
  on("#ms-d-remove", () => dropMySkill(r));
  on("#ms-d-renew", () => openMsRenewal(r));
  on("#ms-d-ok", () => decideSkill(r.skill, r.username, false, msTeamMsg));
  on("#ms-d-no", () => decideSkill(r.skill, r.username, true, msTeamMsg));
}
function msTeamMsg() { return document.getElementById("ms-team-msg"); }
// openMsPick opens the picker. `target` is null when claiming for yourself or a
// username when assigning; `existing` pre-fills it when updating a skill you
// already hold.
// MS_RENEW marks the one case where a manager may touch an entry somebody else
// authored: a lapsed certificate that has been re-earned. The level is carried
// over rather than re-entered, so the claim stays the holder's own.
let MS_RENEW = false;
// openMsRenewal records fresh evidence against an expired assignment.
function openMsRenewal(r) { openMsPick(r.username, r, true); }
function openMsPick(target, existing, renew = false) {
  MS_TARGET = target;
  MS_RENEW = !!renew;
  const m = msPickModal();
  const self = target === null;

  const holderName = existing && !self
    ? displayName(existing.username, skDirEntry(existing.username).profile)
    : "";
  m.querySelector("#ms-pick-title").textContent = renew
    ? `Renew ${existing.skill.name}`
    : existing ? `Update ${existing.skill.name}`
    : self ? "Add a skill" : "Assign a skill";
  m.querySelector("#ms-pick-sub").textContent = renew
    ? `${holderName}'s certificate has expired. Record the new one — their level is unchanged.`
    : self ? "Pick a category, then a skill from the catalogue."
    : "Assigning counts as your approval.";
  m.querySelector("#ms-pick-msg").innerHTML = "";

  // The person is fixed for a renewal: it is a specific lapsed entry, not a
  // free choice of who to assign to.
  const whoRow = m.querySelector("#ms-who-row");
  whoRow.hidden = self || renew;
  if (!self && !renew) {
    m.querySelector("#ms-who").innerHTML = MS_TEAM
      .map((p) => `<option value="${escapeHtml(p.username)}">${escapeHtml(p.username)}</option>`).join("");
  }

  // Only categories that actually contain a pickable skill are offered: an
  // empty category in the list is a dead end the user cannot act on.
  const pickable = SKILLS.filter((s) => !s.archived);
  const cats = SKILL_CATS.filter((c) => pickable.some((s) => s.cat === c.key));
  const catSel = m.querySelector("#ms-cat");
  catSel.innerHTML = cats.map((c) => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.label)}</option>`).join("");
  if (existing) catSel.value = existing.skill.cat;

  // Updating an existing skill must not let the skill itself be swapped: that
  // would be a different assignment, not an edit of this one.
  catSel.disabled = !!existing;
  m.querySelector("#ms-skill").disabled = !!existing;

  renderMsSkillChoices(existing ? existing.skill.id : null);
  const levelSel = m.querySelector("#ms-level");
  if (existing) {
    levelSel.value = String(existing.level);
    // A renewal re-proves the existing claim, so the level is shown but not
    // editable, and the certificate starts blank -- the point is the new one.
    const blank = renew;
    m.querySelector("#ms-cert-number").value = blank ? "" : (existing.cert && existing.cert.number) || "";
    m.querySelector("#ms-cert-issuer").value = blank ? "" : (existing.cert && existing.cert.issuer) || "";
    m.querySelector("#ms-cert-date").value = blank ? "" : (existing.cert && existing.cert.issue_date) || "";
  }
  levelSel.disabled = renew;
  // A renewal is about the certificate, so those fields always show for it.
  if (renew) m.querySelector("#ms-cert-block").hidden = false;
  m.hidden = false;
}
// renderMsSkillChoices refills the skill picker for the chosen category, then
// the level and certificate fields for the chosen skill. Chained rather than
// independent: the level scale and the evidence rules are properties of the
// skill, so they cannot be drawn until one is picked.
function renderMsSkillChoices(preferID) {
  const m = msPickModal();
  const cat = m.querySelector("#ms-cat").value;
  const inCat = SKILLS.filter((s) => !s.archived && s.cat === cat);
  const skillSel = m.querySelector("#ms-skill");
  skillSel.innerHTML = inCat.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("");
  if (preferID) skillSel.value = preferID;
  renderMsSkillFields();
}
function renderMsSkillFields() {
  const m = msPickModal();
  const s = SKILLS.find((x) => x.id === m.querySelector("#ms-skill").value);
  const desc = m.querySelector("#ms-skill-desc");
  if (!s) { desc.textContent = ""; return; }

  // Say up front what the skill will require, so nobody fills the form in and
  // only then discovers it needs a certificate number they do not have to hand.
  const notes = [];
  if (s.desc) notes.push(s.desc);
  if (s.validity_months) notes.push(`Renew every ${validityLabel(s.validity_months).toLowerCase()}.`);
  if (s.requires_proof) notes.push("Certificate details required.");
  if (s.requires_approval) notes.push("A manager must approve this.");
  desc.textContent = notes.join(" ");

  m.querySelector("#ms-level").innerHTML = SKILL_LEVELS.slice(0, s.scale)
    .map((l) => `<option value="${l.n}">${l.n} · ${escapeHtml(l.label)}</option>`).join("");
  m.querySelector("#ms-cert-block").hidden = !s.requires_proof;
}
function closeMsPick() { msPickModal().hidden = true; }
async function submitMsPick() {
  const m = msPickModal();
  const msg = m.querySelector("#ms-pick-msg");
  const self = MS_TARGET === null;
  const skillID = m.querySelector("#ms-skill").value;
  if (!skillID) { showMsg(msg, "Pick a skill", "error"); return; }
  const s = SKILLS.find((x) => x.id === skillID);

  const body = {
    skill_id: skillID,
    level: Number(m.querySelector("#ms-level").value),
    cert: {
      number: m.querySelector("#ms-cert-number").value.trim(),
      issuer: m.querySelector("#ms-cert-issuer").value.trim(),
      issue_date: m.querySelector("#ms-cert-date").value,
    },
  };
  if (!self) {
    body.username = MS_RENEW ? MS_TARGET : m.querySelector("#ms-who").value;
    if (!body.username) { showMsg(msg, "Pick somebody to assign this to", "error"); return; }
  }
  const existed = self && MS_MINE.some((x) => x.skill_id === skillID);
  const r = await apiFetch(self ? "skills/mine" : "skills/assign", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) { showMsg(msg, await r.text(), "error"); return; }
  closeMsPick();
  // "Added" and "Updated" are different events to the reader, and the same call
  // serves both -- so the wording follows whether they already held it.
  const verb = existed ? "Updated" : "Added";
  showMsg(msMsg(), self
    ? (s.requires_approval && !existed
        ? `Added ${s.name} — waiting for a manager to approve it`
        : `${verb} ${s.name}`)
    : MS_RENEW ? `Renewed ${s.name} for ${body.username}`
    : `Assigned ${s.name} to ${body.username}`, "ok");
  await refreshMySkills();
}
async function dropMySkill(r) {
  if (!(await confirmModal({
    title: `Remove ${r.skill.name}`,
    body: "It stops counting towards your team's coverage. You can add it again later.",
  }))) return;
  const resp = await apiFetch("skills/mine", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skill_id: r.skill_id, level: 0 }),
  });
  if (!resp.ok) { showMsg(msMsg(), await resp.text(), "error"); return; }
  showMsg(msMsg(), `Removed ${r.skill.name}`, "ok");
  await refreshMySkills();
}
// refreshMySkills reads the one skills endpoint and splits it into the two
// views this page shows: my own assignments, and (for a manager) those of the
// people they control.
async function refreshMySkills() {
  if (!(await loadSkills())) return;

  // One flat list of every assignment on the server, joined to its catalog
  // entry. Both views read from it: mine is a filter on username, and the team /
  // company table filters on scope. The endpoint already returns the lot, so
  // widening the scope costs nothing extra.
  MS_ROWS = msJoin(
    Object.entries(SK_RATINGS).flatMap(([skillID, holders]) =>
      holders.map((h) => ({ ...h, skill_id: skillID }))));
  // Strongest and most urgent first: anything awaiting the viewer leads, then
  // by person so one name's skills stay together.
  MS_ROWS.sort((a, b) => {
    const ap = a.status === "pending", bp = b.status === "pending";
    if (ap !== bp) return ap ? -1 : 1;
    const an = displayName(a.username, skDirEntry(a.username).profile);
    const bn = displayName(b.username, skDirEntry(b.username).profile);
    return an.localeCompare(bn) || a.skill.name.localeCompare(b.skill.name);
  });

  MS_MINE = MS_ROWS.filter((r) => r.username === window.TT_USER);

  // A selection can vanish under you when a claim is approved elsewhere.
  if (MS_SEL && !MS_ROWS.some((r) => msRowKey(r) === MS_SEL)) MS_SEL = null;

  renderMsTiles();
  renderMsTable();
  renderMsCatFilter();
  renderMsTeam();
  renderMsTeamDetails();
}
// renderMsCatFilter fills the category dropdown from the categories actually in
// use, preserving the current choice across refreshes.
function renderMsCatFilter() {
  const sel = document.getElementById("ms-cat-filter");
  const keep = sel.value;
  const used = [...new Set(MS_ROWS.map((r) => r.skill.cat))];
  sel.innerHTML = `<option value="">All categories</option>` +
    SKILL_CATS.filter((c) => used.includes(c.key))
      .map((c) => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.label)}</option>`).join("");
  sel.value = keep;
}
async function initMySkills() {
  try {
    const who = await apiFetch("whoami");
    if (who.ok) {
      const d = await who.json();
      window.TT_USER = d.username;
      window.TT_CAPS = d.caps || [];
      window.TT_IS_CONTROLLER = !!d.is_controller;
    }
  } catch (e) { /* the page still renders; the team panel just stays hidden */ }

  document.getElementById("ms-add-btn").addEventListener("click", () => openMsPick(null, null));
  document.getElementById("ms-assign-btn").addEventListener("click", () => openMsPick("", null));

  // Toolbar. Repainting the details too, since a filter change can hide the
  // selected row and the panel must not keep describing something off-screen.
  const refilter = () => { renderMsTeam(); renderMsTeamDetails(); };
  document.getElementById("ms-search").addEventListener("input", refilter);
  document.getElementById("ms-scope").addEventListener("change", refilter);
  document.getElementById("ms-cat-filter").addEventListener("change", refilter);
  document.getElementById("ms-status-filter").addEventListener("change", refilter);
  document.getElementById("ms-pick-cancel").addEventListener("click", closeMsPick);
  document.getElementById("ms-pick-save").addEventListener("click", submitMsPick);
  document.getElementById("ms-cat").addEventListener("change", () => renderMsSkillChoices(null));
  document.getElementById("ms-skill").addEventListener("change", renderMsSkillFields);
  msPickModal().addEventListener("click", (e) => {
    if (e.target.id === "ms-pick-modal") closeMsPick();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMsPick(); });

  await refreshMySkills();
}
// The two axes of the skill catalog: the categories skills are filed under, and
// the proficiency scale everyone rates against. Both are admin-owned because
// they are the shared vocabulary -- reshaping them re-reads every existing
// rating -- while the skills themselves are contributed by users on the Skills
// page.
//
// Each list is edited as a draft and saved whole. The server replaces the list
// in one write, so a partial-update protocol would buy nothing for arrays this
// small, and editing in place keeps reordering trivial.

let SC_CATS = [];   // draft [{key,label,color}]; key is "" for unsaved rows
let SC_LEVELS = []; // draft [{n,label}]
let SC_USED = {};   // category key -> how many skills use it
function scCatsMsg() { return document.getElementById("sc-cats-msg"); }
function scLevelsMsg() { return document.getElementById("sc-levels-msg"); }
async function loadSkillAxes() {
  const r = await apiFetch("admin/skill-axes");
  if (!r.ok) { showMsg(scCatsMsg(), await r.text(), "error"); return false; }
  const d = await r.json();
  SC_CATS = (d.categories || []).map((c) => ({ ...c }));
  SC_LEVELS = (d.levels || []).map((l) => ({ ...l }));
  SC_USED = d.used || {};
  return true;
}
// The categories page is a table with a side panel, the same shape as Users:
// pick a category on the left, act on it on the right. Editing is one row at a
// time through the per-item endpoint, so the list is the server's state rather
// than a local draft.

let SC_SELECTED = null; // key of the selected category
function scCat(key) { return SC_CATS.find((c) => c.key === key) || null; }
// scVisible applies the toolbar: search text and the archived switch.
function scVisible() {
  const q = (document.getElementById("sc-search").value || "").trim().toLowerCase();
  const showArchived = document.getElementById("sc-show-archived").checked;
  return SC_CATS.filter((c) => {
    if (c.archived && !showArchived) return false;
    if (q && !c.label.toLowerCase().includes(q) && !c.key.includes(q)) return false;
    return true;
  });
}
function renderScTable() {
  const body = document.getElementById("sc-body");
  const rows = scVisible();
  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="4" class="muted">${SC_CATS.length ? "No categories match your search." : "No categories yet — add one to get started."}</td></tr>`;
  } else {
    body.innerHTML = rows.map((c) => {
      const used = SC_USED[c.key] || 0;
      const sel = c.key === SC_SELECTED ? " selected" : "";
      return `<tr class="um-row${sel}" data-k="${escapeHtml(c.key)}">
        <td>
          <div class="um-user">
            <span class="sc-swatch" style="--c:${escapeHtml(c.color)}"></span>
            <span class="um-name">${escapeHtml(c.label)}</span>
          </div>
        </td>
        <td class="muted">${used ? `${used} skill${used === 1 ? "" : "s"}` : "—"}</td>
        <td>${c.archived ? `<span class="badge muted">Archived</span>` : `<span class="badge ok">Active</span>`}</td>
        <td>
          <div class="te-menu">
            <button class="sc-menu-btn" aria-label="Actions">⋯</button>
            <div class="menu-pop">
              <button class="sc-m-edit">Edit</button>
              <button class="sc-m-archive">${c.archived ? "Restore" : "Archive"}</button>
              <button class="sc-m-delete danger-btn"${used ? " disabled title='In use — archive instead'" : ""}>Delete</button>
            </div>
          </div>
        </td>
      </tr>`;
    }).join("");
  }
  document.getElementById("sc-count").textContent =
    `${rows.length} of ${SC_CATS.length} categor${SC_CATS.length === 1 ? "y" : "ies"}`;

  body.querySelectorAll(".um-row").forEach((tr) => tr.addEventListener("click", () => selectScCat(tr.dataset.k)));
  body.querySelectorAll(".sc-menu-btn").forEach((btn) => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    openRowMenu(btn, btn.nextElementSibling);
  }));
  const rowCat = (el) => scCat(el.closest(".um-row").dataset.k);
  body.querySelectorAll(".sc-m-edit").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation(); closeAllMenus(); openScModal(rowCat(b));
  }));
  body.querySelectorAll(".sc-m-archive").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation(); closeAllMenus(); toggleScArchive(rowCat(b));
  }));
  body.querySelectorAll(".sc-m-delete").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    if (b.disabled) return;
    closeAllMenus(); deleteScCat(rowCat(b));
  }));
}
function selectScCat(key) {
  SC_SELECTED = key;
  renderScTable();
  renderScDetails();
}
function renderScDetails() {
  const host = document.getElementById("sc-details");
  const c = scCat(SC_SELECTED);
  if (!c) {
    host.classList.remove("filled");
    host.innerHTML = `<div class="um-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h8l10 10-8 8L3 11V3z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>
      <p>Select a category to edit it, or add a new one.</p>
    </div>`;
    return;
  }
  host.classList.add("filled");
  const used = SC_USED[c.key] || 0;

  host.innerHTML = `
    <div class="ud-head">
      <span class="sc-swatch lg" style="--c:${escapeHtml(c.color)}"></span>
      <div class="ud-id">
        <div class="ud-name">${escapeHtml(c.label)}</div>
        <span class="badge ${c.archived ? "muted" : "ok"}">${c.archived ? "Archived" : "Active"}</span>
      </div>
    </div>

    ${udCard("Usage",
      udRow("Skills filed here", used ? `${used}` : "None", used ? "" : "ud-unset") +
      udRow("Key", escapeHtml(c.key)) +
      (c.archived
        ? `<p class="um-note muted" style="margin-top:8px">Hidden when adding a skill. Its ${used} skill${used === 1 ? "" : "s"} keep it.</p>`
        : ""))}

    <div class="ud-danger">
      <button class="secondary" id="sc-d-edit">Edit category</button>
      <button class="secondary" id="sc-d-archive">${c.archived ? "Restore" : "Archive"}</button>
      <button class="danger-btn" id="sc-d-delete"${used ? " disabled" : ""}>Delete category</button>
    </div>
    ${used ? `<p class="um-note muted" style="margin-top:8px">In use, so it can't be deleted — archive it instead.</p>` : ""}`;

  host.querySelector("#sc-d-edit").addEventListener("click", () => openScModal(c));
  host.querySelector("#sc-d-archive").addEventListener("click", () => toggleScArchive(c));
  const del = host.querySelector("#sc-d-delete");
  if (!used) del.addEventListener("click", () => deleteScCat(c));
}
let SC_EDIT_KEY = null; // key being edited, or null when creating
function scModal() { return document.getElementById("sc-modal"); }
function openScModal(c) {
  SC_EDIT_KEY = c ? c.key : null;
  const m = scModal();
  m.querySelector("#sc-modal-title").textContent = c ? `Edit ${c.label}` : "New category";
  m.querySelector("#sc-name").value = c ? c.label : "";
  m.querySelector("#sc-color").value = c ? c.color : "#4C82F7";
  m.querySelector("#sc-archived-toggle").checked = !!(c && c.archived);
  m.querySelector("#sc-modal-msg").innerHTML = "";
  m.hidden = false;
  m.querySelector("#sc-name").focus();
}
function closeScModal() { scModal().hidden = true; }
async function saveScCat() {
  const m = scModal();
  const msg = m.querySelector("#sc-modal-msg");
  const label = m.querySelector("#sc-name").value.trim();
  if (!label) { showMsg(msg, "Enter a category name", "error"); return; }
  const body = {
    label,
    color: m.querySelector("#sc-color").value,
    archived: m.querySelector("#sc-archived-toggle").checked,
  };
  if (SC_EDIT_KEY) body.key = SC_EDIT_KEY;
  const r = await apiFetch("admin/skill-cat", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) { showMsg(msg, await r.text(), "error"); return; }
  const d = await r.json();
  closeScModal();
  SC_SELECTED = d.key || SC_SELECTED;
  showMsg(scCatsMsg(), SC_EDIT_KEY ? `Saved ${label}` : `Created ${label}`, "ok");
  await refreshScCats();
}
// toggleScArchive flips one category's archived flag through the same save,
// re-sending its label and colour unchanged.
async function toggleScArchive(c) {
  const r = await apiFetch("admin/skill-cat", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: c.key, label: c.label, color: c.color, archived: !c.archived }),
  });
  if (!r.ok) { showMsg(scCatsMsg(), await r.text(), "error"); return; }
  showMsg(scCatsMsg(), c.archived ? `Restored ${c.label}` : `Archived ${c.label}`, "ok");
  await refreshScCats();
}
async function deleteScCat(c) {
  if (!(await confirmModal({
    title: `Delete category "${c.label}"`,
    body: "This cannot be undone. Categories in use can't be deleted — archive them instead.",
  }))) return;
  const r = await apiFetch("admin/skill-cat", {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: c.key }),
  });
  if (!r.ok) { showMsg(scCatsMsg(), await r.text(), "error"); return; }
  if (SC_SELECTED === c.key) SC_SELECTED = null;
  showMsg(scCatsMsg(), `Deleted ${c.label}`, "ok");
  await refreshScCats();
}
// refreshScCats re-reads the axes and repaints. Every mutation goes through it,
// since the used-counts and the list both come from the one endpoint.
async function refreshScCats() {
  if (await loadSkillAxes()) {
    renderScTable();
    renderScDetails();
  }
}
async function initSkillCats() {
  if (!(await requireCap("skills.manage"))) return;

  const rerender = () => renderScTable();
  document.getElementById("sc-search").addEventListener("input", rerender);
  document.getElementById("sc-show-archived").addEventListener("change", rerender);
  document.getElementById("sc-add-btn").addEventListener("click", () => openScModal(null));
  document.getElementById("sc-cancel").addEventListener("click", closeScModal);
  document.getElementById("sc-save").addEventListener("click", saveScCat);
  scModal().addEventListener("click", (e) => { if (e.target.id === "sc-modal") closeScModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeScModal(); });
  document.addEventListener("click", closeAllMenus);

  await refreshScCats();
}
function renderScLevels() {
  const host = document.getElementById("sc-levels");
  host.innerHTML = SC_LEVELS.map((l, i) => `
    <div class="sd-lv sc-row" data-i="${i}">
      <span class="n">${i + 1}</span>
      <span class="sk-dot" style="--c:${scLvColor(i + 1)}"></span>
      <input type="text" class="em-input sc-label" value="${escapeHtml(l.label)}" placeholder="Level name" autocomplete="off">
      <button class="icon-btn sc-up" title="Move up" ${i === 0 ? "disabled" : ""}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
      </button>
      <button class="icon-btn sc-del" title="Remove" ${SC_LEVELS.length <= 2 ? "disabled" : ""}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
      </button>
    </div>`).join("");

  host.querySelectorAll(".sc-row").forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelector(".sc-label").addEventListener("input", (e) => { SC_LEVELS[i].label = e.target.value; });
    row.querySelector(".sc-up").addEventListener("click", () => {
      if (i === 0) return;
      [SC_LEVELS[i - 1], SC_LEVELS[i]] = [SC_LEVELS[i], SC_LEVELS[i - 1]];
      renderScLevels();
    });
    row.querySelector(".sc-del").addEventListener("click", () => {
      if (SC_LEVELS.length <= 2) return;
      SC_LEVELS.splice(i, 1);
      renderScLevels();
    });
  });
}
// scLvColor mirrors lvColor on the Skills page, so the scale previews here in
// the same colours it renders there.
function scLvColor(n) {
  const span = Math.max(1, SC_LEVELS.length - 1);
  const i = Math.min(5, Math.max(1, Math.round(1 + ((n - 1) / span) * 4)));
  return `var(--lv-${i})`;
}
async function saveScLevels() {
  const r = await apiFetch("admin/skill-levels", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ levels: SC_LEVELS.map((l) => ({ label: l.label })) }),
  });
  if (!r.ok) { showMsg(scLevelsMsg(), await r.text(), "error"); return; }
  showMsg(scLevelsMsg(), "Proficiency levels saved", "ok");
  if (await loadSkillAxes()) renderScLevels();
}
async function initSkillLevels() {
  if (!(await requireCap("skills.manage"))) return;

  document.getElementById("sc-add-level").addEventListener("click", () => {
    if (SC_LEVELS.length >= 10) {
      showMsg(scLevelsMsg(), "At most 10 levels are supported", "error");
      return;
    }
    SC_LEVELS.push({ n: SC_LEVELS.length + 1, label: "" });
    renderScLevels();
    const rows = document.querySelectorAll("#sc-levels .sc-label");
    if (rows.length) rows[rows.length - 1].focus();
  });
  document.getElementById("sc-save-levels").addEventListener("click", saveScLevels);

  if (await loadSkillAxes()) renderScLevels();
}

registerPage("ms-body", initMySkills);
registerPage("skills-body", initSkills);
registerPage("sc-body", initSkillCats);
registerPage("sc-levels", initSkillLevels);
