# ZeroTrace v1 Release Checklist

Use this checklist for every v1 release candidate.

## 1) Pre-release checks (must pass)

### Build and test gates

- [ ] `npm run typecheck`
- [ ] `npm run test`
- [ ] `npm run build`
- [ ] Verify `dist/` loads in a local Chromium browser as an unpacked extension.

### Scope and packaging gates

- [ ] Confirm release stays within the v1 support contract in `README.md` (no new syntax/runtime scope expansion).
- [ ] Confirm `manifest.json` version is bumped for the release.
- [ ] Confirm release notes summarize user-visible behavior changes and known limitations.

## 2) Manual QA critical flows (release sign-off)

Run on a clean browser profile with only ZeroTrace enabled.

- [ ] **YouTube baseline:** open multiple videos and verify no visible pre-roll/mid-roll ads in normal playback flow.
- [ ] **YouTube UI integrity:** verify playback controls, seeking, quality changes, and full-screen still work after ad events.
- [ ] **Cosmetic filtering sanity:** verify promoted/sponsored blocks are hidden on common content pages.
- [ ] **Per-site controls:** toggle extension/site controls and verify behavior changes apply and revert as expected.
- [ ] **Fallback sanity:** disable/re-enable extension and verify page rendering returns to normal (no persistent mutation artifacts).

## 3) Store submission runbook (Chrome + Edge)

Use the same tested `dist/` artifact unless a store policy rejection forces a documented delta.

### Chrome Web Store

1. Zip the release artifact from `dist/`.
2. Upload in Chrome Web Store Developer Dashboard.
3. Update listing text/screenshots if behavior changed.
4. Submit for review and record submission ID/date in release notes.

### Edge Add-ons

1. Upload the same zip in Microsoft Partner Center (Edge Add-ons).
2. Update store listing metadata to match Chrome release messaging.
3. Submit for certification and record submission ID/date.

### Differences to track

- Chrome review is typically stricter on permission/policy interpretation.
- Edge has separate certification queue/timeline, even with the same package.
- Treat each store decision independently; log approvals/rejections separately.

## 4) Rollback strategy

### Triggers

- Severe regression in core browsing flow (e.g., playback breakage on YouTube).
- Policy/compliance issue flagged by store review.
- High-volume user reports after rollout.

### Actions

1. **Stop forward rollout:** pause/hold publication in both stores (or unpublish latest where supported).
2. **Revert to last known good package:** resubmit previous stable version to affected store(s).
3. **Runtime mitigation:** if available, disable problematic ruleset/profile by default in next hotfix.
4. **Communicate status:** post rollback note with impact, workaround, and ETA for corrected release.
5. **Postmortem + guardrail:** add regression test/QA case that would have caught the issue.

### Rollback completion criteria

- Previous stable version approved/live in affected store(s).
- Critical flow validation passes on stable version.
- Incident summary and follow-up tasks are tracked.
