#!/usr/bin/env bash
# Builds a minimal utility-first project in the empty eval workspace.
#
# It is shaped to exercise the two things that were broken before they were fixed:
#   1. UTILITIES  - the design system lives in class names, so a scanner that reads only
#                   CSS declarations reports almost nothing and claims there is no motion.
#   2. TOKENS     - --color-ink is declared, and #1c1d1b is a hardcoded near-miss that
#                   bypasses it. Reporting the cluster without naming the bypass is the
#                   difference between a value census and a drift report.
set -euo pipefail

mkdir -p src/components

cat > src/index.css <<'CSS'
@import "tailwindcss";

@theme inline {
  --color-ink: #1c1a16;
  --color-cream: #faf7f2;
  --color-gold: #c8a84b;
}

:root {
  --background: #faf7f2;
}
CSS

# Utility-first components. Note the hardcoded #1c1d1b: a near-miss on --color-ink.
for i in 1 2 3 4; do
  cat > "src/components/Card${i}.jsx" <<JSX
export default function Card${i}() {
  return (
    <div className="rounded-xl p-4 gap-2 mb-6 bg-cream text-ink transition-colors duration-200 hover:bg-gold/10">
      <h2 className="rounded-full px-4 py-2 text-ink" style={{ color: "#1c1d1b" }}>Card ${i}</h2>
      <p className="rounded-lg p-4 gap-3 transition-all duration-300" style={{ borderColor: "#1c1d1b" }}>
        Body copy for card ${i}.
      </p>
    </div>
  );
}
JSX
done

cat > package.json <<'JSON'
{
  "name": "fixture-utility-first",
  "private": true,
  "devDependencies": { "tailwindcss": "^4.0.0" }
}
JSON
