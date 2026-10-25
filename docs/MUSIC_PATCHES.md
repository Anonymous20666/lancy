# Permission-first music patches — 20 October 2026

This patch supersedes the previous prohibition on automatic call creation **only for explicit, freshly verified administrator setup requests**. The owner approved on-demand assistant addition/promotion, group/channel call creation, and guarded deployment after testing. Ordinary playback, automatic queue advancement and recovery still use `GroupCallConfig(auto_start=False)`; they cannot silently create another call.

## Commands and menus

- `/vc` prepares an **audio voice chat**, not a video call. Verify caller administration and bot rights; resolve an owner-approved playback account; join it through a one-use bot invitation if absent; verify membership; grant only needed call-management administration when necessary; reuse an active call or explicitly create one. `/vc <query>` searches audio. Replying `/vc` to a video extracts audio.
- `/vidc <query>` selects actual video + audio. Reply `/vidc` to a video to stream it. Video catalog search requires the existing owner opt-in for permitted YouTube resolution; Audius remains audio-only.
- `/stream` replies to a Telegram song, voice message or video and adds that recording to the canonical destination queue. Audio remains audio; video retains video. No arbitrary download URL is accepted. Telegram cloud intake is limited to 20 MB and known-duration media up to two hours; conversion/cache limits also apply. Direct user files are decoded and probed before queue insertion.
- `/random` opens a paginated catalog of 60 categories/moods. Choose one to five categories/custom searches, or `/random trap sad songs`. Start a bounded rolling queue; turning autoplay off keeps already queued songs. Clearing/stopping disables further refill. Recent recordings are deduplicated; provider exhaustion/rate limits pause radio, not an endless request loop. Categories are catalog searches, not an assertion of exhaustive global genre coverage.
- Private **Channel Play** navigation is available in the main dashboard and music home. `/channel` lists saved channels. Add by public link/@name, numeric ID/private-post link, or an original forwarded channel post. Verify the bot and initiating user's current channel-administrator membership using Telegram, not the claimed forward origin. Hidden-origin forwards/invitation-only links require a numeric ID instead. Save channels per bot and administrator; reverify on use. Channel dashboards remain private, per administrator, with one shared canonical channel queue.
- Owner account allowlists are unchanged. Saving a channel does **not** authorize a new playback-account destination. A verified channel administrator does not gain account-pool, AI or unrelated private-feature access. ForceJoin remains enforced.

## Setup permissions and idle departure

Lancy needs **Invite users**, **Add new administrators**, and **Manage video chats/live streams**. `/vc` lists missing rights before any assistant join/promotion/call changes. Pin permission is optional. Banned assistants must be unbanned by an administrator; join requests require real approval; an assistant role that Lancy cannot edit is not overridden. Existing suitable assistant rights are not rewritten.

**`/stop` immediately clears the queue, disables radio, leaves the call and, for groups, leaves the group.** It does not start a ten-minute grace period. Pending source acquisition is cancelled for this destination; late media cannot restart playback. Failed departure retains cleanup state, blocks replay and retries without disturbing sibling calls. Channel Stop leaves its call, not channel membership.

After **600 uninterrupted idle seconds**, the assistant leaves the call and, for groups, the group itself. Channels retain assistant membership; their call is left at idle. A playing/paused track or queued work is not idle. New work cancels stale deadlines. Prepared sessions with no song also expire. Managed membership metadata and successful departure receipts are persisted without session contents; startup restores cleanup scheduling. Cleanup failures retain state and retry. Shutdown cleans managed group membership rather than leaving an abandoned setup behind.

One registered assistant account may serve multiple simultaneous approved destinations through the installed SDK’s chat-keyed native calls. Leases are per destination, not exclusive to an account. Every queue, source, control, playback identity, lock, cleanup and recovery action stays chat-scoped. Account selection balances leases without imposing a one-call limit. A playing account remains available for another approved destination; owner-private status lists active calls without leaking sibling destinations into group views. Active/prepared accounts cannot be removed or reconfigured underneath their calls. This is tested offline; real simultaneous-call listener acceptance remains required.

## Cards and queue controls

Listen/download and live player cards use the same recording renderer: full playable audio where delivery is permitted, artwork when supplied, identity/album/source/duration metadata, and an expandable matched-lyrics block. Unknown metadata stays unknown. Existing full-recording and download-rights checks remain in place. Lyrics default to a matched excerpt; extended display requires the existing operator rights setting, with remaining text available through the paginated lyrics view.

The `/play` card's **Add to VC queue** stores a scoped recording token. It retains the original group/channel even if the user's later DM binding changes. If no destination was selected, the user explicitly chooses a saved channel. Token ownership includes user, bot, chat and message; queue insertion rechecks current administrator rights and prevents repeat insertion from one card.

Queue rows have **Play now** and **Remove** with stable entry identities, not mutable queue positions. Private-panel callbacks remain message/admin/bot/destination scoped and revision checked. Category menus retain the same scope rules. Search/radio use native rich-list `has_checkbox` / `is_checked` presentation, with Select/Deselect callback buttons carrying the real scoped action. Checkbox presentation alone has no documented Bot API callback; `sendChecklist` instead requires a connected business account. Group dashboards are never automatically pinned; only explicit Pin requests can pin one. The previously approved per-admin private channel-dashboard pin remains unchanged.

## Audio and handoff

The revised call path retains 6 dB of PCM headroom, a non-makeup safety limiter and 48 kHz stereo output, with no default high-pass/EQ or loudness maximization. Optional gentle bass remains audio-only. This replaces the rejected candidate’s high-pass/limiter-only chain. Volume above unity can still clip downstream and is not described as repaired by filtering.

The queue prefetches and pins the next recording (bounded to two preparation jobs globally), keeps the current title/audio truthful during preparation, and replaces the native source without an intentional empty-stream gap. Authenticated native end events trigger advancement promptly; native-status polling remains a fallback. Duplicate/stale completion IDs cannot double-skip. Removed/reordered/abandoned prefetch resources are released.

These measures reduce avoidable gaps and peak distortion. They are **not a promise of gapless/crossfaded DJ mixing or proof that network/device cracking is cured**. Decoder contracts, native acceptance, human audio quality, listener video synchronization and ten-minute idle evidence must be reported separately in the rollout receipt.

## Verification boundary

The reconciled candidate's bounded full suite at the engineering checkpoint had **549 total / 544 passed / three existing assertion failures / two existing search-file timeouts**. Its focused suite passed **155/155**, Python passed **40/40**, and all four installed FFmpeg/media configurations plus empty idle-stream conversion passed. The decoder probe explicitly reports `transport_tested: false`.

The three full-suite assertions are the unchanged custom-prefix, preserved production banner-free group UI and production owner-override mismatches. An earlier run also encountered a transient online lyrics assertion; it passed in the final full run. This release is not labeled a completely green full suite.

Protected operational receipts and the user-facing patch report record the actual activation, listener and idle outcomes. No production/session configuration, private key or database content belongs in this public document.

## Rejected first candidate and revision boundary

The first guarded candidate `bc9601e` was rolled back to the prior permanent release, not finalized or pushed to main. The user rejected the account-wide busy restriction and reported rough audio/unsuitable source; its quality acceptance is failed. Offline decoder success is not a substitute. Two recent cached MP3s decoded at 48 kHz stereo; one had floating-point decoded sample peaks around +3.03 dBFS and RMS around -6.47 dBFS. That identifies a hot source needing comparison, not proof of the transport fault or proof of audible clipping after filtering. The existing YouTube permission opt-in was off; broad title searches therefore used Audius. Source policy and listener A/B verification are pending before another production candidate.

The corrected engineering branch passes **166/166 music/rich UI tests** and **45/45 offline Python tests**. Its 60-second-bounded full run reports **557 total / 554 passed / one existing custom-prefix assertion failure / two existing search-file timeouts**. This branch run does not include the private production overlay; that reconciliation and its release checks must be repeated before activation. No revised native transport, human audio, live concurrency or 600-second idle acceptance is claimed.

The user clarified that the embedded Telegram recording was clean and roughness occurred only in VC. Transport/conversion A/B testing therefore remains mandatory; source hotness is not treated as the established cause. The owner explicitly approved enabling the existing YouTube resolver; the installed extractor passed metadata-search readiness without cookies, authentication bypass or dependency changes.

## Follow-up: loading, retained retry and existing-member group policy

The second guarded window ended automatically without verified live playback or listener acceptance. The reported 16:00 UTC call failures were logged on the restored previous release after that rollback; their underlying SDK exception class was not retained by its queue logger. No successful quality/concurrency/idle test is inferred from that window.

Add selected now renders a preparation card **before** permission/media work. Repeated clicks while it is processing do not enqueue another submission. Pending work does not expire merely because its original search timer passes; failed submission preserves selection and renews expiry. A consumed selection reports that it was already queued/delivered rather than ambiguously saying expired. Native `CALL_FAILED` retains the recording/media in the destination queue, with an explicit freshly authorized Retry queued track control. Safe error-class/code diagnostics are recorded without exception contents, URLs, source paths or credentials.

The owner explicitly approved existing-member group fallback. `music.allowExistingGroupMembers` defaults false and requires restart. When enabled, a verified group administrator and bot administration may prepare an enabled owner-registered assistant that is **already freshly verified as a member of that exact group**, even without an explicit owner allowlist entry. Native grants are per-session/per-group, do not rewrite owner allowlists, and recheck self membership before use. Explicit owner denial overrides membership fallback. No unapproved group invitation/join is allowed; channels still require explicit approval. Existing assistant call rights avoid demanding unnecessary bot invite/promotion rights. If joining or promotion is actually needed, the necessary bot rights remain mandatory. Stop/idle removes temporary grants and, for groups, membership; rejoining an unapproved group then requires manual addition or explicit owner approval.

Guarded test cards now identify their test build and deadline. A longer but bounded test window must still roll back on rejection, supervisor failure or deadline; no listener result is manufactured by decoder/unit tests.
