// How much of a build's palette actually came from the reference site?
// Scores every colour a build uses against the reference's real CSS, using the same parser
// as /drift. Exact = ΔE ≤ 1 (identical to the eye), close = ΔE ≤ 5, anything else is invented.
// Pure white and black are left out: every site has them, so they prove nothing.
//
// Reproduce the README comparison:
//   1. Build twice from the same prompt, in two empty folders, one with the plugin and one
//      without (e.g. `claude -p "<prompt>" --disable-slash-commands` for the plain arm).
//   2. node scripts/reference.mjs https://stripe.com --keep   (prints where it kept the CSS)
//   3. node evals/fidelity/score.mjs <kept dir> ./plain ./with-plugin
import { statSync } from 'node:fs';
import { scan, walk } from '../../scripts/drift.mjs';

const files = p => statSync(p).isDirectory() ? walk(p) : [p];

// sRGB hex -> CIE Lab (D65); ΔE76 is plain Euclidean distance between two Lab points.
function lab(hex) {
  const n = parseInt(hex.slice(1, 7), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map(v => {
    v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const f = t => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
  const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
  const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const hex6 = h => /^#[0-9a-f]{6}/i.test(h) ? h.slice(0, 7).toLowerCase() : null;
const TRIVIAL = new Set(['#ffffff', '#000000']);

const [refDir, ...builds] = process.argv.slice(2);
if (!builds.length) {
  console.error('usage: node score.mjs <reference css dir> <build dir|file> [...]');
  process.exit(1);
}
const ref = [...scan(files(refDir)).colors.keys()].map(hex6).filter(Boolean).map(h => [h, lab(h)]);
console.log(`reference: ${ref.length} distinct colours`);

for (const b of builds) {
  const cols = [...new Set([...scan(files(b)).colors.keys()].map(hex6).filter(h => h && !TRIVIAL.has(h)))];
  let exact = 0, close = 0;
  const invented = [];
  for (const h of cols) {
    const best = Math.min(...ref.map(([, l]) => dE(lab(h), l)));
    if (best <= 1) exact++; else if (best <= 5) close++; else invented.push(h);
  }
  const pct = cols.length ? Math.round(100 * (exact + close) / cols.length) : 0;
  console.log(`${b}: ${pct}% from the reference (${cols.length} colours: ${exact} exact, ${close} close, ` +
    `${invented.length} invented${invented.length ? ` ${invented.join(' ')}` : ''})`);
}
