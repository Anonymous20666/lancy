# Lancy music v2 — implementation and verification

## Release boundary

Feature branch: `engineering/lancy-music-v2-20261020`, based on upstream `85ceca7`. The first implementation commit, `2972805dec90f43236be92a4731bc309f0daf649`, was pushed and its remote reference independently matched. Follow-up lifecycle/UI hardening and this evidence report are on the same scoped branch. The final delivery status records its latest exact commit.

The production checkout contains unrelated preexisting changes. They were **not** committed into the feature branch, reset, checked out over, or replaced. During the explicitly approved test window, only the identified Lancy service/bridge was paused; the original service was restored afterwards. A feature push is not a production deployment.

## Automated evidence

| Check | Latest result |
|---|---|
| Targeted Node feature/routing/lifecycle suite on VPS | **92 passed, 0 failed** |
| Python bridge suite on VPS | **18 passed, 0 failed** |
| Full VPS regression | **464 total: 461 passed, 1 failed, 2 cancelled**, 45562 ms |
| Installed-library / real FFmpeg probe | Neutral audio, bass audio, video+audio+bass, video seek offset and empty idle-stream conversion passed |
| Installed Python versions | py-tgcalls 3.0.0; ntgcalls 3.0.4; pyrogrammod 2.4.1; aiohttp 3.14.5; python-dotenv 1.2.4; TgCrypto 1.2.5 |
| Original preserved dirty-source baseline | 413 total: 401 passed, 9 failed, 3 cancelled |

**The full suite is not completely green.** Its remaining assertion is the preexisting `/setprefix` group-suggestions expectation in `channelPostAndPrefix.test.js`. Two preexisting files hit the 45-second file bound: `inlineSearchAndHotReload.test.js` and `liveSearchAndNoDuplicates.test.js`. All three identities also failed/timed out in the preserved baseline. Other legacy external-search/download assertions varied by environment and passed on the VPS; different-tree/environment totals are not a same-tree performance comparison.

Saved evidence: `targeted.log`, `python.log`, `full-regression.log`, `live-events.ndjson`, `live-results.json`, `operator-events.ndjson`, `live-node.log`, and `native-contract-probe.log`. The source archive is produced with `git archive`, excluding credentials, runtime data, dependencies and operator scripts.

## Genuine Telegram / native transport results

The approved group was resolved as `holysinnersgc`; the bot had required administrator/pin rights and its user-account playback session was a group administrator. Owner-private music home message 1834 was accepted by Telegram. The user session was checked at runtime, not assumed ready merely because an environment variable existed.

### Existing-call setup and preservation

The old bridge initially claimed one cached active call, but native `GetFullChannel` returned no call and both native call-active flags were false. The first test therefore aborted and restored the original service rather than silently creating a call. After explicit separate user authorization, an operator-only script created **one** diagnostic voice chat. This setup script is not a bot feature, is outside the source branch, and does not enable automatic call creation.

Before launching the test build, native checks confirmed that call existed. Its exact identity remained unchanged after the original bridge exited. The test build joined it with `GroupCallConfig(auto_start=False)`.

After the test build left, a new independent native probe confirmed:
- The **same** call still existed (`original_call_preserved: true`).
- The playback account still belonged to the group as an administrator.
- Lancy had not discarded the call or left the group.
- PM2 confirmed the original `lancy-bot` service online again.

### Live checks that passed

| Live check | Observed evidence |
|---|---|
| Join an existing call | Native play accepted; destination status playing; player message 7776 created |
| Native time units/progress | Real native clock advanced from 3 to 5 seconds |
| Pause | Native paused state with stable clock across observations |
| Resume, volume and seek | Resumed; volume 50 confirmed; native position 26 after seeking to 25 |
| Skip and previous | Correct generated recording IDs selected on the same call |
| Persistent views | Queue, volume and player edited the same player-message ID |
| Pinning | Telegram accepted pin and unpin of the test's own player panel |
| Video + audio | Native stream accepted with video=true and advancing position; listener synchronization was not independently verified |
| Natural completion | Four-second fixture advanced to the expected next recording once |
| Explicit leave and rejoin | Account lease became available; repeated leave was safe; rejoin succeeded |
| Real user interactions | Actual incoming Telegram callbacks and subsequent live playback were observed while the test build polled only the approved group/owner DM |
| Do not disconnect while playing | Connected/playing state remained true beyond the cancelled original idle deadline |
| Shutdown panel honesty | Follow-up code edits persistent panels to stopped; its rendered stopped panel was accepted by the real Telegram API |

Initial transport checks used quiet, generated, rights-cleared local media through the real queue/bridge/Telegram stack. They did not prove arbitrary third-party catalog availability. Later interactive playback produced canonical cached media and a live FFmpeg decoder; no raw query/callback bodies or account credentials were logged. The public Audius API also returned HTTP 200 with the adapter's actual User-Agent; a default urllib request returned 403, illustrating why API outcomes and request contracts must be checked rather than assumed.

## Idle test: exact honest result

The configured idle duration was **600 seconds**. The diagnostic started an empty connected idle period, then deliberately added playback to cancel that deadline, then began a second idle period 23 seconds later.

During observation, actual interactive playback was started. This correctly invalidated the empty-idle assumption. Structured samples remained `connected: true, status: playing` through 679 seconds of the test, including after the original cancelled 600-second deadline.

The fixed idle-only harness asserted that the session must still be `idle`; because it was legitimately **playing**, the harness stopped with `CANCELLED_DEADLINE_LEFT_EARLY` and child exit 1. That label is misleading in this situation: the recorded connection had **not** left early. The raw failure is preserved, not relabelled as a passing idle-leave test. The operator wrapper then restored production and verified the call/group were preserved.

Therefore:
- Actual new-work cancellation and not leaving while playback continues are supported by live evidence.
- An **uninterrupted real 600-second empty-idle departure remains unverified**. Offline timer/race tests pass; they are not a substitute for that clean live window.
- User-interactive exercise and a fixed no-interference idle assertion should be separate phases in the next diagnostic, rather than forcing a playing queue to stop just to manufacture a passing timer result.

The main owner was sent a clarification. Test-only panels were closed/marked finished so they would not falsely show ongoing test playback after restoration.

## Corrections driven by verification

1. Real installed-library decoding caught a bass-filter placement bug missed by mocks. PyTgCalls 3.0.0 needs `--audio ---mid` for audio-only post-input filters. Corrected commands actually decoded generated audio/video and seek-offset fixtures.
2. A definitive native `NotInCallError` now clears stale call metadata after idempotent departure confirmation and releases its lease. An ended call is not advertised as active merely because cached metadata remains. Generic uncertain failures still retain leases conservatively.
3. A failed initial volume confirmation no longer silently skips an otherwise started track; volume is shown unconfirmed and later reconciled.
4. Shutdown renders a stopped player rather than abandoning a fake playing card. Old mutation callbacks are rejected when a restarted session has no current panel; navigation can open the current player safely.

## Implemented scope

Canonical provider/recording identity; exact-source resolution; stream/download rights separation; `/play` download versus `/addq` audio queue and `/vplay` real requested video; multi-page selection and callback deduplication; destination-local queues/locks; exclusive account leases; stable-ID queue editing, repeat/history/skip/seek/volume; bounded cache/files/timeouts and shutdown; owner-private encrypted account pool with allowlists and real health checks; secure terminal onboarding; strict lyrics matching and rights-conscious display; serialized private AI/history and group AI isolation; persistent compact views, permission/rate checks and restrained controls.

Group general AI is off. Only plain play requests replying to this bot go directly into canonical download selection. Old chat OTP/password collection is retired in this branch. The current production service does not receive those source/security changes until a separate rollout is authorized.

## Remaining limitations and release gate

Not certified: uninterrupted 600-second idle leave, active channel-stream permissions/transport, two-account two-destination live concurrency, prolonged network recovery, 24–72 hour soak, mobile visual inspection, listener bass quality and audio/video synchronization. Single-account group checks and offline fakes do not establish these results.

Not implemented: durable automatic playback resumption after process restart; crossfade/beatmatching/DJ mixing; guaranteed unrestricted commercial-catalog downloads; automatic recreation of externally deleted dashboards. Old inactive records may expire; operational limits are documented in `MUSIC_OPERATIONS.md`.

No fixed 320 kbps call bitrate or improved source fidelity is promised. Audio is prepared as 48 kHz stereo with neutral default; gentle bass is an opt-in next-track filter with headroom/limiter.

A rollout must preserve the 22 tracked dirty production changes and 5 untracked entries, not replace production with clean upstream. Use consistent SQLite/key backups, a reviewed engineering-only overlay/merge, the actual supervisor and smoke tests. Only the approved test destination may be allowlisted automatically as part of approved setup; other destinations need owner approval. Production deployment requires separate authorization.
