// about.js -- everything only the about page needs.
// core.js holds what every page shares and is loaded first; the
// registerPage call at the bottom hooks this into its page registry.

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

registerPage("about-content", initAbout);
