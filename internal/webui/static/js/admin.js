// admin.js -- everything only the admin page needs.
// core.js holds what every page shares and is loaded first; the
// registerPage call at the bottom hooks this into its page registry.

// passwordModal asks for a new password twice and only resolves once the two
// entries match and clear the minimum length. Resolves null when cancelled.
function passwordModal(opts) {
  const o = opts || {};
  const min = o.minLength || 4;
  return new Promise((resolve) => {
    let ui = null, done = false;
    const finish = (v) => { if (done) return; done = true; ui.overlay.close(); resolve(v); };
    ui = modalSheet("confirm", () => finish(null));
    ui.sheet.innerHTML = `
      <div class="sheet-title">${escapeHtml(o.title || "Reset password")}</div>
      <div class="sheet-section">
        <div class="confirm-body" data-a="body"></div>
        <div class="pw-field">
          <label for="pwm-1">New password</label>
          <input id="pwm-1" type="password" autocomplete="new-password">
        </div>
        <div class="pw-field">
          <label for="pwm-2">Confirm password</label>
          <input id="pwm-2" type="password" autocomplete="new-password">
        </div>
      </div>
      <div class="em-msg" data-a="msg"></div>
      <div class="sheet-actions">
        <div class="spacer"></div>
        <button class="secondary" type="button" data-a="cancel">Cancel</button>
        <button type="button" data-a="ok">${escapeHtml(o.confirmLabel || "Set password")}</button>
      </div>`;
    const body = ui.sheet.querySelector('[data-a="body"]');
    if (o.body) body.textContent = o.body; else body.remove();
    const p1 = ui.sheet.querySelector("#pwm-1");
    const p2 = ui.sheet.querySelector("#pwm-2");
    const msg = ui.sheet.querySelector('[data-a="msg"]');
    const submit = () => {
      if (p1.value.length < min) { msg.textContent = `Password must be at least ${min} characters.`; p1.focus(); return; }
      if (p1.value !== p2.value) { msg.textContent = "Passwords do not match."; p2.focus(); p2.select(); return; }
      finish(p1.value);
    };
    [p1, p2].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); }));
    ui.sheet.querySelector('[data-a="cancel"]').addEventListener("click", () => finish(null));
    ui.sheet.querySelector('[data-a="ok"]').addEventListener("click", submit);
    p1.focus();
  });
}
function fmtBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
// Admin page state: the full user list and the currently-selected username.
let ADMIN_USERS = [];
let ADMIN_SELECTED = null;
let USER_DRAFT = null; // profile fields + avatar being edited in the details panel
// Groups are server-wide, so the page loads them once and reads each user's
// membership out of them. null means "not loaded" (no groups.manage permission),
// which hides the Groups card rather than showing an empty one.
let ADMIN_GROUPS = null;
// roleOf maps a user record to a single primary role badge.
// roleOf maps a user record to its role badge. The server sends the role key and
// label, so a custom role shows its own name; the class still keys off the two
// built-ins plus "can switch to users", which is what the colours mean.
function roleOf(u) {
  const key = u.role || (u.is_admin ? "admin" : u.is_controller ? "controller" : "user");
  const label = u.config_admin ? "Admin · config" : (u.role_label || key);
  const cls = key === "admin" ? "admin" : u.is_controller ? "controller" : "muted";
  return { key, label, cls };
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
        <td><span class="badge ${role.cls}">${escapeHtml(t(role.label))}</span></td>
        <td><span class="status-dot ${st.cls}"></span>${escapeHtml(st.label)}</td>
        <td class="muted">${fmtBytes(u.size_bytes)}</td>
        <td class="muted">${fmtDate(u.modified)}</td>
        <td><button class="um-dots" data-u="${uAttr}" title="Actions">⋯</button></td>
      </tr>`;
    }).join("");
  }
  count.textContent = t("Showing {shown} of {total}", { shown: rows.length, total: tn("{n} user", "{n} users", ADMIN_USERS.length) });

  body.querySelectorAll(".um-row").forEach((tr) => tr.addEventListener("click", (e) => {
    if (e.target.closest(".um-dots")) return; // dots handled separately
    selectUser(tr.dataset.u);
  }));
  body.querySelectorAll(".um-dots").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    openUserRowMenu(b, b.dataset.u);
  }));
}
function adminMsg() { return document.getElementById("users-msg"); }
async function actResetPassword(username) {
  const pw = await passwordModal({
    title: `Reset password for ${username}`,
    body: "The user can sign in with this password immediately. Existing sessions are unaffected.",
    confirmLabel: "Reset password",
  });
  if (pw === null) return;
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
  if (!(await confirmModal({
    title: `Reset two-factor for ${username}`,
    body: `${s.confirm}\n\nThey can sign in with their password alone until they set it up again.`,
    confirmLabel: "Reset",
  }))) return;
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
    ? {
        title: `Deactivate ${username}`,
        body: "Their data is kept, but they are signed out everywhere and cannot log in until you reactivate them.",
        confirmLabel: "Deactivate",
      }
    : {
        title: `Reactivate ${username}`,
        body: "They will be able to log in again.",
        confirmLabel: "Reactivate",
        danger: false,
      };
  if (!(await confirmModal(q))) return;
  const r = await apiFetch("admin/disable", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, disabled }),
  });
  if (r.ok) { showMsg(adminMsg(), `${disabled ? "Deactivated" : "Reactivated"} ${username}`, "ok"); loadUsers(); }
  else showMsg(adminMsg(), await r.text(), "error");
}
async function actDeleteUser(username) {
  if (!(await confirmModal({
    title: `Delete ${username}`,
    body: `Delete user "${username}" and all their data? This cannot be undone.`,
  }))) return;
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
function openUserRowMenu(anchor, username) {
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
  if (u.passkeys) parts.push(tn("{n} passkey", "{n} passkeys", u.passkeys));
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
        <span class="badge ${role.cls}">${escapeHtml(t(role.label))}</span>
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
  const def = (ADMIN_ROLES || []).find((r) => r.key === role.key);
  const roleNote = u.config_admin
    ? "Configured root admin — the role is fixed in the server config."
    : (def && def.desc) || "";
  const rolesCard = udCard("Roles", `
    <div class="ud-roles"><span class="badge ${role.cls}">${escapeHtml(t(role.label))}</span></div>
    <p class="muted um-note">${escapeHtml(roleNote)}</p>`,
    u.config_admin || isSelf || !(window.TT_CAPS || []).includes("roles.manage")
      ? "" : `<button class="secondary btn-sm" id="d-manage-roles">Manage</button>`);

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
// ADMIN_ROLES is the server's role list, so the users page offers exactly the
// roles that exist -- including any the operator added.
let ADMIN_ROLES = [];
// loadAdminRoles fetches it. A visitor without roles.manage gets a 403; the
// Manage button is hidden for them anyway, so an empty list is the right
// fallback rather than an error.
async function loadAdminRoles() {
  const r = await apiFetch("admin/roles");
  if (!r.ok) { ADMIN_ROLES = []; return; }
  ADMIN_ROLES = (await r.json()).roles || [];
}
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
function editGroupsModal() { return document.getElementById("edit-groups-modal"); }
let GROUP_PICK = null; // Set of group ids ticked in the modal
// openEditGroups lists every group. Which control it uses follows the rule the
// server enforces: a member belongs to exactly one group, so those are radios
// (plus a "no group" option, since leaving is a legitimate choice); a controller
// oversees any number, so those stay checkboxes.
function openEditGroups(username) {
  const u = ADMIN_USERS.find((x) => x.username === username);
  if (!u || !ADMIN_GROUPS) return;
  const slot = groupSlotOf(u);
  if (!slot) return;
  const single = slot === "members";
  GROUP_PICK = new Set(groupsOf(u).map((g) => g.id));

  const m = editGroupsModal();
  m.querySelector("#eg-msg").innerHTML = "";
  m.querySelector("#eg-intro").textContent = single
    ? `${displayName(u.username, u.profile)} belongs to the one group you pick.`
    : `${displayName(u.username, u.profile)} controls the groups you tick, and can act as their members.`;

  const choice = (id, label, desc, on) => `
    <label class="group-choice${on ? " on" : ""}" data-group="${escapeHtml(id)}">
      <input type="${single ? "radio" : "checkbox"}"${single ? ' name="eg-group"' : ""} ${on ? "checked" : ""}>
      <span class="group-choice-text">
        <span class="group-choice-label">${escapeHtml(label)}</span>
        <span class="group-choice-desc">${desc}</span>
      </span>
    </label>`;

  let html = ADMIN_GROUPS.map((g) => {
    const count = (g[slot] || []).length;
    return choice(g.id, g.name, g.description
      ? escapeHtml(g.description)
      : `${count} ${single ? "member" : "controller"}${count === 1 ? "" : "s"}`,
      GROUP_PICK.has(g.id));
  }).join("");
  // Radios cannot be un-picked by clicking, so leaving every group needs its own
  // option -- otherwise a member could never be removed from this screen.
  if (single) {
    html = choice("", "No group", "Not on any team.", GROUP_PICK.size === 0) + html;
  }
  m.querySelector("#eg-options").innerHTML = html;

  m.querySelectorAll(".group-choice").forEach((el) => el.addEventListener("change", () => {
    const id = el.dataset.group;
    if (single) {
      GROUP_PICK = new Set(id ? [id] : []);
    } else if (el.querySelector("input").checked) {
      GROUP_PICK.add(id);
    } else {
      GROUP_PICK.delete(id);
    }
    // Radios move the highlight as a set, so repaint every row, not just this one.
    m.querySelectorAll(".group-choice").forEach((row) => {
      row.classList.toggle("on", row.dataset.group ? GROUP_PICK.has(row.dataset.group) : GROUP_PICK.size === 0);
    });
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
function editRolesModal() { return document.getElementById("edit-roles-modal"); }
let ROLE_PICK = null; // role key selected in the modal
function openEditRoles(username) {
  const u = ADMIN_USERS.find((x) => x.username === username);
  if (!u || u.config_admin) return;
  ROLE_PICK = roleOf(u).key;
  const m = editRolesModal();
  m.querySelector("#er-msg").innerHTML = "";
  m.querySelector("#er-options").innerHTML = (ADMIN_ROLES || []).map((role) => {
    const on = ROLE_PICK === role.key;
    return `<label class="role-choice${on ? " on" : ""}" data-role="${escapeHtml(role.key)}">
      <input type="radio" name="er-role" value="${escapeHtml(role.key)}" ${on ? "checked" : ""}>
      <span class="role-choice-text">
        <span class="role-choice-label">${escapeHtml(t(role.label))}</span>
        <span class="role-choice-desc">${escapeHtml(role.desc || "")}</span>
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
// applyRolePick writes the chosen role. One call now: the server stores the role
// key directly rather than the pair of booleans the three built-ins used to be.
async function applyRolePick(username) {
  const u = ADMIN_USERS.find((x) => x.username === username);
  if (!u || !ROLE_PICK) return;
  const msg = editRolesModal().querySelector("#er-msg");
  if (roleOf(u).key === ROLE_PICK) { closeEditRoles(); return; }

  showMsg(msg, "Saving…", "");
  const r = await apiFetch("admin/userrole", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, role: ROLE_PICK }),
  });
  if (!r.ok) { showMsg(msg, await r.text(), "error"); return; }
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
function openAddUser() {
  document.getElementById("create-msg").innerHTML = "";
  document.getElementById("new-username").value = "";
  document.getElementById("new-password").value = "";
  document.getElementById("add-user-modal").hidden = false;
  document.getElementById("new-username").focus();
}
function closeAddUser() { document.getElementById("add-user-modal").hidden = true; }
// renderRoleFilter fills the Users page role filter from the server's actual
// role list. The options used to be hardcoded to the three built-in roles, so
// any role an operator added on the Roles page could never be filtered on --
// and a renamed built-in showed its old label.
//
// The value is the role key, which is what userMatchesFilters compares against
// roleOf(u).key. The label goes through the catalog so built-in roles translate
// while an operator's own role name passes through unchanged.
function renderRoleFilter() {
  const sel = document.getElementById("role-filter");
  if (!sel) return;
  const keep = sel.value; // survive a re-render after roles change
  const all = sel.querySelector('option[value=""]');
  sel.innerHTML = "";
  sel.appendChild(all || new Option(t("All roles"), ""));
  for (const r of ADMIN_ROLES) {
    sel.appendChild(new Option(tKey(r.label || r.key), r.key));
  }
  // Only restore a selection that still exists; a deleted role must not leave
  // the list filtered by something invisible.
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";
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

  // Roles and groups first: the details panel renders both out of them, and a
  // visitor without the matching permission simply gets no card.
  await loadAdminRoles();
  renderRoleFilter();
  await loadUserGroups();
  loadUsers();
}
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
          <span class="badge ${roleBadgeCls(r.key)}">${escapeHtml(t(r.label))}</span>
        </div>
        <div class="rl-desc">${escapeHtml(t(r.desc))}</div>
      </td>
      <td class="muted">${caps}</td>
      <td class="muted">${escapeHtml(tn("{n} user", "{n} users", n))}</td>
      <td><button class="um-dots" data-r="${escapeHtml(r.key)}" title="Actions">⋯</button></td>
    </tr>`;
  }).join("");
  body.querySelectorAll(".um-row").forEach((tr) => tr.addEventListener("click", (e) => {
    if (e.target.closest(".um-dots")) return; // dots handled separately
    selectRole(tr.dataset.r);
  }));
  body.querySelectorAll(".um-dots").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    openRoleRowMenu(b, b.dataset.r);
  }));
}
// openRoleRowMenu mirrors the users and groups tables. A built-in role offers
// no rename or delete, so it gets no menu at all rather than two dead entries.
function openRoleRowMenu(anchor, key) {
  const r = ROLES.find((x) => x.key === key);
  if (!r || r.system) return;
  const rect = anchor.getBoundingClientRect();
  selectRole(key);
  openDotsMenu(rect, [
    `<button data-act="edit">Edit role</button>`,
    `<button class="danger" data-act="delete">Delete role</button>`,
  ], (act) => {
    if (act === "edit") openEditRole(key);
    else if (act === "delete") deleteRole(r);
  });
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
      <p>${escapeHtml(t("Select a role to view and edit its permissions."))}</p>
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
        <span class="perm-label">${escapeHtml(t(c.label))}</span>
        <span class="perm-desc">${escapeHtml(t(c.desc))}</span>
      </span>
      <span class="toggle">
        <input type="checkbox" data-cap="${escapeHtml(c.key)}" ${on ? "checked" : ""} ${isLocked ? "disabled" : ""}>
        <span class="slider"></span>
      </span>
    </label>`;
  }).join("");

  const head = `<div class="ud-head">
    <span class="gr-avatar">${escapeHtml(groupInitials(r.label))}</span>
    <div class="ud-id">
      <div class="ud-name-row">
        <span class="ud-name">${escapeHtml(r.label)}</span>
        ${r.system ? `<span class="badge muted">Built in</span>` : ""}
      </div>
      ${r.desc ? `<p class="gr-desc">${escapeHtml(r.desc)}</p>` : `<p class="gr-desc ud-unset">No description</p>`}
      <span class="ud-state">${escapeHtml(tn("{n} user", "{n} users", n))}</span>
    </div>
  </div>`;

  const permsCard = udCard(t("Permissions"), `
    <div class="perm-list">${rows}</div>
    ${locked.length ? `<p class="um-note muted" style="margin-top:10px">Dimmed permissions are required for the ${escapeHtml(r.label)} role and can't be removed.</p>` : ""}
    <div class="ud-danger" style="margin-top:14px">
      <button id="role-save" ${roleDirty() ? "" : "disabled"}>Save changes</button>
      <button class="secondary" id="role-reset" ${roleDirty() ? "" : "disabled"}>Reset</button>
    </div>`);

  // A built-in role keeps its name; only its permissions are editable.
  const actions = `<div class="ud-danger">
    <button class="secondary" id="role-edit" ${r.system ? "disabled title=\"Built-in roles cannot be renamed\"" : ""}>Edit role</button>
    <button class="danger-btn" id="role-delete" ${r.system ? "disabled title=\"Built-in roles cannot be deleted\"" : ""}>Delete role</button>
  </div>`;

  host.classList.add("filled");
  host.innerHTML = head + permsCard + actions;

  host.querySelectorAll(".perm-row input").forEach((cb) => cb.addEventListener("change", () => {
    if (cb.checked) ROLE_DRAFT.add(cb.dataset.cap);
    else ROLE_DRAFT.delete(cb.dataset.cap);
    // Re-render only to refresh the Save/Reset enabled state.
    renderRoleDetails();
  }));
  host.querySelector("#role-save").addEventListener("click", saveRole);
  host.querySelector("#role-reset").addEventListener("click", () => selectRole(r.key));
  if (!r.system) {
    host.querySelector("#role-edit").addEventListener("click", () => openEditRole(r.key));
    host.querySelector("#role-delete").addEventListener("click", () => deleteRole(r));
  }
}
// One modal serves both: with a key it renames, without one it creates.

let ROLE_EDIT_KEY = null;
function roleModal() { return document.getElementById("role-modal"); }
function openNewRole() {
  ROLE_EDIT_KEY = null;
  const m = roleModal();
  m.querySelector("#rm-title").textContent = "New role";
  m.querySelector("#rm-name").value = "";
  m.querySelector("#rm-desc").value = "";
  m.querySelector("#rm-save").textContent = "Create role";
  m.querySelector("#rm-msg").innerHTML = "";
  m.hidden = false;
  m.querySelector("#rm-name").focus();
}
function openEditRole(key) {
  const r = ROLES.find((x) => x.key === key);
  if (!r || r.system) return;
  ROLE_EDIT_KEY = key;
  const m = roleModal();
  m.querySelector("#rm-title").textContent = "Edit role";
  m.querySelector("#rm-name").value = r.label;
  m.querySelector("#rm-desc").value = r.desc || "";
  m.querySelector("#rm-save").textContent = "Save role";
  m.querySelector("#rm-msg").innerHTML = "";
  m.hidden = false;
  m.querySelector("#rm-name").focus();
}
function closeRoleModal() { roleModal().hidden = true; }
async function applyRoleModal() {
  const m = roleModal();
  const msg = m.querySelector("#rm-msg");
  const label = m.querySelector("#rm-name").value.trim();
  const desc = m.querySelector("#rm-desc").value.trim();
  if (!label) { showMsg(msg, t("A role name is required"), "error"); return; }
  showMsg(msg, "Saving…", "");
  const editing = !!ROLE_EDIT_KEY;
  const r = await apiFetch("admin/role", {
    method: editing ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(editing ? { role: ROLE_EDIT_KEY, label, desc } : { label, desc, caps: [] }),
  });
  if (!r.ok) { showMsg(msg, await r.text(), "error"); return; }
  const out = await r.json();
  closeRoleModal();
  showMsg(rolesMsg(), editing ? `Saved ${label}` : `Created ${label}`, "ok");
  // Land on the new role so its permissions can be set straight away.
  if (!editing && out.key) ROLE_SELECTED = out.key;
  loadRoles();
}
async function deleteRole(r) {
  if (!(await confirmModal({
    title: t("Delete role") + ` "${r.label}"`,
    body: t("Users keep their accounts; the role simply stops being available."),
  }))) return;
  const resp = await apiFetch("admin/role", {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: r.key }),
  });
  if (!resp.ok) { showMsg(rolesMsg(), await resp.text(), "error"); return; }
  showMsg(rolesMsg(), `Deleted ${r.label}`, "ok");
  if (ROLE_SELECTED === r.key) ROLE_SELECTED = null;
  loadRoles();
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

  document.getElementById("add-role-btn").addEventListener("click", openNewRole);
  document.getElementById("rm-cancel").addEventListener("click", closeRoleModal);
  roleModal().addEventListener("click", (e) => {
    if (e.target.id === "role-modal") closeRoleModal();
  });
  document.getElementById("rm-save").addEventListener("click", applyRoleModal);

  // Close the row menu on outside click / scroll / escape.
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#um-row-menu") && !e.target.closest(".um-dots")) closeRowMenu();
  });
  window.addEventListener("scroll", closeRowMenu, true);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeRowMenu();
    closeRoleModal();
  });

  loadRoles();
}
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
          <div class="um-user">${groupAvatarHtml(g, "sm")}<span class="um-name">${escapeHtml(g.name)}</span></div>
          ${g.description ? `<div class="rl-desc">${escapeHtml(g.description)}</div>` : ""}
        </td>
        <td><div class="ud-roles" style="margin:0">${ctrls}</div></td>
        <td class="muted">${escapeHtml(tn("{n} user", "{n} users", g.members.length))}</td>
        <td><button class="um-dots" data-g="${escapeHtml(g.id)}" title="Actions">⋯</button></td>
      </tr>`;
    }).join("");
  }
  count.textContent = t("Showing {shown} of {total}", { shown: rows.length, total: tn("{n} group", "{n} groups", GROUPS.length) });
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
// groupAvatarHtml renders a group's badge: its Font Awesome icon where it has
// one, and its initials otherwise -- the same "icon or shortcode" fallback a
// skill badge uses, so a group always shows something. `cls` adds a size
// modifier (e.g. "lg") shared with the .gr-avatar rules.
function groupAvatarHtml(g, cls = "") {
  const c = `gr-avatar${cls ? " " + cls : ""}`;
  if (g.icon) {
    return `<span class="${c}"><i class="${faClass(escapeHtml(g.icon), g.icon_style)}"></i></span>`;
  }
  return `<span class="${c}">${escapeHtml(groupInitials(g.name))}</span>`;
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
      <p>${escapeHtml(t("Select a group to manage its members and controllers."))}</p>
    </div>`;
    return;
  }
  host.classList.add("filled");

  const head = `<div class="ud-head">
    ${groupAvatarHtml(g)}
    <div class="ud-id">
      <div class="ud-name">${escapeHtml(g.name)}</div>
      ${g.description
        ? `<p class="gr-desc">${escapeHtml(g.description)}</p>`
        : `<p class="gr-desc ud-unset">No description</p>`}
    </div>
  </div>`;

  const controllersCard = udCard(t("Controllers"),
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
    icon: g.icon || "",
    icon_style: g.icon_style || "",
    members: g.members,
    controllers: g.controllers,
    ...changes,
  };
  const r = await apiFetch("admin/groups", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) { showMsg(msgEl, await r.text(), "error"); return false; }
  // Membership is exclusive, so a save can have pulled people off other groups.
  // Report it: the admin edited this group and needs to know what else moved.
  let note = okText;
  try {
    const moved = (await r.json()).moved || [];
    if (moved.length) {
      const who = moved.map((mv) => `${mv.username} (from ${mv.from_name || mv.from})`).join(", ");
      note = `${okText} — moved ${who}`;
    }
  } catch (e) { /* a body we cannot read must not turn a successful save into an error */ }
  showMsg(groupsMsg(), note, "ok");
  loadGroups();
  return true;
}
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
  // Members belong to one group, so adding someone takes them off their current
  // team. Name that team on the row: the move is a real side effect and the
  // admin should see it before clicking, not only in the message afterwards.
  const currentGroup = (u) => {
    if (PEOPLE_KIND !== "members") return "";
    const g = GROUPS.find((x) => x.id !== GROUP_SELECTED && (x.members || []).includes(u));
    return g ? `<span class="gr-move-note muted">moves from ${escapeHtml(g.name)}</span>` : "";
  };

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
        ${currentGroup(u)}
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
    ? `Who oversees ${g.name}. Only users with the Controller role can be picked, and a controller may oversee several groups.`
    : `Who belongs to ${g.name}. Only users with the User role can be picked, and adding someone moves them off their current group.`;
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
function groupEditModal() { return document.getElementById("edit-group-modal"); }
function openGroupEdit(id) {
  const g = GROUPS.find((x) => x.id === id);
  if (!g) return;
  const m = groupEditModal();
  m.querySelector("#eg-name").value = g.name;
  m.querySelector("#eg-desc").value = g.description || "";
  m.querySelector("#eg-group-msg").innerHTML = "";
  iconField("eg", g.icon || "", g.icon_style || "");
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
  if (!name) { showMsg(msg, t("A group name is required"), "error"); return; }
  showMsg(msg, "Saving…", "");
  const ok = await saveGroupFields(g, {
    name,
    description: m.querySelector("#eg-desc").value.trim(),
    icon: m.querySelector("#eg-icon").value,
    icon_style: m.querySelector("#eg-icon-style").value,
  }, msg, `Saved ${name}`);
  if (ok) closeGroupEdit();
}
function groupDuplicateModal() { return document.getElementById("duplicate-group-modal"); }
function openGroupDuplicate(id) {
  const g = GROUPS.find((x) => x.id === id);
  if (!g) return;
  const m = groupDuplicateModal();
  m.querySelector("#dg-name").value = `${g.name} copy`;
  m.querySelector("#dg-intro").textContent =
    t("Creates a new group with the same description, {controllers} and {members}.", { controllers: tn("{n} controller", "{n} controllers", g.controllers.length), members: tn("{n} member", "{n} members", g.members.length) });
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
  if (!name) { showMsg(msg, t("A name for the copy is required"), "error"); return; }
  showMsg(msg, "Duplicating…", "");
  const r = await apiFetch("admin/groups", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      description: g.description || "",
      icon: g.icon || "",
      icon_style: g.icon_style || "",
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
  if (!(await confirmModal({
    title: `Delete group "${g.name}"`,
    body: t("Its controllers lose access to these users. The user accounts themselves are not touched."),
  }))) return;
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
  iconField("new-group", "", "");
  document.getElementById("add-group-modal").hidden = false;
  document.getElementById("new-group-name").focus();
}
function closeAddGroup() { document.getElementById("add-group-modal").hidden = true; }
async function initGroups() {
  if (!(await requireCap("groups.manage"))) return;

  document.getElementById("group-search").addEventListener("input", renderGroupsTable);
  document.getElementById("add-group-btn").addEventListener("click", openAddGroup);
  document.getElementById("add-group-cancel").addEventListener("click", closeAddGroup);
  wireIconPicker();
  wireIconField("new-group", "add-group-modal");
  wireIconField("eg", "edit-group-modal");
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
    if (!name) { showMsg(createMsg, t("Enter a group name"), "error"); return; }
    showMsg(createMsg, "Creating…", "");
    const r = await apiFetch("admin/groups", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        description: document.getElementById("new-group-desc").value.trim(),
        icon: document.getElementById("new-group-icon").value,
        icon_style: document.getElementById("new-group-icon-style").value,
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

registerPage("users-body", initAdmin);
registerPage("roles-body", initRoles);
registerPage("groups-body", initGroups);
