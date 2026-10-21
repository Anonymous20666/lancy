# Card-only /play repair

Based on official 0f9272a, not the unfinished music patch series.

The integrated /play path bypassed the original full-card renderer. Reuse the original downloader presentation through a presentation-only adapter: original media ordering, metadata table, expandable lyrics, footer and existing non-VC actions. Preserve canonical download rights and recording identity. Do not re-run the legacy resolver or substitute recordings. Display actual source/format rather than invented Spotify/192kbps labels; album/year only when supplied. Existing matched-lyrics display limits remain in effect. Artwork is optional, public-HTTPS/DNS-pinned, size/pixel bounded and abortable.

The repair does not activate Add to VC queue, member fallback, transport/audio changes, call creation, multiselect changes, concurrent calls or the broader music rollout. No voice Python source is changed. The existing private production overlay must be preserved.

Native Telegram payload delivery is not a claim of human visual acceptance or VC listener quality.
