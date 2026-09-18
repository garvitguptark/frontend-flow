#!/usr/bin/env node
// drift.mjs - extract the design system that actually exists in a codebase.
// Zero deps. Run: node drift.mjs [dir] [--threshold=50] [--animations] [--selftest]

import { readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out',
  'coverage', 'vendor', '.cache', '.svelte-kit', '.nuxt', '.venv']);
const EXTS = new Set(['.css', '.scss', '.sass', '.less', '.js', '.jsx', '.ts',
  '.tsx', '.vue', '.svelte', '.html', '.astro', '.mdx']);
const SPACING_PROP = /(margin|padding|gap|inset|top|right|bottom|left|width|height|translate)/i;

/* ---------- color ---------- */

function hexToRgb(h) {
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map(c => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6);
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return { r: n >> 16 & 255, g: n >> 8 & 255, b: n & 255 };
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

// OKLCh -> sRGB (Ottosson). Tailwind v4 emits oklch() by default, so skipping this
// would miss most colors in any recent project.
function oklchToRgb(L, C, H) {
  const h = H * Math.PI / 180;
  const a = C * Math.cos(h), bb = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * bb;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * bb;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * bb;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  const [r, g, b] = lin.map(c => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  });
  return { r, g, b };
}

const toHex = ({ r, g, b }) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

// ponytail: redmean distance, not full OKLab. Good enough to spot near-duplicates;
// swap for a real perceptual space if clustering ever misgroups brand colors.
function dist(a, b) {
  const rm = (a.r + b.r) / 2, dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

// WCAG 2.1 relative luminance - exact. Accessibility is not the place to approximate.
function luminance({ r, g, b }) {
  const [R, G, B] = [r, g, b].map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function suggestName({ r, g, b }) {
  const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
  const l = (mx + mn) / 2, d = mx - mn;
  const s = mx === mn ? 0 : d / (1 - Math.abs(2 * l - 1) || 1);
  // steps run dark -> light, so a light color must land at the end of the array.
  const steps = [950, 900, 800, 700, 600, 500, 400, 300, 200, 100, 50];
  const step = steps[Math.min(10, Math.max(0, Math.floor(l * 11)))];
  // HSL saturation explodes near black and white, so gate on absolute chroma too -
  // without this, off-whites like #faf9f6 get named a hue.
  if (s < 0.12 || d < 0.05) return `neutral-${step}`;
  const [R, G, B] = [r / 255, g / 255, b / 255];
  let h = mx === R ? 60 * (((G - B) / d) % 6)
    : mx === G ? 60 * ((B - R) / d + 2)
      : 60 * ((R - G) / d + 4);
  h = ((h % 360) + 360) % 360;
  const hue = h < 15 || h >= 345 ? 'red' : h < 45 ? 'orange' : h < 70 ? 'yellow'
    : h < 165 ? 'green' : h < 200 ? 'teal' : h < 255 ? 'blue' : h < 290 ? 'purple' : 'pink';
  return `${hue}-${step}`;
}

/* ---------- scan ---------- */

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.has(extname(name)) && st.size < 2000000) out.push(p);
  }
  return out;
}

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

/* ---------- motion ---------- */

// Keyframe bodies nest braces, so match them by counting rather than by regex.
function extractKeyframes(src) {
  const out = [];
  const re = /@(?:-webkit-|-moz-)?keyframes\s+([\w-]+)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length - 1;
    let depth = 0, i = start;
    for (; i < src.length && i - start < 8000; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    if (depth !== 0) continue;
    out.push({ name: m[1], body: src.slice(start, i + 1) });
    re.lastIndex = i + 1;
  }
  return out;
}

function parseTiming(v) {
  const durations = [], easings = [];
  for (const d of v.matchAll(/(\d*\.?\d+)(ms|s)\b/g)) {
    const ms = Math.round(parseFloat(d[1]) * (d[2] === 's' ? 1000 : 1));
    if (ms > 0 && ms <= 60000) durations.push(ms);
  }
  for (const e of v.matchAll(/cubic-bezier\(\s*([^)]+)\)/gi)) {
    easings.push(`cubic-bezier(${e[1].replace(/\s+/g, '')})`);
  }
  for (const e of v.matchAll(/steps\(\s*([^)]+)\)/gi)) easings.push(`steps(${e[1].replace(/\s+/g, '')})`);
  for (const e of v.matchAll(/\b(ease-in-out|ease-in|ease-out|ease|linear|step-start|step-end)\b/gi)) {
    easings.push(e[1].toLowerCase());
  }
  return { durations, easings };
}

// Generated names (grid-dot-0-0, grid-dot-0-1, ...) are one logical effect, not 100.
// Collapsing digit runs groups them so a decorative grid can't outvote real interaction motion.
const family = name => name.replace(/\d+/g, '#');

// Resolve var(--x) against the custom properties declared anywhere in the scanned
// fileset. Without this, `transition: color var(--t) ease` is invisible to the duration
// parser — so a build that tokenises its own motion, which is the good practice, reports
// zero durations and looks like it has no interaction motion at all.
// ponytail: text substitution with a depth cap, not a CSS cascade. It does not know about
// scopes or media-query overrides; see the first-wins note where varDefs is built.
function resolveVars(str, varDefs, depth = 0) {
  if (!varDefs?.size || depth > 4 || !str.includes('var(')) return str;
  const out = str.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g,
    (whole, name, fallback) => varDefs.get(name) ?? (fallback !== undefined ? fallback.trim() : whole));
  return out === str ? out : resolveVars(out, varDefs, depth + 1);
}

function motionProfile({ keyframeDefs, animDecls, transDecls, varDefs }) {
  const transitions = { durations: new Map(), easings: new Map(), n: 0 };
  for (const raw of transDecls) {
    const v = resolveVars(raw, varDefs);
    const { durations, easings } = parseTiming(v);
    transitions.n++;
    for (const d of durations) bump(transitions.durations, d);
    for (const e of easings) bump(transitions.easings, e);
  }

  const names = [...keyframeDefs.keys()];
  const fams = new Map(); // family -> {names:Set, uses, durations:Set, easings:Set}
  const get = f => {
    if (!fams.has(f)) fams.set(f, { names: new Set(), uses: 0, durations: new Set(), easings: new Set() });
    return fams.get(f);
  };
  for (const n of names) get(family(n)).names.add(n);

  for (const rawAnim of animDecls) {
    const v = resolveVars(rawAnim, varDefs);
    const hit = names.find(n => new RegExp(`(^|[\\s,])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s,]|$)`).test(v));
    const f = get(hit ? family(hit) : '(unnamed)');
    f.uses++;
    const { durations, easings } = parseTiming(v);
    for (const d of durations) f.durations.add(d);
    for (const e of easings) f.easings.add(e);
  }
  return { transitions, families: [...fams.entries()].map(([k, v]) => ({ key: k, ...v })) };
}

function scan(files) {
  const colors = new Map(), spacing = new Map(), fonts = new Map(),
    radii = new Map(), shadows = new Map(), keyframeDefs = new Map();
  const animDecls = [], transDecls = [];
  // Utility-class usage. On a Tailwind codebase the design system is not in CSS
  // declarations at all, so without these the report describes only the escape
  // hatches and confidently understates everything else.
  const utilRadius = new Map(), utilSpace = new Map(), utilMotion = new Map();
  const tokenDefs = new Map(), varRefs = new Map(), classRefs = new Map();
  // Every custom property, not just colours — timings, radii and shadows are routinely
  // tokenised too. **First definition wins**, deliberately: a `:root` block normally comes
  // before its overrides, and a later `@media (prefers-reduced-motion)` setting a duration
  // to `0s` would otherwise poison the map and report the whole site as having no motion.
  const varDefs = new Map();
  let reducedMotion = 0;

  for (const f of files) {
    let src;
    try { src = readFileSync(f, 'utf8'); } catch { continue; }

    // Strip /* */ comments before extracting anything. A codebase that documents a drift
    // fix ("/* replaces #9a9a94 - was 2.78:1 */") was otherwise re-reported as still
    // using the colour it had just removed. Only block comments: `//` is left alone
    // because it appears in every url(https://...). Replaced with a space, not "", so
    // `a/*x*/b` doesn't become one token.
    src = src.replace(/\/\*[\s\S]*?\*\//g, ' ');

    if (/prefers-reduced-motion/.test(src)) reducedMotion++;
    for (const k of extractKeyframes(src)) {
      if (!keyframeDefs.has(k.name)) keyframeDefs.set(k.name, k.body);
    }
    // Transitions are interaction feel; keyframe animations are effects. Keep them apart -
    // a page full of decorative looping animation says nothing about how its buttons feel.
    for (const m of src.matchAll(/transition(?:-duration|-timing-function)?\s*:\s*([^;{}\n]+)/gi)) {
      if (transDecls.length < 20000) transDecls.push(m[1]);
    }
    for (const m of src.matchAll(/animation(?:-duration|-timing-function|-name)?\s*:\s*([^;{}\n]+)/gi)) {
      if (animDecls.length < 20000) animDecls.push(m[1]);
    }

    // Colour tokens the project itself declares — `--color-ink: #1C1A16` in a Tailwind
    // `@theme`, or anything on `:root`. Drift is the gap between what is declared and
    // what is used, and counting values alone can only see one side of it.
    for (const m of src.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\))/g)) {
      const raw = m[2];
      let rgb = null;
      if (raw[0] === '#') rgb = hexToRgb(raw.slice(1).toLowerCase());
      else {
        const p = raw.match(/(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
        if (p) rgb = { r: +p[1], g: +p[2], b: +p[3] };
      }
      // --tw-* are Tailwind's internal plumbing, not anybody's design token.
      if (rgb && !m[1].startsWith('tw-')) tokenDefs.set(`--${m[1]}`, toHex(rgb));
    }

    // How tokens are actually consumed. Counting literal hex occurrences alone reports
    // a token used fifteen times through var() as "never applied", which is worse than
    // saying nothing. Two consumption routes, both counted:
    //   var(--fg-dim)                       plain CSS
    //   text-ink, bg-cream/60, border-ink   Tailwind v4, where @theme makes utilities
    for (const m of src.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
      const v = m[2].trim();
      if (v && !varDefs.has(m[1])) varDefs.set(m[1], v);
    }
    for (const m of src.matchAll(/var\(\s*(--[\w-]+)/g)) bump(varRefs, m[1]);
    for (const m of src.matchAll(/\b(?:bg|text|border|ring|fill|stroke|from|via|to|outline|placeholder|divide|accent|caret|decoration|shadow)-([a-z][\w-]*)/g)) {
      bump(classRefs, m[1]);
    }

    for (const m of src.matchAll(/#([0-9a-fA-F]{3,8})\b/g)) {
      const rgb = hexToRgb(m[1].toLowerCase());
      if (rgb) bump(colors, toHex(rgb));
    }
    for (const m of src.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/gi)) {
      bump(colors, toHex({ r: +m[1], g: +m[2], b: +m[3] }));
    }
    for (const m of src.matchAll(/hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/gi)) {
      bump(colors, toHex(hslToRgb(+m[1], +m[2], +m[3])));
    }
    for (const m of src.matchAll(/oklch\(\s*([\d.]+)(%?)[\s,]+([\d.]+)(%?)[\s,]+([\d.]+)/gi)) {
      const L = m[2] ? +m[1] / 100 : +m[1];
      const C = m[4] ? +m[3] / 100 * 0.4 : +m[3];
      if (L <= 1 && C <= 0.5) bump(colors, toHex(oklchToRgb(L, C, +m[5])));
    }
    for (const m of src.matchAll(/([a-zA-Z-]+)\s*:\s*([^;{}\n]*?\d[^;{}\n]*)/g)) {
      if (!SPACING_PROP.test(m[1])) continue;
      for (const v of m[2].matchAll(/(\d+(?:\.\d+)?)px/g)) bump(spacing, +v[1]);
    }
    for (const m of src.matchAll(/-\[(\d+(?:\.\d+)?)px\]/g)) bump(spacing, +m[1]);
    // The `]` in these negated classes is load-bearing. Tailwind's arbitrary-property
    // syntax puts real declarations inside class attributes — `class="[box-shadow:X]
    // transition-colors hover:bg-..."` — and we scan the HTML as well as the CSS.
    // Without `]` the capture runs past the closing bracket and swallows the rest of
    // the class list, so SHADOW fills up with Tailwind class soup instead of values.
    for (const m of src.matchAll(/font-?[Ff]amily\s*:\s*['"]?([^;}'"\n\]]+)/g)) {
      bump(fonts, m[1].trim().replace(/!important/g, '').trim().replace(/\s+/g, ' ').slice(0, 60));
    }
    for (const m of src.matchAll(/border-?[Rr]adius\s*:\s*['"]?([^;}'"\n\]]+)/g)) {
      bump(radii, m[1].trim().replace(/!important/g, '').trim());
    }
    for (const m of src.matchAll(/box-?[Ss]hadow\s*:\s*['"]?([^;}'"\n\]]+)/g)) {
      const v = m[1].trim().replace(/!important/g, '').trim();
      if (v !== 'none' && v !== '') bump(shadows, v.replace(/\s+/g, ' ').slice(0, 70));
    }

    // Utility classes. All three patterns require a hyphen-plus-suffix, and the
    // motion one refuses a following colon, so real CSS declarations
    // (`transition-property:`) are not counted as utilities.
    for (const m of src.matchAll(/\brounded-[a-z0-9]+\b/g)) bump(utilRadius, m[0]);
    for (const m of src.matchAll(/\b(?:[pm][xytblrse]?|gap(?:-[xy])?|space-[xy])-\d+(?:\.\d+)?\b/g)) bump(utilSpace, m[0]);
    for (const m of src.matchAll(/\btransition-[a-z]+\b(?!\s*:)|\bduration-\d+\b/g)) bump(utilMotion, m[0]);
  }
  return { colors, spacing, fonts, radii, shadows, keyframeDefs, animDecls, transDecls, reducedMotion,
    utilRadius, utilSpace, utilMotion, tokenDefs, varRefs, classRefs, varDefs };
}

function cluster(colors, threshold) {
  const sorted = [...colors.entries()].sort((a, b) => b[1] - a[1]);
  const out = [];
  for (const [hex, n] of sorted) {
    const rgb = hexToRgb(hex.slice(1));
    const hit = out.find(c => dist(c.rgb, rgb) < threshold);
    if (hit) { hit.members.push(hex); hit.n += n; }
    else out.push({ rgb, hex, members: [hex], n });
  }
  return out;
}

/* ---------- report ---------- */

function report(data, threshold, fileCount) {
  const { colors, spacing, fonts, reducedMotion, varDefs } = data;
  // Radii and shadows get the same var() resolution as timings. A tokenised design system
  // otherwise reports its own indirection back at you — `var(--geist-radius)` as if it
  // were a value — and collapses distinct entries that resolve to the same thing.
  const deref = (m) => {
    const out = new Map();
    for (const [k, n] of m) {
      const r = resolveVars(k, varDefs).trim();
      out.set(r, (out.get(r) ?? 0) + n);
    }
    return out;
  };
  const radii = deref(data.radii), shadows = deref(data.shadows);
  const L = [];
  const pad = s => String(s).padEnd(12);
  L.push(`Scanned ${fileCount} files.\n`);

  const cl = cluster(colors, threshold);
  L.push(`${pad('COLORS')}${colors.size} distinct -> ${cl.length} clusters`);
  const used = new Map();
  for (const c of cl.slice(0, 12)) {
    let name = suggestName(c.rgb);
    const seen = used.get(name) || 0;
    used.set(name, seen + 1);
    if (seen) name += `-${String.fromCharCode(97 + seen)}`; // two clusters can name alike
    const shown = c.members.slice(0, 5).join(' ');
    L.push(`${pad('')}${shown.padEnd(40)} -> --${name} (${c.n} uses)`);
  }
  if (cl.length > 12) L.push(`${pad('')}... ${cl.length - 12} more clusters`);
  const collapsible = cl.filter(c => c.members.length > 1).length;
  if (collapsible) L.push(`${pad('')}${collapsible} cluster(s) hold near-duplicate values.`);

  // Cross-reference clusters against the tokens the project already declares. A value
  // census says "five similar darks"; this says "--color-ink exists and four hardcoded
  // near-misses bypass it", which is the actual drift. It also catches the inverse
  // error: a cluster holding two real tokens must not be collapsed.
  const tokenDefs = data.tokenDefs ?? new Map();
  if (tokenDefs.size) {
    const byHex = new Map();
    for (const [name, hex] of tokenDefs) {
      if (!byHex.has(hex)) byHex.set(hex, []);
      byHex.get(hex).push(name);
    }
    const rows = [];
    let bypassed = 0, merged = 0, declaredOnly = 0;

    for (const c of cl) {
      const hits = c.members.filter(m => byHex.has(m));
      if (!hits.length) continue;

      if (hits.length > 1) {
        merged++;
        rows.push(`${pad('')}${hits.map(h => `${byHex.get(h)[0]} ${h}`).join('  +  ')}`);
        rows.push(`${pad('')}  ^ ${hits.length} declared tokens landed in one cluster - KEEP SEPARATE`);
        continue;
      }

      const hex = hits[0], name = byHex.get(hex)[0];
      // Real usage = var() references + Tailwind utility references + literal repeats of
      // the hex beyond its own declaration. Any one of those alone undercounts badly.
      const base = name.replace(/^--(?:color-)?/, '');
      const uses = (data.varRefs?.get(name) ?? 0)
        + (data.classRefs?.get(base) ?? 0)
        + Math.max(0, (colors.get(hex) ?? 0) - 1);
      const strays = c.members.filter(m => m !== hex);
      const label = name.length > 20 ? name.slice(0, 19) + '~' : name;

      if (strays.length) {
        bypassed++;
        const shown = strays.slice(0, 4).map(s => `${s}(${colors.get(s) ?? 0})`).join(' ');
        rows.push(`${pad('')}${label.padEnd(21)}${hex}  ${String(uses).padStart(4)}  bypassed by ${shown}`);
      } else if (uses === 0) {
        declaredOnly++;
        rows.push(`${pad('')}${label.padEnd(21)}${hex}  ${String(uses).padStart(4)}  declared, never referenced`);
      } else {
        rows.push(`${pad('')}${label.padEnd(21)}${hex}  ${String(uses).padStart(4)}  clean`);
      }
    }

    if (rows.length) {
      const head = [`${tokenDefs.size} colour token(s) declared`];
      if (bypassed) head.push(`${bypassed} bypassed`);
      if (merged) head.push(`${merged} cluster(s) merge two tokens`);
      if (declaredOnly) head.push(`${declaredOnly} unused`);
      L.push(`\n${pad('TOKENS')}${head.join('; ')}`);
      L.push(...rows.slice(0, 16));
      if (bypassed) L.push(`${pad('')}bypassed = the token exists; those values were typed instead of using it.`);
      if (merged) L.push(`${pad('')}Do not collapse a KEEP SEPARATE cluster - it is two intentional tokens.`);
    }
  }

  const vals = [...spacing.keys()].sort((a, b) => a - b);
  const off = vals.filter(v => v >= 4 && v % 4 !== 0);
  L.push(`\n${pad('SPACING')}${vals.length} distinct px values; ${off.length} off a 4px scale`);
  if (off.length) {
    L.push(`${pad('')}${off.slice(0, 12).map(v => `${v}px x${spacing.get(v)}`).join('  ')}`);
  }

  const topFonts = [...fonts.entries()].sort((a, b) => b[1] - a[1]);
  L.push(`\n${pad('TYPE')}${topFonts.length} distinct font-family declarations`);
  for (const [v, n] of topFonts.slice(0, 5)) L.push(`${pad('')}${v} (${n})`);

  const topRadii = [...radii.entries()].sort((a, b) => b[1] - a[1]);
  L.push(`\n${pad('RADIUS')}${topRadii.length} distinct`);
  if (topRadii.length) {
    L.push(`${pad('')}${topRadii.slice(0, 8).map(([v, n]) => `${v} x${n}`).join('  ')}`);
  }

  L.push(`\n${pad('SHADOW')}${shadows.size} distinct`);
  for (const [v, n] of [...shadows.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
    L.push(`${pad('')}${v} (${n})`);
  }

  // Utility-first codebases keep their design system in class names, not declarations.
  // Report that separately rather than letting the CSS sections imply it is absent.
  const sum = (m) => [...(m ?? new Map()).values()].reduce((a, b) => a + b, 0);
  const uRad = sum(data.utilRadius), uSpc = sum(data.utilSpace), uMot = sum(data.utilMotion);
  const utilityFirst = uRad + uSpc + uMot >= 20;

  if (utilityFirst) {
    const top = (m, n = 6) => [...(m ?? new Map()).entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, n).map(([v, c]) => `${v} x${c}`).join('  ');
    L.push(`\n${pad('UTILITIES')}${uRad + uSpc + uMot} utility classes - this repo is utility-first`);
    L.push(`${pad('')}NOTE: the sections above read CSS declarations only. On this repo the`);
    L.push(`${pad('')}design system lives in class names and a Tailwind theme, so treat those`);
    L.push(`${pad('')}counts as the escape hatches, not the scale.`);
    if (uRad) L.push(`${pad('radius')}${top(data.utilRadius)}`);
    if (uSpc) L.push(`${pad('spacing')}${top(data.utilSpace)}`);
    if (uMot) L.push(`${pad('motion')}${top(data.utilMotion)}`);
  }

  const { transitions: tr, families } = motionProfile(data);

  L.push(`\n${pad('TRANSITIONS')}${tr.n} declarations, ${tr.durations.size} distinct durations` +
    `${tr.n ? '' : (uMot
      ? ` - none in CSS, but ${uMot} in utility classes (see UTILITIES)`
      : ' - no interaction motion in CSS')}`);
  if (tr.durations.size) {
    const top = [...tr.durations.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    L.push(`${pad('')}${top.map(([v, n]) => `${v}ms x${n}`).join('  ')}`);
    const ms = [...tr.durations.entries()].flatMap(([v, n]) => Array(Math.min(n, 500)).fill(v)).sort((a, b) => a - b);
    L.push(`${pad('')}median ${ms[Math.floor(ms.length / 2)]}ms, range ${ms[0]}-${ms[ms.length - 1]}ms`);
    const te = [...tr.easings.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    L.push(`${pad('')}${te.map(([v, n]) => `${v} (${n})`).join('  ')}`);
  }

  const real = families.filter(f => f.key !== '(unnamed)');
  const kfTotal = real.reduce((a, f) => a + f.names.size, 0);
  L.push(`\n${pad('ANIMATIONS')}${kfTotal} @keyframes in ${real.length} families`);
  for (const f of real.sort((a, b) => b.uses - a.uses).slice(0, 8)) {
    const generated = f.names.size >= 5;
    const label = generated ? `${f.key} (${f.names.size} generated)` : [...f.names][0];
    const timing = [[...f.durations].sort((a, b) => a - b).map(d => `${d}ms`).join('/'),
    [...f.easings].slice(0, 2).join(' ')].filter(Boolean).join('  ');
    L.push(`${pad('')}${label.slice(0, 34).padEnd(35)}${String(f.uses).padStart(4)} uses  ${timing}` +
      (generated ? '   [decorative]' : ''));
  }
  if (real.some(f => f.names.size >= 5)) {
    L.push(`${pad('')}families marked [decorative] are generated per-element - they dominate`);
    L.push(`${pad('')}the raw counts but say nothing about how the interface feels.`);
  }
  L.push(`${pad('')}prefers-reduced-motion: ${reducedMotion ? `honoured in ${reducedMotion} file(s)` : 'NOT handled'}`);
  if (real.length) L.push(`${pad('')}run with --animations to print reusable @keyframes`);

  // ponytail: real fg/bg pairings are unknown, so each color is tested against the
  // most-used light and dark value. Only opposite-polarity pairs are considered -
  // light-on-light is a border or a surface, never text. Plausible failures, not confirmed.
  const byUse = cl.slice().sort((a, b) => b.n - a.n);
  const lightBg = byUse.find(c => luminance(c.rgb) > 0.6);
  const darkBg = byUse.find(c => luminance(c.rgb) < 0.15);
  const fails = [];
  for (const bg of [lightBg, darkBg].filter(Boolean)) {
    const bgIsLight = luminance(bg.rgb) > 0.5;
    for (const c of cl) {
      if (c === bg || c.n < 2) continue;
      if (bgIsLight === (luminance(c.rgb) > 0.5)) continue;
      const ratio = contrast(c.rgb, bg.rgb);
      if (ratio < 4.5) fails.push({ fg: c, bg, ratio });
    }
  }
  fails.sort((a, b) => a.ratio - b.ratio);
  L.push(`\n${pad('CONTRAST')}${fails.length} pair(s) below 4.5:1 (heuristic - pairings inferred)`);
  for (const f of fails.slice(0, 6)) {
    L.push(`${pad('')}${f.fg.hex} on ${f.bg.hex}  ${f.ratio.toFixed(2)}:1`);
  }

  return L.join('\n');
}

/* ---------- animation export ---------- */

function prettyBody(body) {
  const inner = body.slice(1, -1).trim();
  const out = [];
  for (const m of inner.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    const decls = m[2].split(';').map(s => s.trim()).filter(Boolean);
    if (sel) out.push(`  ${sel} { ${decls.join('; ')} }`);
  }
  return out.length ? out.join('\n') : '  ' + inner.slice(0, 400);
}

// The point of this mode: you saw an animation you liked, you want THAT animation -
// the keyframes plus the timing it's actually used with, ready to paste.
function animationsReport(data) {
  const { keyframeDefs } = data;
  const { families } = motionProfile(data);
  const real = families.filter(f => f.key !== '(unnamed)' && f.names.size);
  if (!real.length) return 'No @keyframes found. This site animates from JS, not CSS.';

  const L = [
    `${keyframeDefs.size} @keyframes found, grouped into ${real.length} families.`,
    '',
    'NOTE: this is someone else\'s CSS. Timing and easing values are about as close to',
    'uncopyrightable functional fact as CSS gets, but a distinctive signature animation',
    'may not be. Treat it as reference, not a transplant - you use it at your own risk.',
    '',
  ];
  for (const f of real.sort((a, b) => b.uses - a.uses).slice(0, 12)) {
    const name = [...f.names][0];
    const body = keyframeDefs.get(name);
    if (!body || body.length > 4000) continue;
    const dur = [...f.durations].sort((a, b) => a - b)[0];
    const ease = [...f.easings].find(e => e !== 'linear') || [...f.easings][0];
    const generated = f.names.size >= 5;

    L.push('-'.repeat(64));
    L.push(`${name}${generated ? `  [1 of ${f.names.size} generated variants - decorative]` : ''}`);
    L.push(`used ${f.uses}x${dur ? `, ${dur}ms` : ''}${ease ? `, ${ease}` : ''}\n`);
    L.push(`@keyframes ${name} {`);
    L.push(prettyBody(body));
    L.push('}');
    if (dur) {
      L.push(`.your-element { animation: ${name} ${dur}ms ${ease || 'ease'} both; }`);
    }
    L.push('');
  }
  L.push('Check each against prefers-reduced-motion before shipping.');
  return L.join('\n');
}

/* ---------- selftest ---------- */

function selftest() {
  const ok = (c, m) => { if (!c) throw new Error('FAIL: ' + m); };

  ok(toHex(hexToRgb('abc')) === '#aabbcc', 'shorthand hex expands');
  ok(toHex(hexToRgb('1a1a1aff')) === '#1a1a1a', '8-digit hex drops alpha');
  ok(hexToRgb('zz') === null, 'invalid hex rejected');
  ok(toHex(hslToRgb(0, 100, 50)) === '#ff0000', 'hsl red');
  ok(toHex(hslToRgb(210, 100, 50)) === '#0080ff', 'hsl blue');

  ok(toHex(oklchToRgb(1, 0, 0)) === '#ffffff', 'oklch L=1 is white');
  ok(toHex(oklchToRgb(0, 0, 0)) === '#000000', 'oklch L=0 is black');
  const okRed = oklchToRgb(0.6280, 0.2577, 29.23); // sRGB red in oklch
  ok(Math.abs(okRed.r - 255) <= 2 && okRed.g <= 3 && okRed.b <= 3, 'oklch round-trips sRGB red');
  const okMid = oklchToRgb(0.5, 0, 0);
  ok(Math.abs(okMid.r - okMid.g) <= 1 && Math.abs(okMid.g - okMid.b) <= 1, 'zero chroma stays neutral');

  const tmp3 = join(tmpdir(), `drift-selftest3-${process.pid}.css`);
  writeFileSync(tmp3, ':root{--a:oklch(1 0 0);--b:oklch(62.8% 0.2577 29.23);--c:oklch(0.5 0 0)}');
  const oc = scan([tmp3]);
  unlinkSync(tmp3);
  ok(oc.colors.has('#ffffff'), 'oklch parsed from css source');
  ok([...oc.colors.keys()].some(h => /^#f[a-f0-9]{5}$/.test(h) || h.startsWith('#ff')), 'percentage lightness handled');

  const tmp4 = join(tmpdir(), `drift-selftest4-${process.pid}.css`);
  writeFileSync(tmp4,
    '/* was #9a9a94, see #ff0000 */\nbody{color:#222222;background:#ffffff;padding:13px}\n' +
    '/* multi\n   line #00ff00 */\n.x{margin:7px}\n' +
    '.y{background:url(https://example.com/a.png)}\n');
  const cc = scan([tmp4]);
  unlinkSync(tmp4);
  ok(!cc.colors.has('#9a9a94'), 'colour in a block comment is ignored');
  ok(!cc.colors.has('#ff0000'), 'second colour in same comment ignored');
  ok(!cc.colors.has('#00ff00'), 'colour in a multi-line comment ignored');
  ok(cc.colors.has('#222222') && cc.colors.has('#ffffff'), 'real colours still found');
  ok(cc.spacing.has(13) && cc.spacing.has(7), 'spacing outside comments still found');

  const white = { r: 255, g: 255, b: 255 }, black = { r: 0, g: 0, b: 0 };
  ok(Math.abs(contrast(white, black) - 21) < 0.01, 'white on black is 21:1');
  ok(Math.abs(contrast(white, white) - 1) < 0.01, 'identical is 1:1');
  ok(contrast({ r: 136, g: 136, b: 136 }, { r: 245, g: 245, b: 245 }) < 4.5, '#888 on #f5f5f5 fails');

  ok(dist(hexToRgb('1a1a1a'), hexToRgb('1b1b1b')) < 50, 'near grays cluster');
  ok(dist(hexToRgb('333333'), hexToRgb('555555')) > 50, 'distinct grays stay apart');
  ok(dist(hexToRgb('f5f5f5'), hexToRgb('fafafa')) < 50, 'near whites cluster');

  const cl = cluster(new Map([['#1a1a1a', 5], ['#1b1b1b', 2], ['#ffffff', 9]]), 50);
  ok(cl.length === 2, 'three colors collapse to two clusters');
  ok(cl[0].hex === '#ffffff', 'most-used color seeds first cluster');
  ok(cl[1].members.length === 2, 'near-duplicate grays share a cluster');

  ok(suggestName(hexToRgb('1a1a1a')) === 'neutral-900', 'near-black is a high step');
  ok(suggestName(hexToRgb('f5f5f5')) === 'neutral-50', 'near-white is a low step');
  ok(suggestName(hexToRgb('faf9f6')).startsWith('neutral'), 'off-white is neutral, not a hue');
  ok(suggestName(hexToRgb('0070f3')).startsWith('blue'), 'brand blue named blue');
  ok(suggestName(hexToRgb('c8a84b')).startsWith('orange'), 'warm gold keeps its hue');

  const s = scan([]);
  ok(s.colors.size === 0, 'empty input yields empty scan');
  ok(s.keyframeDefs.size === 0 && s.animDecls.length === 0 && s.reducedMotion === 0,
    'empty input yields no motion');

  // motion parsing, against a temp file so the real regexes run
  const tmp = join(tmpdir(), `drift-selftest-${process.pid}.css`);
  writeFileSync(tmp, `
    .a { transition: opacity 150ms ease-out, transform .3s cubic-bezier(0.4, 0, 0.2, 1); }
    .b { animation: spin 2s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .a { transition: none; } }
  `);
  const m = scan([tmp]);
  unlinkSync(tmp);
  const p = motionProfile(m);
  ok(p.transitions.durations.get(150) === 1, 'ms transition duration parsed');
  ok(p.transitions.durations.get(300) === 1, 'fractional s converted to 300ms');
  ok(p.transitions.easings.get('cubic-bezier(0.4,0,0.2,1)') === 1, 'cubic-bezier normalised');
  ok(p.transitions.easings.get('ease-out') === 1, 'named easing captured');
  ok(!p.transitions.durations.has(2000), 'animation duration does not leak into transitions');
  ok(m.keyframeDefs.has('spin'), '@keyframes body captured');
  ok(/rotate\(360deg\)/.test(m.keyframeDefs.get('spin')), 'keyframe body includes its declarations');
  const spin = p.families.find(f => f.key === 'spin');
  ok(spin && spin.uses === 1 && spin.durations.has(2000), 'animation linked to its keyframe name');
  ok(m.reducedMotion === 1, 'prefers-reduced-motion detected');
  ok(/@keyframes spin/.test(animationsReport(m)), 'animations report emits reusable keyframes');

  // generated families collapse: 6 grid-dot-N-N names must count as one effect
  const tmp2 = join(tmpdir(), `drift-selftest2-${process.pid}.css`);
  writeFileSync(tmp2, Array.from({ length: 6 }, (_, i) =>
    `@keyframes grid-dot-0-${i}-up { to { opacity: 1; } }\n` +
    `.d${i} { animation: grid-dot-0-${i}-up 2800ms steps(1, end) infinite; }`).join('\n') +
    `\n@keyframes fade { to { opacity: 1; } }\n.f { animation: fade 200ms ease-out; }`);
  const g = motionProfile(scan([tmp2]));
  unlinkSync(tmp2);
  const famKeys = g.families.filter(f => f.key !== '(unnamed)').map(f => f.key);
  ok(famKeys.length === 2, 'six generated names collapse to one family beside fade');
  const grid = g.families.find(f => f.key.startsWith('grid-dot'));
  ok(grid.names.size === 6 && grid.uses === 6, 'family keeps its member and use counts');

  // Tailwind arbitrary properties live inside class attributes in the HTML we scan.
  // The value must stop at the closing bracket, or SHADOW/RADIUS/TYPE fill with class
  // soup. Regression guard for a bug found scanning vercel.com.
  const tmp5 = join(tmpdir(), `drift-selftest5-${process.pid}.html`);
  writeFileSync(tmp5,
    `<div class="[box-shadow:var(--ds-ring)] transition-colors hover:bg-gray-100 aria-[x]">a</div>\n` +
    `<div class="[border-radius:9px] flex items-center">b</div>\n` +
    `<style>.real{box-shadow:0 1px 2px rgba(0,0,0,.08);font-family:Inter!important}</style>`);
  const tw = scan([tmp5]);
  unlinkSync(tmp5);
  ok([...tw.shadows.keys()].includes('var(--ds-ring)'), 'tailwind arbitrary shadow stops at ]');
  ok(![...tw.shadows.keys()].some(v => v.includes('hover:')), 'no class soup captured as a shadow');
  ok([...tw.shadows.keys()].includes('0 1px 2px rgba(0,0,0,.08)'), 'real css shadow still read');
  ok([...tw.radii.keys()].includes('9px'), 'tailwind arbitrary radius stops at ]');
  ok([...tw.fonts.keys()].includes('Inter'), '!important stripped from font-family');

  // Utility-first detection. A Tailwind repo keeps its scale in class names, so a
  // report that only reads declarations understates it — and said "no interaction
  // motion in CSS" for a repo with 289 transition utilities. Found scanning AuraHR.
  const tmp6 = join(tmpdir(), `drift-selftest6-${process.pid}.tsx`);
  writeFileSync(tmp6, Array.from({ length: 12 }, (_, i) =>
    `<div className="rounded-xl p-4 gap-2 mb-6 transition-colors duration-300">${i}</div>`).join('\n'));
  const u = scan([tmp6]);
  const rep = report(u, 50, 1);
  unlinkSync(tmp6);
  ok(u.utilRadius.get('rounded-xl') === 12, 'utility radius counted');
  ok(u.utilSpace.get('p-4') === 12 && u.utilSpace.get('gap-2') === 12, 'utility spacing counted');
  ok(u.utilMotion.get('transition-colors') === 12, 'utility motion counted');
  ok(/UTILITIES/.test(rep), 'utility-first repo gets a UTILITIES section');
  ok(!/no interaction motion in CSS/.test(rep), 'no false "no motion" claim when utilities carry it');

  // ...and a plain-CSS file must NOT get the section
  const tmp7 = join(tmpdir(), `drift-selftest7-${process.pid}.css`);
  writeFileSync(tmp7, '.a{border-radius:8px;padding:16px;transition:color 200ms ease}');
  const plain = scan([tmp7]);
  const plainRep = report(plain, 50, 1);
  unlinkSync(tmp7);
  ok(!/UTILITIES/.test(plainRep), 'plain CSS repo gets no UTILITIES section');
  ok(!/transition-property/.test([...plain.utilMotion.keys()].join(',')), 'css declarations not counted as utilities');

  // Token cross-reference. The point of the section is the gap between declared and
  // used, so both halves are pinned: a token bypassed by a near-miss must be named as
  // bypassed, and a token consumed only through var()/utilities must NOT be called
  // unused — that false claim shipped once and is the reason this check exists.
  const tmp8 = join(tmpdir(), `drift-selftest8-${process.pid}.css`);
  writeFileSync(tmp8,
    `:root{--color-ink:#1c1a16;--color-cream:#faf7f2;--ghost:#445566}\n` +
    `.a{color:var(--color-ink)}.b{color:var(--color-ink)}\n` +
    `.c{color:#1c1d1b}.d{color:#1c1d1b}.e{color:#1c1d1b}\n`);
  const tk = scan([tmp8]);
  const tkRep = report(tk, 50, 1);
  unlinkSync(tmp8);
  ok(tk.tokenDefs.get('--color-ink') === '#1c1a16', 'token declaration parsed');
  ok(tk.varRefs.get('--color-ink') === 2, 'var() references counted');
  ok(/TOKENS/.test(tkRep), 'TOKENS section emitted when tokens are declared');
  ok(/--color-ink.*bypassed by #1c1d1b\(3\)/.test(tkRep), 'near-miss reported as bypassing its token');
  ok(!/--color-ink.*never referenced/.test(tkRep), 'var()-consumed token is not called unused');

  // Tailwind v4: `--color-x` is consumed as `text-x` / `bg-x/60`, never as var().
  const tmp9 = join(tmpdir(), `drift-selftest9-${process.pid}.tsx`);
  writeFileSync(tmp9,
    `<style>@theme{--color-sage:#5a7a5c}</style>\n` +
    `<div className="text-sage bg-sage/60 border-sage">x</div>`);
  const tw2 = scan([tmp9]);
  const tw2Rep = report(tw2, 50, 1);
  unlinkSync(tmp9);
  ok(tw2.classRefs.get('sage') === 3, 'tailwind utility references to a theme token counted');
  ok(!/never referenced/.test(tw2Rep), 'tailwind-consumed token is not called unused');

  // var() resolution. A build that tokenises its own motion reported zero durations
  // before this — the plugin under-reporting its own output, which is how it was found.
  const tmpA = join(tmpdir(), `drift-selftestA-${process.pid}.css`);
  writeFileSync(tmpA,
    `:root{--t:150ms;--ease:ease-out;--r:12px;--ring:0 0 0 2px #0070f3;--t2:var(--t)}\n` +
    `.a{transition:color var(--t) var(--ease)}\n` +
    `.b{transition:opacity var(--t2) ease}\n` +
    `.c{border-radius:var(--r)}\n` +
    `.d{box-shadow:var(--ring)}\n` +
    `.e{transition:transform var(--missing, 300ms) ease}\n`);
  const vr = scan([tmpA]);
  const vrRep = report(vr, 50, 1);
  const vrM = motionProfile(vr);
  unlinkSync(tmpA);
  ok(vr.varDefs.get('--t') === '150ms', 'custom property captured');
  ok(vrM.transitions.durations.get(150) === 2, 'var() timing resolved, including one chained var');
  ok(vrM.transitions.durations.get(300) === 1, 'var() fallback used when the name is undefined');
  ok(vrM.transitions.easings.has('ease-out'), 'var() easing resolved');
  ok(/RADIUS[\s\S]*12px/.test(vrRep) && !/RADIUS[\s\S]*var\(/.test(vrRep), 'radius deref\'d, no var() left');
  ok(/0 0 0 2px #0070f3/.test(vrRep), 'shadow deref\'d');

  // First-wins: a reduced-motion override must not zero out the whole report.
  const tmpB = join(tmpdir(), `drift-selftestB-${process.pid}.css`);
  writeFileSync(tmpB,
    `:root{--t:200ms}\n.a{transition:color var(--t) ease}\n` +
    `@media (prefers-reduced-motion:reduce){:root{--t:0s}}\n`);
  const fw = motionProfile(scan([tmpB]));
  unlinkSync(tmpB);
  ok(fw.transitions.durations.get(200) === 1, 'first definition wins over a media-query override');

  console.log('selftest: all checks passed');
}

/* ---------- main ---------- */

export { scan, report, animationsReport, motionProfile, walk };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const args = process.argv.slice(2);
if (!isMain) { /* imported as a module - skip the CLI */ }
else if (args.includes('--selftest')) { selftest(); process.exit(0); }
else {
  const threshold = Number(args.find(a => a.startsWith('--threshold='))?.split('=')[1] ?? 50);
  const dir = args.find(a => !a.startsWith('--')) ?? '.';
  const files = walk(dir);
  if (!files.length) {
    console.log(`No frontend source files found under ${dir}`);
  } else {
    const data = scan(files);
    console.log(args.includes('--animations') ? animationsReport(data) : report(data, threshold, files.length));
  }
}
