// Text formatting for the terminal views and the dashboard: durations, ids, token counts, tables.

import path from "node:path";

export function formatElapsed(ms) {
  if (ms == null || Number.isNaN(ms)) return "-";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  // Past a day, the two largest units: days and hours, months (30 days) and days, years and months.
  const days = Math.floor(s / 86400);
  if (days < 30) return `${days}d${Math.floor((s % 86400) / 3600)}h`;
  if (days < 365) return `${Math.floor(days / 30)}mo${days % 30}d`;
  return `${Math.floor(days / 365)}y${Math.floor((days % 365) / 30)}mo`;
}

export function agoText(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  return m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function slug(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "run"
  );
}

// First informative line of a report: skips headings such as "## Findings" or "**Summary:**".
export function firstLine(text, width = 90) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const heading = (l) => /^#{1,6}\s/.test(l) || /^\*\*[^*]+\*\*:?$/.test(l) || (/:$/.test(l) && l.length < 40);
  const pick = lines.find((l) => !heading(l)) || lines[0];
  if (!pick) return "";
  const line = pick.replace(/^[#>*\-\s]+/, "").trim();
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
}

export function table(rows, columns) {
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const fmt = (r) => columns.map((c, i) => String(r[c] ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return [fmt(Object.fromEntries(columns.map((c) => [c, c.toUpperCase()]))), ...rows.map(fmt)].join("\n");
}

export function shortText(text, width = 60) {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
}

export function relPath(file, cwd) {
  if (!file) return "";
  const rel = cwd ? path.relative(cwd, file) : file;
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : path.basename(file);
}

export function unwrapShell(command) {
  const m = /^\S*?(?:ba|z)?sh -l?c '([\s\S]*)'$/.exec(String(command ?? "").trim());
  return m ? m[1].replace(/'\\''/g, "'") : String(command ?? "");
}

export function compact(n) {
  if (n == null) return "-";
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}
