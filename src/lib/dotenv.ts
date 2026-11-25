/**
 * Reads pasted .env text: NAME=value lines, with an optional "export " in front and the value optionally in
 * single or double quotes. Comments (#) and blank lines are skipped. Double-quoted values understand \n.
 */
export function parseDotEnv(text: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      // An unquoted value ends at a " #" comment.
      value = value.replace(/\s+#.*$/, "").trim();
    }
    const existing = out.findIndex((item) => item.name === match[1]);
    if (existing >= 0) out.splice(existing, 1);
    out.push({ name: match[1], value });
  }
  return out;
}
