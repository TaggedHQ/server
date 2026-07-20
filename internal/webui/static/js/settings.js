// settings.js -- everything only the settings page needs.
// core.js holds what every page shares and is loaded first; the
// registerPage call at the bottom hooks this into its page registry.

// Strings that originate on the server -- module metadata (modules.go) and the
// capability catalog (roles.go). They travel as English and are translated here
// on render. This function is never called: it exists so the build-time
// extractor catalogs the literals, since the render sites pass computed keys.
function i18nServerStrings() {
  t("Shifts"); t("Plan the working week for the groups you control, with open shifts and absences.");
  t("Skills"); t("Track skills, proficiency levels and how well the team covers them.");
  t("Manage users"); t("Create and delete accounts, reset passwords.");
  t("Manage roles"); t("Assign roles to users and edit role permissions.");
  t("Manage groups"); t("Create groups and assign members and controllers.");
  t("Server settings"); t("Change server-wide settings such as self-registration.");
  t("OAuth providers"); t("Configure external identity providers.");
  t("Switch to users"); t("View and edit the data of users in the groups they control.");
  t("Translations"); t("Add languages and translate the interface.");
  t("User"); t("Standard account. Full access to their own time data only.");
  t("Admin"); t("Administers the server: users, roles, groups and settings.");
  t("Controller"); t("Oversees the users in the groups they control.");
}
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
    if (!r.ok) { showMsg(msg, t("Could not load server settings"), "error"); return; }
    const d = await r.json();
    toggle.checked = !!d.registration_open;
    toggle.disabled = false;
  } catch (e) { showMsg(msg, t("Could not load server settings"), "error"); return; }

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
      showMsg(msg, open ? t("Registration enabled") : t("Registration disabled"), "ok");
    } catch (e) {
      toggle.checked = !open; // revert on failure
      showMsg(msg, "Could not save: " + (e.message || "error"), "error");
    } finally {
      toggle.disabled = false;
    }
  });

  loadModules();
  initSMTP();
}
// The relay the server sends mail through. Nothing sends yet; this configures it
// so a feature that needs to email a user has somewhere to go.

async function initSMTP() {
  const panel = document.getElementById("smtp-panel");
  if (!panel) return;
  const msg = document.getElementById("smtp-msg");
  const hint = document.getElementById("smtp-pw-hint");
  const el = (id) => document.getElementById(id);
  const fields = {
    enabled: el("smtp-enabled"), host: el("smtp-host"), port: el("smtp-port"),
    security: el("smtp-security"), username: el("smtp-username"),
    password: el("smtp-password"), from_addr: el("smtp-from-addr"),
    from_name: el("smtp-from-name"),
  };

  // The server never sends the stored password back, so the field starts blank
  // and an empty save keeps whatever is stored. Say which of the two it is,
  // otherwise a blank box looks like "no password set".
  let passwordSet = false;
  function refreshHint() {
    hint.textContent = passwordSet
      ? t("A password is stored. Leave blank to keep it.")
      : t("No password stored.");
  }

  try {
    const r = await apiFetch("admin/smtp");
    if (!r.ok) { showMsg(msg, t("Could not load email settings"), "error"); return; }
    const d = await r.json();
    const c = d.smtp || {};
    passwordSet = !!d.password_set;
    fields.enabled.checked = !!c.enabled;
    fields.host.value = c.host || "";
    fields.port.value = c.port || "";
    fields.security.value = c.security || "starttls";
    fields.username.value = c.username || "";
    fields.from_addr.value = c.from_addr || "";
    fields.from_name.value = c.from_name || "";
    refreshHint();
  } catch (e) { showMsg(msg, t("Could not load email settings"), "error"); return; }

  function collect() {
    return {
      enabled: fields.enabled.checked,
      host: fields.host.value.trim(),
      port: parseInt(fields.port.value, 10) || 0,
      security: fields.security.value,
      username: fields.username.value.trim(),
      password: fields.password.value,
      from_addr: fields.from_addr.value.trim(),
      from_name: fields.from_name.value.trim(),
    };
  }

  el("smtp-save").addEventListener("click", async () => {
    showMsg(msg, "Saving…", "");
    try {
      const r = await apiFetch("admin/smtp", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collect()),
      });
      if (!r.ok) { showMsg(msg, (await r.text()) || "Save failed", "error"); return; }
      if (fields.password.value) passwordSet = true;
      fields.password.value = ""; // never leave the secret sitting in the DOM
      refreshHint();
      showMsg(msg, t("Email settings saved."), "ok");
    } catch (e) { showMsg(msg, t("Network error"), "error"); }
  });

  el("smtp-test").addEventListener("click", async () => {
    const to = el("smtp-test-to").value.trim();
    if (!to) { showMsg(msg, t("Enter an address to send the test to."), "error"); return; }
    // The test sends with what is stored, not what is on screen, so unsaved
    // edits would be tested silently against the old settings.
    showMsg(msg, t("Sending…"), "");
    try {
      const r = await apiFetch("admin/smtp-test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: to }),
      });
      if (!r.ok) { showMsg(msg, (await r.text()) || "Could not send", "error"); return; }
      showMsg(msg, t("Test email sent to {addr}.", { addr: to }), "ok");
    } catch (e) { showMsg(msg, t("Network error"), "error"); }
  });
}
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
  if (!mods.length) { host.textContent = t("No optional modules on this server."); return; }
  host.classList.remove("muted");
  host.innerHTML = mods.map((m) => `
    <label class="setting-row" for="mod-${escapeHtml(m.key)}">
      <span class="setting-label">
        <strong>${escapeHtml(t(m.label))}</strong> <!-- i18n-dynamic: server-sent, declared in i18nServerStrings -->
        <span class="muted">${escapeHtml(t(m.desc))}</span> <!-- i18n-dynamic -->
      </span>
      <span class="toggle">
        <input type="checkbox" id="mod-${escapeHtml(m.key)}" data-mod="${escapeHtml(m.key)}" ${m.enabled ? "checked" : ""}>
        <span class="slider"></span>
      </span>
    </label>`).join("");

  host.querySelectorAll("input[data-mod]").forEach((cb) => cb.addEventListener("change", async () => {
    const key = cb.dataset.mod, on = cb.checked;
    cb.disabled = true;
    showMsg(msg, "Saving…", "");
    try {
      const r = await apiFetch("admin/server", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ module: key, enabled: on }),
      });
      if (!r.ok) throw new Error(await r.text());
      // The nav is built from whoami, so it only picks this up on the next page
      // load -- say so rather than leaving the operator wondering.
      showMsg(msg, on ? t("{module} module enabled. Reload to update the menu.", { module: key })
                 : t("{module} module disabled. Reload to update the menu.", { module: key }), "ok");
    } catch (e) {
      cb.checked = !on; // revert on failure
      showMsg(msg, "Could not save: " + (e.message || "error"), "error");
    } finally {
      cb.disabled = false;
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
// OAUTH_HELP drives the setup panel beside the provider cards. `id` is the
// provider id the redirect URL is built from, so each section shows exactly the
// URL that has to be registered on that provider's side. Google and GitHub have
// presets, so their endpoint values are filled in for the admin; Azure AD has
// none and is set up through "+ Custom", which is why it carries a value table.
const OAUTH_HELP = [
  {
    id: "github",
    title: "GitHub",
    steps: [
      "In GitHub, open *Settings → Developer settings → OAuth Apps* and choose *New OAuth App*.",
      "Fill in an application name and set *Homepage URL* to this server's address.",
      "Paste the redirect URL above into *Authorization callback URL*, then register the app.",
      "On the app page, copy the *Client ID*, then choose *Generate a new client secret* and copy that too — GitHub shows the secret only once.",
      "Back here, press *+ GitHub*, paste both values into the new card and press *Save changes*.",
    ],
    notes: [
      "The preset fills in the endpoints and asks for the `read:user` scope. It uses GitHub's `login` as the username because the email is null on profiles that keep it private.",
    ],
  },
  {
    id: "google",
    title: "Google",
    steps: [
      "In the *Google Cloud Console*, select an existing project or create one.",
      "Open *APIs & Services → OAuth consent screen* and complete it. Pick *External* unless every user is in your Workspace.",
      "Open *APIs & Services → Credentials* and choose *Create credentials → OAuth client ID*, application type *Web application*.",
      "Under *Authorized redirect URIs*, add the redirect URL above.",
      "Create the client, then copy the *Client ID* and *Client secret*.",
      "Back here, press *+ Google*, paste both values and press *Save changes*.",
    ],
    notes: [
      "While the consent screen is still in *Testing*, only the test users you list can sign in. Publish it once you are ready to let everyone in.",
    ],
  },
  {
    id: "azure",
    title: "Azure AD / Microsoft Entra ID",
    steps: [
      "In the *Microsoft Entra admin center*, open *App registrations → New registration*.",
      "Choose the supported account types. *Single tenant* is right unless you want people from other directories to sign in.",
      "Under *Redirect URI*, pick the platform *Web* and paste the redirect URL above, then register.",
      "From the app's *Overview*, copy the *Application (client) ID* and the *Directory (tenant) ID*.",
      "Open *Certificates & secrets → New client secret* and copy its *Value* — not the Secret ID, and it is only shown now.",
      "Back here, press *+ Custom* and fill the card in with the values below, using the client ID and secret you just copied.",
    ],
    values: [
      ["Provider id", "azure"],
      ["Authorization URL", "https://login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize"],
      ["Token URL", "https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token"],
      ["Userinfo URL", "https://graph.microsoft.com/oidc/userinfo"],
      ["Scopes", "openid email profile"],
      ["Username claim", "email"],
    ],
    notes: [
      "Replace `<tenant>` with the Directory (tenant) ID you copied, or use `organizations` to accept any work or school account.",
      "The provider id must stay `azure`, or the redirect URL above stops matching the one you registered.",
      "If your tenant does not populate `email`, point the userinfo URL at `https://graph.microsoft.com/v1.0/me` instead, add the `User.Read` scope and set the username claim to `userPrincipalName,mail`.",
    ],
  },
];
// The OAuth provider walkthroughs. Declared here so the extractor catalogs
// them: the render passes computed keys from the OAUTH_HELP table, and the
// sentences use the *emphasis* convention rather than embedded markup.
function i18nOAuthHelpStrings() {
  t("GitHub");
  t("In GitHub, open *Settings → Developer settings → OAuth Apps* and choose *New OAuth App*.");
  t("Fill in an application name and set *Homepage URL* to this server's address.");
  t("Paste the redirect URL above into *Authorization callback URL*, then register the app.");
  t("On the app page, copy the *Client ID*, then choose *Generate a new client secret* and copy that too — GitHub shows the secret only once.");
  t("Back here, press *+ GitHub*, paste both values into the new card and press *Save changes*.");
  t("The preset fills in the endpoints and asks for the `read:user` scope. It uses GitHub's `login` as the username because the email is null on profiles that keep it private.");
  t("Google");
  t("In the *Google Cloud Console*, select an existing project or create one.");
  t("Open *APIs & Services → OAuth consent screen* and complete it. Pick *External* unless every user is in your Workspace.");
  t("Open *APIs & Services → Credentials* and choose *Create credentials → OAuth client ID*, application type *Web application*.");
  t("Under *Authorized redirect URIs*, add the redirect URL above.");
  t("Create the client, then copy the *Client ID* and *Client secret*.");
  t("Back here, press *+ Google*, paste both values and press *Save changes*.");
  t("While the consent screen is still in *Testing*, only the test users you list can sign in. Publish it once you are ready to let everyone in.");
  t("Azure AD / Microsoft Entra ID");
  t("In the *Microsoft Entra admin center*, open *App registrations → New registration*.");
  t("Choose the supported account types. *Single tenant* is right unless you want people from other directories to sign in.");
  t("Under *Redirect URI*, pick the platform *Web* and paste the redirect URL above, then register.");
  t("From the app's *Overview*, copy the *Application (client) ID* and the *Directory (tenant) ID*.");
  t("Open *Certificates & secrets → New client secret* and copy its *Value* — not the Secret ID, and it is only shown now.");
  t("Back here, press *+ Custom* and fill the card in with the values below, using the client ID and secret you just copied.");
  t("Provider id");
  t("Authorization URL");
  t("Token URL");
  t("Userinfo URL");
  t("Scopes");
  t("Username claim");
  t("Replace `<tenant>` with the Directory (tenant) ID you copied, or use `organizations` to accept any work or school account.");
  t("The provider id must stay `azure`, or the redirect URL above stops matching the one you registered.");
  t("If your tenant does not populate `email`, point the userinfo URL at `https://graph.microsoft.com/v1.0/me` instead, add the `User.Read` scope and set the username claim to `userPrincipalName,mail`.");
  t("Values for the custom card"); t("Redirect URL for {provider}");
}
// renderOAuthHelp builds the setup panel. base is the server's callback base, so
// the URLs shown are the real ones for this deployment rather than a template.
function renderOAuthHelp(base) {
  const host = document.getElementById("oauth-help-body");
  if (!host) return;
  host.innerHTML = OAUTH_HELP.map((p) => {
    const url = `${base}/${p.id}`;
    const values = p.values ? `
      <p class="help-eg-label">${escapeHtml(t("Values for the custom card"))}</p>
      <table class="oh-vals"><tbody>
        ${p.values.map(([k, v]) => `<tr><th>${escapeHtml(tKey(k))}</th><td>${escapeHtml(v)}</td></tr>`).join("")}
      </tbody></table>` : "";
    const notes = (p.notes || []).map((n) => `<p class="help-note">${tEmph(n)}</p>`).join("");
    return `<details class="help-fold">
      <summary>${escapeHtml(p.title)}</summary>
      <div class="help-body">
        <div class="oh-redirect">
          <span class="oh-redirect-label">${escapeHtml(t("Redirect URL for {provider}", { provider: p.title }))}</span>
          <div class="oh-copy-row">
            <div class="oh-url">${escapeHtml(url)}</div>
            <button class="secondary btn-sm" type="button" data-copy="${escapeHtml(url)}">${escapeHtml(t("Copy"))}</button>
          </div>
        </div>
        <ol class="oh-steps">${p.steps.map((step) => `<li>${tEmph(step)}</li>`).join("")}</ol>
        ${values}
        ${notes}
      </div>
    </details>`;
  }).join("");

  host.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      toast(t("Redirect URL copied"), "ok");
    } catch (e) {
      toast(t("Could not copy — select the URL and copy it manually"), "error");
    }
  }));
}
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
    rm.type = "button"; rm.className = "link danger-btn"; rm.textContent = t("Remove");
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
    if (!r.ok) { showMsg(msg, t("Could not load OAuth settings"), "error"); return; }
    const d = await r.json();
    if (base) base.textContent = d.callback_base || "";
    renderOAuthHelp(d.callback_base || "");
    (d.providers || []).forEach(addCard);
    refreshEmpty();
  } catch (e) { showMsg(msg, t("Could not load OAuth settings"), "error"); return; }

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
      showMsg(msg, t("Saved. Enabled providers now appear on the login page."), "ok");
    } catch (e) { showMsg(msg, t("Network error"), "error"); }
  });
}

registerPage("servers-page", initServers);
registerPage("oauth-page", initOAuth);
