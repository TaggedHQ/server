// impexp.js -- everything only the impexp page needs.
// core.js holds what every page shares and is loaded first; the
// registerPage call at the bottom hooks this into its page registry.

// Export writes all records to a downloadable CSV (filename entered by the user).
// Import parses pasted or dropped CSV/TSV data following the TimeTagger import
// format (https://timetagger.app/articles/importing/): tab/comma/semicolon are
// auto-detected, and the columns key/tags/start/stop/description/date/duration
// (with aliases) are recognized.

const IE_HEADER_ALIASES = {
  key: "key", id: "key", identifier: "key",
  tag: "tags", tags: "tags", project: "tags", pr: "tags", proj: "tags", "project name": "tags", projectname: "tags",
  start: "t1", begin: "t1", "start time": "t1", "begin time": "t1",
  stop: "t2", end: "t2", "stop time": "t2", "end time": "t2",
  description: "description", ds: "description", comment: "description", title: "description", summary: "description",
  date: "date",
  duration: "duration", "duration hh:mm": "duration", "duration hh:mm:ss": "duration",
};
const YEAR_EPOCH = 31536000; // used to tell a real timestamp from an hh:mm value
function fmtLocalDT(epoch) {
  const d = new Date(epoch * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
// --- Export ---
function exportDefaultName() { const d = new Date(); return `tagged-export-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`; }
function exportFilename() {
  let n = (document.getElementById("ie-filename").value || "").trim().replace(/[\/\\:*?"<>|]+/g, "").trim();
  if (!n) n = exportDefaultName();
  return n.replace(/\.(csv|tsv|txt)$/i, "") + ".csv";
}
function exportBuildRows() {
  const mode = document.getElementById("ie-format").value;
  const fdt = (e) => (mode === "unix" ? String(e) : mode === "iso" ? new Date(e * 1000).toISOString() : fmtLocalDT(e));
  const rows = [["key", "start", "stop", "tags", "description"]];
  for (const r of ALL.slice().sort((a, b) => a.t1 - b.t1)) {
    rows.push([r.key, fdt(r.t1), fdt(r.t2), allTagsOf(r.ds).join(" "), (r.ds || "").replace(/[\t\r\n]+/g, " ").trim()]);
  }
  return rows;
}
function ieExportMsg(text, ok) {
  const el = document.getElementById("ie-export-msg");
  el.textContent = text || "";
  el.classList.toggle("ok", !!ok);
}
function exportDownloadCSV() {
  const rows = exportBuildRows();
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  const name = exportFilename();
  downloadBlob(csv, name, "text/csv");
  ieExportMsg(`Saved ${name} · ${rows.length - 1} records`, true);
}
function exportCopyTable() {
  const rows = exportBuildRows();
  const tsv = rows.map((row) => row.join("\t")).join("\n");
  const done = () => ieExportMsg(`Copied ${rows.length - 1} records.`, true);
  const fail = () => ieExportMsg("Copy failed.", false);
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(tsv).then(done, fail);
  else fail();
}
// --- Import parsing ---
// parseDelimited turns CSV/TSV text into rows of fields, honoring double-quote
// wrapping ("" escapes an inner quote) and quoted newlines.
function parseDelimited(text, sep) {
  const rows = [];
  let row = [], field = "", inQ = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === sep) { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function detectSep(headerLine) {
  let best = null, bestN = 0;
  for (const s of ["\t", ",", ";"]) { const n = headerLine.split(s).length - 1; if (n > bestN) { bestN = n; best = s; } }
  return best;
}
function parseImportDate(d) {
  d = (d || "").trim().replace(/\./g, "-");
  const p = d.split("-");
  if (d.length === 10 && p.length === 3 && p[2].length === 4) return `${p[2]}-${p[1]}-${p[0]}`; // dd-mm-yyyy → yyyy-mm-dd
  return d;
}
function isTimeOnly(s) { return /^\d{1,2}[:.]\d{2}([:.]\d{2})?$/.test((s || "").trim()); }
function normalizeTimePart(s) {
  const p = (s || "").trim().replace(/\./g, ":").split(":");
  return `${pad(Number(p[0]))}:${pad(Number(p[1]))}:${pad(Number(p[2] || 0))}`;
}
function parseImportTime(s) {
  s = (s || "").trim();
  if (!s) return NaN;
  const num = Number(s);
  if (isFinite(num) && Math.abs(num) > YEAR_EPOCH) return Math.floor(num); // unix seconds
  const ms = Date.parse(s);
  return isFinite(ms) ? Math.floor(ms / 1000) : NaN;
}
function combineImportDateTime(dateStr, timeStr) {
  const ms = Date.parse(`${dateStr}T${normalizeTimePart(timeStr)}`);
  return isFinite(ms) ? Math.floor(ms / 1000) : NaN;
}
function parseImportDuration(s) {
  s = (s || "").trim();
  if (!s) return NaN;
  if (s.includes(":")) {
    const p = s.split(":").map(Number);
    if (p.length === 2) return p[0] * 3600 + p[1] * 60;
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  }
  const n = Number(s);
  return isFinite(n) ? n : NaN;
}
let IMP_RECORDS = [];
function importLog(html, cls, reset) {
  const el = document.getElementById("ie-log");
  if (reset) el.innerHTML = "";
  el.innerHTML += `<div class="${cls || ""}">${html}</div>`;
}
function importAnalyse() {
  IMP_RECORDS = [];
  const importBtn = document.getElementById("ie-import");
  importBtn.disabled = true;
  importBtn.textContent = "Import";

  const raw = document.getElementById("ie-input").value.replace(/^\s+/, "");
  const nl = raw.indexOf("\n");
  if (nl < 0) { importLog("No data to import.", "err", true); return; }
  const headerLine = raw.slice(0, nl).trim();
  const body = raw.slice(nl + 1);

  const sep = detectSep(headerLine);
  if (!sep) { importLog("Could not determine the separator (tried tab, comma, semicolon).", "err", true); return; }
  const sepName = sep === "\t" ? "tab" : sep === "," ? "comma" : "semicolon";
  importLog(`Separator looks like a ${sepName}.`, "", true);

  const headerFields = parseDelimited(headerLine, sep)[0] || [];
  const cols = [];
  const unknown = [];
  for (const name of headerFields) {
    const norm = name.toLowerCase().replace(/[-_]/g, " ").trim();
    if (norm in IE_HEADER_ALIASES) cols.push(IE_HEADER_ALIASES[norm]);
    else { if (norm) unknown.push(name); cols.push(null); }
  }
  importLog(unknown.length ? `Ignoring unrecognized columns: ${escapeHtml(unknown.join(", "))}` : "All column names recognized.");

  if (!cols.includes("t1")) { importLog("Missing a required <b>start</b> column.", "err"); return; }
  if (!cols.includes("t2") && !cols.includes("duration")) { importLog("Missing a required <b>stop</b> or <b>duration</b> column.", "err"); return; }

  const timemap = {};
  const existingKeys = new Set();
  for (const r of ALL) { timemap[`${r.t1}_${r.t2}`] = r.key; existingKeys.add(r.key); }

  const dataRows = parseDelimited(body, sep);
  const records = [];
  let newCount = 0;
  for (let ri = 0; ri < dataRows.length; ri++) {
    const fields = dataRows[ri];
    if (fields.join("").trim() === "") continue; // skip blank rows
    const rowNo = ri + 2; // 1-based incl. header

    const rawObj = {};
    for (let j = 0; j < Math.min(fields.length, cols.length); j++) {
      if (cols[j]) rawObj[cols[j]] = (fields[j] || "").trim();
    }
    const dateOk = rawObj.date ? parseImportDate(rawObj.date) : "";

    let t1 = parseImportTime(rawObj.t1);
    if (!isFinite(t1) && dateOk && isTimeOnly(rawObj.t1)) t1 = combineImportDateTime(dateOk, rawObj.t1);

    let t2 = parseImportTime(rawObj.t2);
    if (!isFinite(t2) && rawObj.duration) { const dur = parseImportDuration(rawObj.duration); if (isFinite(dur) && isFinite(t1)) t2 = t1 + dur; }
    if (!isFinite(t2) && dateOk && isTimeOnly(rawObj.t2)) t2 = combineImportDateTime(dateOk, rawObj.t2);

    if (!isFinite(t1) || !isFinite(t2)) { importLog(`Row ${rowNo}: could not parse the start/stop time — stopping.`, "err"); return; }
    t1 = Math.floor(t1); t2 = Math.max(Math.ceil(t2), t1 + 1);

    // Collect tags from the tags column and from any inline #tags in description.
    const tagKeys = [];
    if (rawObj.tags) for (const part of rawObj.tags.split(/[\s,]+/)) { const k = normalizeTag(part); if (k) tagKeys.push(k); }
    const descRaw = (rawObj.description || "").replace(/[\t\r\n]+/g, " ");
    for (const t of allTagsOf(descRaw)) tagKeys.push(t.slice(1).toLowerCase());
    const uniqTags = Array.from(new Set(tagKeys));
    const textOnly = descRaw.replace(RE_TAG_G, "").replace(/\s+/g, " ").trim();
    const ds = (uniqTags.map((t) => "#" + t).join(" ") + (textOnly ? " " + textOnly : "")).trim();

    let key = (rawObj.key || "").trim();
    if (!key) key = timemap[`${t1}_${t2}`] || randomKey();
    if (!existingKeys.has(key)) newCount++;

    records.push({ key, t1, t2, ds });
  }

  IMP_RECORDS = records;
  if (!records.length) { importLog("No records found.", "err"); return; }
  importLog(`Found <b>${records.length}</b> records (${newCount} new, ${records.length - newCount} updates).`, "ok");
  importBtn.disabled = false;
}
async function importDoImport() {
  if (!IMP_RECORDS.length) return;
  const importBtn = document.getElementById("ie-import");
  importBtn.disabled = true;
  importBtn.textContent = "Importing…";
  const now = Math.floor(Date.now() / 1000);
  const payload = IMP_RECORDS.map((r) => ({ key: r.key, mt: now, t1: r.t1, t2: r.t2, ds: r.ds }));
  try {
    const resp = await apiFetch("records", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!resp.ok) throw new Error("http " + resp.status);
    const res = await resp.json();
    const n = (res.accepted || payload).length;
    importLog(`Imported <b>${n}</b> records.`, "ok");
    importBtn.textContent = "Import done";
    IMP_RECORDS = [];
    await loadAll();
  } catch (e) {
    importLog("Import failed: " + escapeHtml(String(e && e.message || e)), "err");
    importBtn.textContent = "Import";
    importBtn.disabled = false;
  }
}
function readImportFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (["xls", "xlsx", "xlsm", "pdf"].includes(ext)) {
    importLog(`Cannot read <u>${escapeHtml(file.name)}</u>. Export it as CSV first, or paste the columns here.`, "err", true);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => { document.getElementById("ie-input").value = reader.result; importLog(`Loaded <u>${escapeHtml(file.name)}</u> — click Analyse.`, "", true); };
  reader.readAsText(file);
}
async function initImpExp() {
  await loadSettings();
  try { await loadAll(); } catch (e) { return; }
  document.getElementById("ie-filename").value = exportDefaultName();
  document.getElementById("ie-download").addEventListener("click", exportDownloadCSV);
  document.getElementById("ie-copy").addEventListener("click", exportCopyTable);

  const fileInput = document.getElementById("ie-file");
  document.getElementById("ie-drop-hint").addEventListener("click", (e) => { e.preventDefault(); fileInput.click(); });
  fileInput.addEventListener("change", () => { if (fileInput.files[0]) readImportFile(fileInput.files[0]); });

  const drop = document.getElementById("ie-drop");
  const ta = document.getElementById("ie-input");
  ["dragover", "dragenter"].forEach((ev) => ta.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "dragend"].forEach((ev) => ta.addEventListener(ev, () => drop.classList.remove("drag")));
  ta.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("drag"); const f = e.dataTransfer.files[0]; if (f) readImportFile(f); });

  document.getElementById("ie-analyse").addEventListener("click", importAnalyse);
  document.getElementById("ie-import").addEventListener("click", importDoImport);
}

registerPage("ie-input", initImpExp);
