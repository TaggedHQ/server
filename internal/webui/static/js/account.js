// account.js -- everything only the account page needs.
// core.js holds what every page shares and is loaded first; the
// registerPage call at the bottom hooks this into its page registry.

// promptModal asks for a single line of text. Resolves the trimmed value, or
// null when cancelled or left empty.
function promptModal(opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let ui = null, done = false;
    const finish = (v) => { if (done) return; done = true; ui.overlay.close(); resolve(v); };
    ui = modalSheet("confirm", () => finish(null));
    ui.sheet.innerHTML = `
      <div class="sheet-title">${escapeHtml(o.title || "")}</div>
      <div class="sheet-section">
        <div class="pw-field">
          <label for="pm-value">${escapeHtml(o.label || "Name")}</label>
          <input id="pm-value" type="text" autocomplete="off">
        </div>
      </div>
      <div class="em-msg" data-a="msg"></div>
      <div class="sheet-actions">
        <div class="spacer"></div>
        <button class="secondary" type="button" data-a="cancel">Cancel</button>
        <button type="button" data-a="ok">${escapeHtml(o.confirmLabel || "Save")}</button>
      </div>`;
    const input = ui.sheet.querySelector("#pm-value");
    const msg = ui.sheet.querySelector('[data-a="msg"]');
    input.value = o.value || "";
    const submit = () => {
      const v = input.value.trim();
      if (!v) { msg.textContent = "Enter a value."; input.focus(); return; }
      finish(v);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    ui.sheet.querySelector('[data-a="cancel"]').addEventListener("click", () => finish(null));
    ui.sheet.querySelector('[data-a="ok"]').addEventListener("click", submit);
    input.focus();
    input.select();
  });
}
// prepCreationOptions / prepRequestOptions decode the base64url fields of the
// server's options into ArrayBuffers for navigator.credentials.
function prepCreationOptions(o) {
  o.challenge = b64urlToBuf(o.challenge);
  o.user.id = b64urlToBuf(o.user.id);
  (o.excludeCredentials || []).forEach((c) => { c.id = b64urlToBuf(c.id); });
  return o;
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

  bind("set-week-start", WEEK_START_KEY, "weekStart", (v) => Number(v));
  bind("set-workdays", WORKDAYS_KEY, "workdays");
  bind("set-timezone", TIMEZONE_KEY, "timezone");
  initLanguagePref(msg);
}
// initLanguagePref fills the language dropdown from the languages the admin has
// actually enabled, and on change writes both halves of the pair: the synced
// setting (so the choice follows the user to another browser) and the cookie
// (so the server can render the next page in it).
async function initLanguagePref(msg) {
  const sel = document.getElementById("set-language");
  if (!sel) return;
  let langs = [{ code: "en", label: "English" }];
  try {
    const r = await fetch(API + "languages");
    if (r.ok) langs = (await r.json()).languages || langs;
  } catch (e) { /* offline: English only, which is always valid */ }

  sel.innerHTML = langs
    .map((l) => `<option value="${escapeHtml(l.code)}">${escapeHtml(l.label)}</option>`)
    .join("");
  // A language that has since been removed or disabled would otherwise leave
  // the select blank and look broken.
  sel.value = langs.some((l) => l.code === PREFS.language) ? PREFS.language : "en";

  sel.addEventListener("change", async () => {
    const code = sel.value;
    const ok = await savePref(LANGUAGE_KEY, "language", code);
    if (!ok) { showMsg(msg, t("Failed to save"), "error"); return; }
    setLangCookie(code);
    localStorage.setItem(LANG_OWNER_KEY, localStorage.getItem(USER_KEY) || "");
    showMsg(msg, t("Preferences saved"), "ok");
    // Reload so the server re-renders the static markup in the new language;
    // translating in place would leave anything already painted behind.
    sessionStorage.removeItem("tagged_web_lang_reloaded");
    setTimeout(() => location.reload(), 400);
  });
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
    const label = await promptModal({
      title: "Name this passkey",
      label: "Passkey name",
      value: "Passkey",
      confirmLabel: "Continue",
    });
    if (label === null) return; // cancelled
    showMsg(msg, "Follow your device's prompt…", "");
    let options;
    try {
      const r = await apiFetch("webauthn/register/begin", { method: "POST" });
      if (!r.ok) { showMsg(msg, (await r.text()) || "Could not start registration", "error"); return; }
      options = prepCreationOptions((await r.json()).publicKey);
    } catch (e) { showMsg(msg, t("Network error"), "error"); return; }
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
    } catch (e) { showMsg(msg, t("Network error"), "error"); }
  }

  async function remove(id) {
    if (!(await confirmModal({
      title: "Remove passkey",
      body: "Remove this passkey? It can no longer be used to sign in.",
      confirmLabel: "Remove",
    }))) return;
    try {
      const r = await apiFetch("webauthn/credentials", {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
      });
      if (!r.ok) { showMsg(msg, (await r.text()) || "Could not remove passkey", "error"); return; }
      render((await r.json()).credentials || []);
      showMsg(msg, "Passkey removed", "ok");
    } catch (e) { showMsg(msg, t("Network error"), "error"); }
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
          <span class="mfa-note">${escapeHtml(tn("{n} backup code remaining", "{n} backup codes remaining", state.remaining))}</span>
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
    const tok = await fetchApiToken(false);
    if (!tok) { showMsg(msg, "Could not load token", "error"); return; }
    token = tok;
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
    const tok = await fetchApiToken(false);
    if (!tok) { showMsg(msg, "Could not load token", "error"); return; }
    token = tok;
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
    if (!(await confirmModal({
      title: "Regenerate API token",
      body: "Regenerate the API token? The previous token will stop working immediately.",
      confirmLabel: "Regenerate",
    }))) return;
    showMsg(msg, "Regenerating…", "");
    const tok = await fetchApiToken(true);
    if (!tok) { showMsg(msg, "Failed to regenerate", "error"); return; }
    token = tok;
    input.value = token;
    reveal();
    showMsg(msg, "New token generated", "ok");
  });
}
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

registerPage("acc-username", initAccount);
