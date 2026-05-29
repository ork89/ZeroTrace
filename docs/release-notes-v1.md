# ZeroTrace v1 Release Notes

## Version

- Release target: v1 (source version in `manifest.json`)
- Ship artifact: zipped `dist/` directory

## User-visible behavior changes

- Blocks common ad/tracker network requests covered by the v1 support contract.
- Applies cosmetic hiding for supported `##` / `#@#` rules on matching domains.
- Enables curated anti-adblock shims and YouTube-specific protections.
- Ships as a single MV3 build artifact for Chrome Web Store and Edge Add-ons.

## Known limitations

- No full uBO parity.
- No generic filter-list scriptlet execution.
- No procedural cosmetic selector engine (`#?#` remains unsupported).
- Advanced actions/modifiers outside the v1 matrix remain unsupported.

## Submission notes

| Store | Submission ID | Submission date | Status | Notes |
|---|---|---|---|---|
| Chrome Web Store | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| Edge Add-ons | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

## Release sign-off

- Build/test gates completed: Yes (CI `checks` workflow passed on `main` at 2026-05-22; runs include `npm run typecheck`, `npm test`, and `npm run build`)
- Manual QA completed: Yes (2026-05-22, Playwright-driven QA in clean profile with only ZeroTrace loaded; YouTube baseline/UI, cosmetic sanity, per-site pause/resume, and disable/re-enable fallback checks passed)
- Rollback contact / owner: _TBD_
