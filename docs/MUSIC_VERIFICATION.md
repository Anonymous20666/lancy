# Lancy music v2 — verification report

## Release status

Implemented in an isolated feature worktree against upstream `85ceca7`, excluding the unrelated preexisting dirty VPS edits. Branch: `engineering/lancy-music-v2-20261020`. Commit/push verification is recorded in the final delivery status; this report does **not** assert a production deployment.

The user approved a controlled live test, with the original service restored afterwards. SSH access was restored using a user-installed restricted temporary public key; no password or private key was requested in chat. The server's ED25519 fingerprint was checked against the fingerprint supplied by the user before reconnecting.

## Latest verified evidence

| Check | Result |
|---|---|
| Clean-source targeted Node suite, executed on VPS | **89 passed, 0 failed** |
| Python bridge suite, executed on VPS | **18 passed, 0 failed** |
| Installed-library/FFmpeg contracts | **Pass**: neutral audio; bass audio; video+audio+bass; video seek offset; empty idle stream conversion |
| Installed Python pins | All six matched production: py-tgcalls 3.0.0, ntgcalls 3.0.4, pyrogrammod 2.4.1, aiohttp 3.14.5, python-dotenv 1.2.4, TgCrypto 1.2.5 |
| Real Telegram owner-private music home | **Accepted and sent**, message ID 1834; not merely a mocked API |
| Bot preflight | Valid main bot, approved test group resolves, bot has administrator/pin/manage-call rights; owner-private chat accessible |
| Actual playback account membership | **Administrator** in the approved test group, confirmed with read-only MTProto |
| Public Audius search | HTTP 200; availability, stream/download and gating fields inspected; no arbitrary commercial recording streamed |
| App composition/shutdown | Isolated temporary data root constructed and stopped successfully, without Telegram startup |
| Initial staging hygiene | 37 scoped files, no forbidden credential paths or token/private-key pattern hits; whitespace check passed |
| Preserved production source | 22 preexisting tracked changes and 5 untracked entries retained; no production checkout/reset/source replacement |
| Git push transport | Dry run authenticated successfully; no further Git credential required |

The final broad VPS run completed: **461 tests; 458 passed, 1 failed, 2 cancelled**, in 45495 ms. It is **not a completely green suite**. The sole assertion failure is the preexisting `/setprefix` group-suggestions expectation in `tests/channelPostAndPrefix.test.js`; two preexisting files hit the 45-second per-file bound: `inlineSearchAndHotReload.test.js` and `liveSearchAndNoDuplicates.test.js`. All three identities were also present in the preserved baseline.

The preserved original dirty-source baseline was **413 total: 401 passed, 9 failed, 3 cancelled**. A prior sandbox broad checkpoint had 459 total, 452 passed, 5 failed and 2 cancelled; its additional external media/adult-search/tray failures passed on the VPS. Different trees/environments and external-service outcomes mean these totals are not a same-tree performance comparison. The targeted feature suite and Python suite are independently green.

## Controlled live-test attempt: existing-call precondition correctly blocked

1. Created a consistent isolated SQLite backup, with protected permissions. No production database was replaced. The test build reused the pinned installed dependencies in a separate worktree; no package upgrades were applied to production.
2. Identified the actual supervisor as PM2 under `/data/pm2`, and only its `lancy-bot` service and exact old bridge PID were targeted. Unrelated services were untouched.
3. Installed an independent restoration guard before pausing the original service. The old bridge's health reported one active call.
4. After the old bridge exited, a **read-only native MTProto probe** found the account was an administrator but the group's `full_chat.call` was **absent**. Cached legacy bridge metadata was not proof of an active Telegram call.
5. The test refused to create a call or launch a competing player. It immediately restored the original `lancy-bot` service; PM2 confirmed it online afterwards.
6. No new audio/video test stream, player pin, or 600-second idle test was started. Only the earlier authorized owner-private home message was sent. The group was not left and no group call was discarded by the test.

**Minimal external action:** an administrator must start a voice chat in `holysinnersgc` and keep it open. Then the already-approved controlled test can join and leave that existing call. The diagnostic itself deliberately does not auto-create or replace a group/channel call.

The discovered stale legacy-call condition also prompted a regression correction in the new bridge: a definitive native `NotInCallError` is no longer reported as an active cached call. Idempotent departure is confirmed, its stale record/lease cleared, and Node retains the queue with an honest ended-call state. Generic uncertain failures still retain their lease rather than handing a possibly live account to another destination.

## Implemented and targeted-tested

- Canonical recording/provider identity; exact-source resolution; stream and download rights kept separate; no silent different-song fallback.
- `/play` download selection; `/addq` cross-page multi-selection; `/vplay` real requested video+audio; canonical standalone and current-track lyrics.
- Destination-local queues/locks and exclusive account leases; stable entry removal, repeat/history/skip; stale completion/callback deduplication; native-clock progress.
- Ten-minute default idle policy, cancellation/leave races, pause not idle, isolated shutdown and bounded queue/history/destination/media resources. One thousand repeat transitions are tested; this is not a multi-day soak.
- Owner-private encrypted account pool, explicit runtime health checks, allowlists, secure terminal helper, one-time migration without silent reimport, retirement of chat OTP/password collection.
- Persistent dashboard views, authorization/rate checks, panel creation mutex, selection isolation and pin preconditions.
- Strict title/artist/duration lyrics matching and ambiguity rejection, rights-conscious excerpts and opt-in player full text.
- Group AI disabled except literal play replies to this bot. DM serialization/history forwarding, accurate capability prompts and explicit outage/tool errors.
- Bounded native stream retries, uncertain-lease retention and parent-death cleanup attempts.

The installed-library media probe caught a real filter-placement error missed by mocks. PyTgCalls 3.0.0 uses `--audio ---mid` for audio-only post-input FFmpeg parameters. The corrected generated audio/video decoder commands actually exited successfully on generated fixtures. This verifies media preparation, not Telegram transport or listener synchronization.

## Still unverified / not implemented

**Not live-verified:** existing-call audio/video delivery, listener synchronization/quality, native progress under Telegram transport, pause/resume/seek/volume, actual 600-second leave and cancellation, mobile visual appearance, pinning, channel permissions, two-account live concurrency, prolonged network recovery, 24–72 hour soak.

**Not implemented:** durable automatic playback resumption after restart, crossfade/beatmatching/DJ mixing, unrestricted commercial-catalog availability, automatic recreation of externally deleted player dashboards. The operations guide states these limits; no nonstop-for-days guarantee is made.

A channel test needs a separately approved active channel stream. Live concurrency needs another independently authorized playback account/destination. Neither should be inferred from a single-group test or offline mocks.

## Continuation checklist

1. Recheck the test group for an actual existing call before pausing the original service again; discover current PIDs rather than reusing old ones.
2. Preserve the isolated data boundary and restoration guard. Never launch competing pollers/native players for the same token/session.
3. Test the actual existing-call identity before and after Lancy leaves; leave only the playback account, not the group/channel or the other participants' call.
4. Complete the real idle window, observe state/resource cleanup, and restore the original service for this test-only authorization. Prior in-memory queues may not resume.
5. Record exact live evidence and limitations, final regression result, feature commit/branch and verified push status. No deployment without its separate authorization.
6. Remove the specifically enrolled temporary SSH key from `authorized_keys` and delete its local private key when remote work is finished.
