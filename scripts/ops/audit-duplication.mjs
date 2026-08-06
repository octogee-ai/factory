import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "../.."));
const SKIP_DIRS = new Set([
  "node_modules", "dist", ".git", ".claude", "coverage", "build", ".next", "out", "tmp",
  "openclaw-tarball",
]);
const SRC_RE = /\.(ts|tsx|mjs)$/;
const ASTRO_RE = /\.astro$/;
const TEST_RE = /\.(spec|test)\.(ts|tsx)$/;
const LIB_RE = /(^|\/)(core\/src|lib|shared)\//;
const ENTRYPOINT_RE = /(^|\/)(index|main)\.(ts|tsx|mjs)$|(^|\/)(ops|entrypoints|bin|pages|actions)\//;

// Names below this many camelCase segments are conventional, not domain-specific:
// `main`, `run`, `isRecord` collide everywhere and mean nothing.
const MIN_SEGMENTS = 3;
const MIN_SPAN = 12;
const MIN_TEST_ONLY_SPAN = 25;
const SUFFIXES = ["Local", "Impl", "Internal", "Inner", "Helper", "V2", "2", "New", "Old", "Copy"];

const DEF_RE =
  /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[(<]|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?[(<]/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, out);
    } else if ((SRC_RE.test(e.name) || ASTRO_RE.test(e.name)) && !e.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");
const isTest = (f) => TEST_RE.test(f) || f.includes("/__tests__/");
const segments = (n) => n.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_]+/).length;
const word = (n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);

const all = walk(ROOT);
const tests = all.filter(isTest);
// Astro pages consume site/src/lib/* but declare nothing we parse.
const prod = all.filter((f) => !isTest(f));
const src = prod.filter((f) => !ASTRO_RE.test(f));

const text = new Map(prod.map((f) => [f, fs.readFileSync(f, "utf8")]));
const testText = tests.map((f) => fs.readFileSync(f, "utf8"));

const defs = new Map();
for (const f of src) {
  const lines = text.get(f).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = DEF_RE.exec(lines[i]);
    if (!m) continue;
    // Span runs to the next top-level definition. Measuring to the first
    // column-0 `}` scores a multi-line return-type annotation as the whole body.
    let end = i + 1;
    while (end < lines.length && !DEF_RE.test(lines[end])) end++;
    while (end > i + 1 && !lines[end - 1].trim()) end--;
    const name = m[1] ?? m[2];
    if (!defs.has(name)) defs.set(name, []);
    defs.get(name).push({ file: rel(f), line: i + 1, span: end - i, exported: lines[i].startsWith("export") });
  }
}

const section = (title, rows, render) => {
  console.log(`\n=== ${title} (${rows.length}) ===`);
  if (!rows.length) console.log("  (none)");
  for (const r of rows) console.log(render(r));
};

const byFile = (sites) => sites.filter((s, i, a) => a.findIndex((x) => x.file === s.file) === i);

const dupes = [...defs.entries()]
  .map(([name, sites]) => ({ name, sites: byFile(sites) }))
  .filter((d) => d.sites.length > 1 && segments(d.name) >= MIN_SEGMENTS)
  .map((d) => ({ ...d, span: Math.max(...d.sites.map((s) => s.span)) }))
  .filter((d) => d.span >= MIN_SPAN)
  .sort((a, b) => b.span - a.span);

section(
  `A. same name defined in ${">=2"} files`,
  dupes,
  (d) => `${String(d.span).padStart(4)}  ${d.name}\n${d.sites.map((s) => `        ${s.file}:${s.line}`).join("\n")}`,
);

const twins = [];
for (const [name, sites] of defs) {
  for (const suf of SUFFIXES) {
    if (!name.endsWith(suf) || name === suf) continue;
    const base = defs.get(name.slice(0, -suf.length));
    if (!base) continue;
    const here = [...new Set(sites.map((s) => s.file))];
    const there = [...new Set(base.map((s) => s.file))];
    if (here.length === 1 && here.some((f) => there.includes(f))) continue;
    twins.push({ name, here, base: name.slice(0, -suf.length), there });
  }
}
section("A2. suffix twins — a copy renamed so it can coexist with its original", twins,
  (t) => `  ${t.name}  [${t.here.join(", ")}]\n    vs ${t.base}  [${t.there.join(", ")}]`);

const isBarrel = (f) => {
  const t = text.get(f).trim();
  return /^\s*export \* from/m.test(t) && t.split("\n").every((l) => !l.trim() || l.startsWith("export *"));
};
const consumers = prod.filter((f) => !isBarrel(f));

const unconsumed = [];
for (const [name, sites] of defs) {
  for (const s of sites) {
    if (!s.exported || s.span < 4) continue;
    const w = word(name);
    if (consumers.some((c) => rel(c) !== s.file && w.test(text.get(c)))) continue;
    const selfUses = (text.get(path.join(ROOT, s.file)).match(new RegExp(w.source, "g")) ?? []).length;
    unconsumed.push({ name, ...s, inTests: testText.some((t) => w.test(t)), selfUsed: selfUses > 1 });
  }
}
unconsumed.sort((a, b) => b.span - a.span);

section("B1. exported, referenced by nothing anywhere",
  unconsumed.filter((d) => !d.inTests && !d.selfUsed),
  (d) => `${String(d.span).padStart(4)}  ${d.name}  ${d.file}:${d.line}`);

section(`B2. library export whose only consumer is a test (span >=${MIN_TEST_ONLY_SPAN}; advisory)`,
  unconsumed.filter((d) => d.inTests && LIB_RE.test(d.file) && d.span >= MIN_TEST_ONLY_SPAN),
  (d) => `${String(d.span).padStart(4)}  ${d.name}  ${d.file}:${d.line}`);

const deadModules = [];
for (const f of src) {
  const r = rel(f);
  if (ENTRYPOINT_RE.test(r) || !LIB_RE.test(r)) continue;
  const base = path.basename(f).replace(SRC_RE, "");
  const spec = new RegExp(`["'\`][^"'\`]*\\b${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.js|\\.ts)?["'\`]`);
  if (prod.some((c) => c !== f && spec.test(text.get(c)))) continue;
  deadModules.push({
    file: r,
    lines: (text.get(f).match(/\n/g) ?? []).length,
    specs: testText.filter((t) => spec.test(t)).length,
  });
}
deadModules.sort((a, b) => b.lines - a.lines);
section("C. library module no production code imports", deadModules,
  (d) => `${String(d.lines).padStart(5)}L  ${d.file}   [${d.specs ? `${d.specs} spec(s) import it` : "nothing imports it"}]`);
