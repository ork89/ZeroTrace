# ZeroTrace v1 Support Contract

This document defines the **explicit v1 scope** for foundation work.  
It is the implementation contract for remaining parser/runtime todos.

## v1 product boundaries

- **Compatibility target:** high EasyList/EasyPrivacy/Fanboy coverage for common rules, not full uBO parity.
- **Scriptlets:** curated built-in runtime only (no generic filter-list scriptlet execution).
- **Anti-anti-adblock:** site profiles + conservative heuristics, with reversible DOM changes.
- **Release targets:** Chrome Web Store + Edge Add-ons.
- **Must-pass behavior site:** `youtube.com`.

## Syntax support matrix (v1)

### Network filtering

| Area | Supported in v1 | Unsupported in v1 |
|---|---|---|
| Core rule forms | `||domain^`, `|http...`, `|left-anchored`, `/path`, structured plain substring tokens | Full regex rules and advanced forms requiring custom matcher engine |
| Actions | `block`, `allow` (exception rules) | Advanced actions (`redirect`, `modifyHeaders`, etc.) |
| Modifiers | resource-type mapping (`script`, `image`, `xhr`, etc.), `third-party`/`~third-party` + aliases (`3p`, `1p`), `domain=` include/exclude initiators, `match-case`, `important`, `all` | Non-DNR-compatible or currently unimplemented modifiers (`csp`, `removeparam`, `urltransform`, `badfilter`, etc.) |
| Priority behavior | Block > allow for parsed rules; explicit high-priority YouTube/ad-infra hard-block rules | Full parity with uBO precedence edge-cases |

### Cosmetic filtering

| Area | Supported in v1 | Unsupported in v1 |
|---|---|---|
| Cosmetic syntax | `##` and `#@#` with optional domain list; domain chunking for runtime loading | `#?#` procedural cosmetic syntax |
| Selector handling | Valid CSS selectors applied; invalid selectors skipped individually at runtime | Full procedural selector engine parity |

### Scriptlets / JS-side behavior

| Area | Supported in v1 | Unsupported in v1 |
|---|---|---|
| Filter-list scriptlets | `+js(...)` lines are parsed into scriptlet entries for build/runtime wiring | Generic execution of EasyList/uBO scriptlets from lists |
| Curated runtime scriptlets | Built-in anti-adblock shims (`adsLoaded`, `canRunAds`, `blockAdBlock`, `fuckAdBlock`) + YouTube main-world and DOM patches | Arbitrary scriptlet loader, dynamic remote scriptlet code |

## v1 non-goals

1. Full uBO syntax parity.
2. Full procedural cosmetic selector engine.
3. Generic filter-list scriptlet interpreter.
4. Aggressive anti-anti-adblock mutations on unprofiled sites.
5. Expanding store targets beyond Chrome + Edge for v1.

## Quality and release gates (must pass)

### Engineering gates

1. `npm run typecheck` passes.
2. `npm run test` passes.
3. `npm run build` passes and produces loadable `dist/` extension assets.

### Compatibility gates

1. EasyList parser regressions pass (supported syntax stays stable; intentionally unsupported lines remain skipped).
2. Cosmetic parser regressions pass (`+js(...)` recognized, selector/domain/exception parsing stable).
3. Per-site controls and ruleset toggle regressions pass.

### Behavior gates

1. `youtube.com` must pass manual validation:
   - no visible pre-roll/mid-roll ad playback in normal browsing flow,
   - promoted overlays/sidebar ad slots hidden,
   - no persistent breakage of core playback controls after ad events.
2. Anti-anti-adblock protections remain conservative:
   - host-scoped (profile/heuristic limited),
   - reversible mutations when feature toggles are off or host is bypassed.

## Store-target notes (Chrome vs Edge)

- **Package baseline:** maintain a single MV3 build artifact (`dist/`) that works in both stores.
- **Chrome Web Store:** stricter automated policy checks; keep permissions minimal and behavior declarations clear.
- **Edge Add-ons:** largely Chrome-compatible package flow, but separate listing/review process and timeline.
- **Release discipline:** ship same code baseline to both stores unless store-specific policy rejection forces a documented delta.

## Release runbook

- Use [`docs/release-checklist.md`](docs/release-checklist.md) for v1 release execution, QA sign-off, store submission, and rollback steps.

## Implementation rules for remaining todos

1. Do not widen scope beyond this matrix without explicit contract update.
2. For each newly supported syntax:
   - add parser/compiler behavior,
   - add regression fixtures for supported + intentionally unsupported examples,
   - add unsupported-reason instrumentation when skipping rules.
3. For each anti-anti-adblock profile:
   - scope by host pattern,
   - ensure reversible DOM mutations,
   - add targeted regression coverage where practical.
