# Accessibility — Manual Verification Checklist

Automated coverage: axe-core/jsdom scans on shell + all 5 platform views in
populated states — **0 violations (12 tests)**. Manual items below are
explicitly marked; jsdom cannot evaluate layout, color, or real AT behavior.

Legend: ✅ verified · 🔶 partially verified · ⬜ NOT TESTED (manual step pending)

| # | Route / area | Check | Expected | Result |
|---|---|---|---|---|
| 1 | All | Skip link | first Tab → "Skip to content" visible, Enter jumps to `#main-content` | 🔶 implemented + axe-verified; manual traversal pending |
| 2 | All | Landmarks | one `nav`, one `main`, no duplicates | ✅ axe + DOM assertions |
| 3 | All | Heading order | each view has exactly one `h1`, no skipped levels | ✅ axe scans |
| 4 | Nav | Keyboard | all 10 links reachable via Tab, Enter activates, active state announced (`aria-current`) | 🔶 implemented; full traversal pending |
| 5 | `/agent` | Preset control | segmented buttons operable via keyboard, selected state not color-only | 🔶 `aria-pressed` implemented; manual pending |
| 6 | `/agent` | Live progress | SR announces step transitions ONCE — not the whole growing trace | ✅ fixed: compact `role="status"` announces "Step N of M — detail"; trace list is static |
| 7 | `/agent` | Cancel | "Stop" button keyboard-operable, 409→disabled states have text | 🔶 implemented; manual pending |
| 8 | `/attack-graph` | Graph alternative | keyboard users reach every node via "All nodes" list; Node detail readable | ✅ added real `<button>` list (axe-clean); SVG nodes are mouse-only, `role="img"` + `aria-label` |
| 9 | `/attack-graph` | Chains | chain list is real buttons, severity text-visible (not color-only) | ✅ axe-verified (`Tag` includes text) |
| 10 | `/firewall` | Form labels | `#fw-tool`, `#fw-args`, `#fw-token` each have `<label for>` | ✅ tested |
| 11 | `/firewall` | Decision announcements | newest decision announced once | ✅ fixed: `role="status"` announces latest only |
| 12 | `/firewall` | Approvals | mint/copy buttons named; token input labeled | ✅ axe + label test |
| 13 | `/benchmarks` | Selects | env/suite selectors have accessible names | ✅ axe scan |
| 14 | `/defense-lab` | Selects | run A/B selectors have names (wrapping label or aria-label) | ✅ tested |
| 15 | `/findings` | Evidence drawer | dialog focus-trapped, Escape closes, focus restores | 🔶 Radix Dialog (built-in); manual verify pending |
| 16 | `/lab` | AI plan dialog | labeled, focus managed, error announced | 🔶 Radix + `aria-describedby`; manual pending |
| 17 | `/evaluation` | Charts | bar charts have text alternatives (values in DOM) | 🔶 values rendered as text; manual verify pending |
| 18 | All | Contrast | text ≥4.5:1, UI ≥3:1 on all states | ⬜ NOT TESTED — jsdom can't measure; needs manual/browser check |
| 19 | All | Focus visible | `:focus-visible` ring on every interactive element | 🔶 CSS rule exists; per-element manual pass pending |
| 20 | All | Zoom 200% / mobile | no clipping, no horizontal scroll at 375px | 🔶 responsive classes present; manual pending |
| 21 | All | Reduced motion | `prefers-reduced-motion` respected | ✅ CSS media block present; manual pending |
| 22 | All | Status not color-only | verdicts/statuses carry text labels | ✅ text badges throughout |
| 23 | All | Empty/error/loading | announced + non-color text | ✅ tested states; error text always present |

**Screen reader**: NOT TESTED — no AT in this environment; requires a manual
NVDA/VoiceOver pass before claiming WCAG conformance.
