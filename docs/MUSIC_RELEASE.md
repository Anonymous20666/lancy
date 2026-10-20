# Official music release line — 20 October 2026

The owner authorized both synchronization of the repository default branch and production deployment on 20 October 2026. The release includes the channel/private-administrator and native publisher fixes tested at `3dfa313163a0ea0fa1d957c4bebc59db7aec35df`.

The installed-library decoder probe explicitly stubs the new network publisher-verification hook: that probe tests generated FFmpeg/MediaStream preparation only, never authorizes an account or joins Telegram. Actual transport and listener acceptance are recorded separately in [MUSIC_CHANNEL_VERIFICATION.md](MUSIC_CHANNEL_VERIFICATION.md).

## Deployment policy

- Do not overwrite the original production checkout or its pre-existing modifications. Stage a pinned release separately and reconcile the local production customizations there. Retain protected source/configuration snapshots, a consistent SQLite online backup and a separate encryption-key backup.
- Keep unrelated production customizations as a reviewed local overlay, not as unreviewed changes published to this repository. Preserve the original directory for rollback. The deployed overlay adds compatibility between the production Pinterest direct-search method and its existing action handler without reopening group AI.
- Reuse existing protected credentials and the existing data directory. The existing playback account may be migrated to encrypted storage; do not replace its credentials. Carry only the previously owner-approved group/channel destinations into its allowlist. A one-time approval migration must not silently re-enable destinations the owner later denies.
- Run one bot polling process and its owned authenticated loopback bridge. Verify old bridge exit before starting the new service. Arm an independent rollback guard until startup checks and a stability window have passed, then persist the supervisor configuration.
- Verify actual bot connectivity, public/admin/private command scopes, approved-account readiness, runtime path, process stability, original-source preservation and the existing broadcast. Do not auto-create a call or start unsolicited playback during deployment.

## Validation boundary

Core verification at the channel checkpoint: 193 focused Node tests and 27 Python bridge tests passed; core full regression had 520 total, 517 passed, one existing assertion failure and two timeouts. Human acceptance confirmed audible channel playback and working private reply/select/add.

The reconciled production candidate passes 194 focused tests, 27 Python bridge tests and all four installed-library decoder cases plus empty idle-stream conversion. Its bounded full suite has **522 total / 517 passed / three failed / two timed out**. All remaining failures/timeouts match previously observed production-baseline issues: the custom-prefix assertion, the production group's intentionally banner-free menu versus a banner test, the existing owner-identity override assertion, and the two hanging search test files. This is not represented as a completely green suite.

Activation/rollback outcomes, exact deployed/default-branch commit, process checks, source-overlay manifest and temporary-access revocation belong in the protected deployment receipt and the accompanying user-facing rollout report. The earlier verification documents retain their historical no-deployment boundary; they do not by themselves certify a later deployment.
