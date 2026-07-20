// tags.js -- everything only the tags page needs.
// core.js holds what every page shares and is loaded first; the
// registerPage call at the bottom hooks this into its page registry.

const TAG_PRESETS = ["#DEAA22", "#E5484D", "#E9913C", "#3BA55D", "#2FB79E", "#4C82F7", "#5865F2", "#A66CFF", "#EB459E", "#8A8F98"];
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
    host.innerHTML = `<div class="empty">${escapeHtml(t("No tags yet — create one or add #tags to your entries."))}</div>`;
    return;
  }
  host.innerHTML = sorted.map((k) => {
    const color = colorFor(k);
    const st = stats[k];
    const usage = st
      ? `${tn("{n} entry", "{n} entries", st.count)} · ${fmtHM(st.sec)}`
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
  // Gated here as well as at render, so a bad value is never written back to
  // settings in the first place.
  tmColor = safeColor(hex, TAG_PRESETS[0]);
  const custom = document.getElementById("tm-custom");
  if (custom) custom.value = tmColor;
  renderTagSwatches();
}
function openTagModal(key) {
  tmEditKey = key || null;
  tmColor = key ? colorFor(key) : TAG_PRESETS[0];
  document.getElementById("tm-title").textContent = tmEditKey ? t("Edit tag") : t("New tag");
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
  if (!key) { tmError(t("Enter a tag name (letters, numbers, - or _; at least 2 characters).")); return; }

  const usage = tagUsage();
  const renaming = tmEditKey && key !== tmEditKey;
  if ((!tmEditKey || renaming) && (usage[key] || TAGINFO_RAW[key])) {
    tmError(t("A tag with that name already exists.")); return;
  }

  if (renaming) {
    const ok = await renameTag(tmEditKey, key, raw);
    if (!ok) { tmError(t("Failed to rename tag.")); return; }
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
  showMsg(document.getElementById("tags-msg"), tmEditKey ? t("Tag updated") : t("Tag created"), "ok");
  await loadAll();
  renderTags();
}
async function deleteTagModal() {
  if (!tmEditKey) return;
  const st = tagUsage()[tmEditKey];
  const warn = st
    ? t("It will be removed from {entries} (the entries themselves are kept).", { entries: tn("{n} entry", "{n} entries", st.count) })
    : "It is not used by any entry.";
  if (!(await confirmModal({ title: `Delete tag "${labelFor(tmEditKey)}"`, body: warn }))) return;

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

  if (!settings.length) { bulkLog(t("No valid tags found."), "err", invalid === 0); return; }

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

registerPage("tags-manage", initTags);
