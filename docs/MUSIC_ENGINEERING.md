# Lancy music engineering record

## Scope and audit baseline — 2026-10-20

Repository: existing `lancy`, branch `main`, HEAD `85ceca7`. Production host `pappy-titan`. The working tree already had 22 modified tracked files and unfinished untracked `src/music`, music screen, Python bridge, and tests. Preserve all baseline modifications; do not stage them wholesale. A source-only snapshot was taken, excluding credentials, databases, cookies, user data and sessions. No production restart is authorized by this record.

### Actual dependency map

`src/index.js` loads `.env` → `LancyApp` (`src/app.js`) composes SQLite `Database`, `SettingsManager`, per-user persistent `StateMachine`, Telegram Bot API controller, screen registry, AI/WhatsApp/media services. The controller polls updates and dispatches commands before state input and AI. Rich-message builders and inline callback encoding are existing reusable components. Clones share the composition root but have separate Bot APIs. The existing media server binds loopback 3055; voice bridge binds 3056. Music is an existing Node → local HTTP → Python/PyTgCalls subsystem, not a new standalone bot.

`TelegramController` → music screen/orchestrator → canonical provider results → search-session selection → exact-source media cache → destination queue → `VoiceClient` → authenticated Python bridge → leased Pyrogram user client + PyTgCalls/NTgCalls → Telegram call. Bridge status (native media clock) and stream-completion reconciliation feed the queue → persistent rich player. Lyrics use canonical title/artist/duration. Account configuration uses the existing SQLite settings store; account sessions are AES-256-GCM encrypted separately from the filesystem key. Runtime queues, search panels and leases are intentionally ephemeral; playlists/preferences are durable.

### Confirmed baseline defects

* No destination transition lock; duplicate events can advance twice; manual skip obeys repeat-one incorrectly.
* Idle leave is 60 seconds; explicit stop immediately leaves; failure retry timers are uncancelled.
* Pause/resume/volume ignore backend `ok:false`; UI invents 3:30 duration and 320 kbps quality.
* One global Python client, no account leases, unauthenticated bridge/auth endpoints, no bounded webhook body.
* Auth can overwrite live `.env` session, logs phone numbers, accepts configured admins as global account owners.
* StreamEnded lacks generation; audio/video completion can double-advance. No native-clock progress, actual video flag, seeking, or shutdown of queues.
* Search/download fallback can substitute different recordings and label them with unrelated metadata; LRCLIB fallback accepts the first lyrics result.
* Group assistant accepts any reply as bot reply internally; non-command private/group state paths can cross chat boundaries.
* Existing tests largely verify shapes/mocks, not actual call audio/video or sustained operation.

### Reuse / boundaries

Keep ESM JavaScript, Node >=22.5, built-in `node:test`, SQLite, existing rich builders/API wrapper, screen callback namespace `music`, media permissions, composition root and logger. Do not alter unrelated sticker/Pinterest/NSFW/WhatsApp behavior. Do not introduce Redis. Python is necessary for the already-installed native call library.

## Requirements and acceptance specification

Priority P0 = correctness/security; P1 = usable first release; P2 = optional enhancement. Every row includes expected behavior, integration, dependencies, failure/security, and test evidence required. Implementation status is tracked separately in the final validation report, not inferred from this specification.

| ID / priority | Behavior and existing component / design | Dependencies and failure/security | Acceptance / tests |
|---|---|---|---|
| M01 P0 | Canonical immutable track identity shared by search, downloads, queue, player and lyrics; `src/music` orchestration replaces separate voice resolver | Provider ID must survive resolution; unknown metadata stays null; no fallback to unrelated recording | normalization, dedup and exact-ID resolver unit tests |
| M02 P1 | `/play query` downloads selected exact result, never queues; legacy generic `/download` retained | permitted provider, bounded file/time/duration, valid audio; restriction → actionable failure | command registration + selected download integration |
| M03 P1 | `/addq query` and no-query prompt, multi-select across bounded provider pages | server-side random search IDs, owner/chat/bot/message binding, TTL, 64-byte callbacks, no query in payload | pagination, cross-chat/user rejection, double-submit tests |
| M04 P0 | One queue and lock per destination; stable entry IDs, bounded queue and history | no single global player; no duplicate start; failed track does not repeat forever | simultaneous groups, repeated controls, failed transition tests |
| M05 P1 | Audio playback, pause/resume/skip/previous/stop/leave/volume/seek/repeat/shuffle/remove/clear | update state only after successful engine operation; seeking local finite files only | queue/control unit tests, bridge integration, live test required |
| M06 P1 | Genuine `/vplay` video+audio using MediaStream camera and microphone, not sendVideo | installed API signature verified; same local muxed source; required audio/video; bounded 360p/24fps pipeline | required-flag contract test + real visual/audible call verification |
| M07 P0 | Group and channel are distinct destination metadata, no automatic call creation | user account member; channel speaker/admin eligibility, active call, no broad promotion | preflight failure tests; separate live channel test |
| M08 P0 | Owner-only account registration/enable/disable/remove/allow/deny and health | trusted configured numeric owner IDs; no usernames or ordinary admin authority; local terminal registration only | permissions + encrypted store + restrictive file mode tests |
| M09 P0 | Exclusive account lease per active destination; allowed-account selector, one auto-select | runtime authorization check; do not assume unlimited account call concurrency; busy response | contested allocation, pool exhaustion, clean release |
| M10 P0 | Idle departure defaults 600 seconds after empty/stop; pause is not idle | generation checked under same destination lock; enqueue cancels timer; leave call not group | fake/short clock race, pause, explicit leave, shutdown tests |
| M11 P0 | Authenticated bounded loopback bridge; no secret logs, shell interpolation or arbitrary URLs | shared bridge token, encrypted account sessions, local cache path containment, exact supported provider URLs | auth, malformed input, SSRF/path and secret-redaction tests |
| M12 P1 | One persistent player message, in-place player/queue/lyrics view; pin only on successful authorized request | reuse RichMessageBuilder; separate API context for clones, no panel hijacking | rendered snapshots, callback-byte validation, message edit tests |
| M13 P1 | Playback position from native outgoing clock, not elapsed wall time; conservative updates | unavailable clock shows unavailable, bounded retry/flood backoff; paused position stable | clock/failure/UI tests; native unit convention verified from library source |
| M14 P1 | Strong title+artist+duration lyrics match, reject ambiguity; paginated display | LRCLIB documented API, Retry-After honored, attribution and optional display policy | unrelated/ambiguous/missing/long lyrics tests |
| M15 P0 | Safe bounded cache with dedup, quota, TTL, atomic partial files, active-resource references | no unbounded disk, local files only sent to voice; failed partial cleanup | concurrent resolve, storage cap, failed decode tests |
| M16 P0 | Shutdown blocks new operations, cancels timers, leaves calls, releases leases | preserve durable settings, queues intentionally reset; no fake recovered active players | multi-destination shutdown + process restart tests |
| M17 P0 | Group admins control destructive operations; members may search/add; owner manages global pool | live getChatMember fail closed; destination-approved sessions only; private owner controls for channels | role tests + stale callbacks + rate limits |
| M18 P1 | Bounded reconnect/retry on transient bridge failures; permanent source failure advances safely | no runaway loops, one destination cannot stop others; multi-day reliability requires soak evidence | failure isolation, bounded retry and soak procedure |
| M19 P0 | Group chat has no AI conversation; only plain `play …` replying to this bot delegates music | command handlers first; reply identity exact; no LLM for group music; chat-bound prompt state | other-bot/user reply, group mention, slash command, DM state regression |
| M20 P1 | Durable user playlists/settings reuse SQLite | bounded names/items, no credentials stored with playlists | save/load/delete and restart persistence |
| M21 P2 | Gentle bass preset with headroom/limiter rather than clipping or false quality claims | opt-in per destination, CPU cost measured; default neutral | FFmpeg filter probe + live listening / long soak |

## Architecture decisions

1. Preserve the Node orchestration/Python bridge boundary; pin the installed call-library versions, inspect actual APIs instead of mixing old GroupCallFactory examples.
2. Enforce one destination per account conservatively. Bridge is the authoritative account/lease owner; Node is the sole queue owner. Do not use expiring leases while a native call is still live. Process restart discards leases only after old bridge exits; an incompatible/occupied bridge is an explicit blocker, not silently hijacked.
3. Resolve media when each entry begins, using its immutable provider reference. Cache local files before playback; external untrusted URLs never enter FFmpeg. No silent catalog fallback. yt-dlp is an optional existing-tool adapter for owner-permitted material, not a rights bypass. No cookies imported or credentials passed through callback data.
4. Native completion is reconciled through authenticated status with a playback ID. Consume microphone audio completion only; do not treat camera completion as a second track. Native updates lacking source identity are corroborated by native clock before completion is accepted.
5. Stop halts the pipeline and clears queue, then remains connected idle for ten minutes; `/leave` exits immediately. Pause holds lease and does not trigger idle departure. Channel destination control occurs from an owner-private `/destination <numeric-id>` binding, never via forged callback destination data.
6. Session onboarding is a local interactive terminal workflow. No Telegram login-code/password collection in messages and no automatic production `.env` replacement.
7. No production rollout until tests and an explicitly authorized restart window. A successful mock is never evidence of a successful Telegram call.

## Verified capability sources

Inspected actual VPS installed Python signatures/source: py-tgcalls 3.0.0, ntgcalls 3.0.4, pyrogrammod 2.4.1 (legacy Pyrogram 2.0.106 distribution metadata also exists), aiohttp 3.14.5, python-dotenv 1.2.4. MediaStream has separate audio/video flags, FFmpeg parameters; GroupCallConfig supports auto_start; PyTgCalls has async `play`, `pause`, `resume`, `leave_call`, `change_volume_call`, `time`, no `stop`/`get_time`. AudioQuality.HIGH is 48 kHz stereo sample format, NOT 320 kbps call bitrate.

Authoritative references inspected: https://github.com/pytgcalls/pytgcalls and upstream `pytgcalls/types/stream/media_stream.py`; https://core.telegram.org/api/group-calls ; https://lrclib.net/docs ; https://docs.audius.co/api/ ; https://github.com/yt-dlp/yt-dlp . APIs do not prove real channel/video permission success. Source/provider restrictions and Telegram speaker rights must still be validated in the permitted live environment.

## Full-audio UI follow-up

`src/music/preview.js` manages canonical full-recording preview preparation, bounded bot-specific Telegram audio references, upload deduplication and stale-playback checks. Download permission is not inferred from a readable VC file. `MediaLibrary.acquire(download: true)` revalidates Audius creator consent before using its cache; complete audio-only files may then be shared safely without redundant conversion. The provider's full duration must be known for newly resolved full-file deliveries.

`QueueManager.cardLocks` serializes edits per destination, including first multipart audio upload; ordinary progress and navigation edits reuse Telegram `file_id`. Two background preview jobs plus two explicit delivery slots bound new upload work. Stopped or changed recordings cannot be revived by a late preview. `src/music/messages.js` records only API-returned bot messages, holds TTL while a submission runs, promotes durable audio/lyrics results out of cleanup, and performs bounded best-effort removal of temporary bot UI.

The rich music screen reuses the original downloader's `b.audio({media, title, performer, duration})` contract. The native Telegram audio player is a standalone listener/download option, not an invented VC progress or seek engine. The More view keeps less-frequent settings in the existing dashboard. Actual owner-DM rich upload/file-ID reuse/view edits/cleanup are recorded in MUSIC_VERIFICATION.md; this follow-up did not interrupt or deploy to production.
