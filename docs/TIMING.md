# Review timing data

Timing is available through five existing read-only tools. The database and history remain unchanged. Nothing is specific to one subject.

| Tool | Timing fields |
| --- | --- |
| `get_card_review_history` | Each event has `timing`, `origin`, and `multiline_items`. No timing threshold removes an event. Existing date, practice-mode and external-grade filters still apply. |
| `list_card_review_stats` | Each card has `timing.period` and `timing.lifetime` for retained valid-date history. |
| `get_study_workload` | Overall `timing` and a `timing` summary on every study date; optional outline scope. |
| `compare_study_topics` | Each topic has `timing`, using the same date/mode/external filters and threshold. Overlapping topics must not be summed. |
| `get_review_difficulty_trends` | `timing.earlier`, `timing.recent`, `timing.period`, and `timing.change`, using the existing earlier/recent date windows. |

The forecast tool remains a stored-schedule snapshot. It does not multiply due cards by observed timings or claim predicted active study minutes.

## Raw measurements and quality

`timing.response_time_ms` and `timing.reveal_time_ms` retain finite numeric source values, including negative values marked invalid. Missing or nonnumeric values return null with a separate state; strings and arbitrary objects are not exported as timings. `recorded_seconds` is usable nonnegative response time divided by 1,000; `reveal_seconds` is the corresponding reveal offset. Separate threshold flags preserve all history entries. Missing, invalid and zero values are distinguished. Unsafe values above JavaScript's safe numeric range are invalid for statistics. Valid response time remains usable even if reveal time is missing or inconsistent.

**Response time already includes the full recorded review. Never add reveal time to it.** In the installed desktop review controller, response time is the submission timestamp minus the current review's start timestamp. Reveal time is an offset from that same start. Hide/reveal actions can update the reveal state, and imports or external grades can use zero defaults, so the proxy does not claim a precise first-reveal or active front/back time split.

The response includes flags such as `missing_response_time`, `invalid_response_time`, `zero_response_time`, `reveal_exceeds_response`, and `exceeds_selected_threshold`. A long measurement can represent interruption, extended effort or other delays. It is not evidence of a pause. Recorded time is not measured active study time, and sums are not deduplicated wall-clock session time.

## Transparent filtering and statistics

`max_review_seconds` is an optional finite positive number, including fractions. **There is no default threshold.** A response time strictly greater than the supplied threshold is excluded only from the additional filtered distributions. Exactly equal values are retained. The agent should explain its chosen threshold and keep it consistent across comparisons. It is bound into pagination cursors; changing it requires restarting pagination.

Existing summary fields continue to describe **total response time**. Each summary now also has a separate `reveal` object with the same distributions, quality counts and rating/mode/origin/structure breakdowns for stored reveal offsets. This applies to daily totals, per-card period/lifetime statistics, topics and earlier/recent windows.

Every measurement summary contains:

- `max_review_seconds` for response or `max_reveal_seconds` for reveal: chosen threshold or null.
- `graded_reviews`, missing/invalid duration counts and `zero_duration_reviews`.
- `unfiltered`: all usable nonnegative recorded durations, including zeros.
- `positive_only`: the same data excluding zero/default values.
- `filtered` and `filtered_positive_only`: corresponding distributions with the threshold applied, or null when no threshold was supplied.
- `excluded_by_threshold`: count and recorded seconds excluded for exceeding the threshold. This is separate from missing/invalid/zero quality counts.
- `by_rating`, `by_practice_mode`, `by_origin`, and `by_structure`: independently grouped unfiltered/filtered distributions and quality counts. Empty groups are omitted; positive-only distributions are available at the overall level.

Distributions report sample count, total recorded seconds, mean, minimum, first quartile, median, third quartile and maximum. Quantiles use sorted linear interpolation at `(n-1)*p` (R-7). No samples means null totals and quantiles, not a measured zero. A median of zero can reflect default values; compare the positive-only distribution.

Only real graded outer events contribute to timing summaries, following existing grade definitions and valid-date checks. Skips, resets, leech views, manual scheduling events and simulations remain visible in history and event counters but are not graded timing samples. Thresholds do not change rating counts or Again share. History invalidity is reported separately by the existing coverage fields.

Origins distinguish explicit `addedExternally`, recognized Anki import metadata, and native-mobile metadata; otherwise origin is `standard_or_unknown`. These markers do not establish a complete provenance history. Workload and per-card views include all practice modes/origins and break them out; history, comparison and trend tools retain their existing mode/external filters. `include_external: false` excludes explicitly externally added grades, not every import. `multiline` grouping means stored item scores or a full/partial multiline flag exist; absence of those fields does not prove a basic card.

Reveal summaries also report `exceeds_response_time_reviews` and `response_time_unavailable_reviews`. Nonnegative reveal values remain visible in unfiltered statistics even when inconsistent with total response time; these counts flag the uncertainty.

`max_reveal_seconds` has the same validation and strict-greater-than rule as `max_review_seconds`, but each filters only its own measurement. Neither has a default. A review with a long total but short reveal can therefore remain in the filtered reveal statistics. Sample sets can differ: never subtract medians or totals to infer checking time, and never add reveal totals to response totals.

Timing changes report median difference and ratio, with sample sizes, for each unfiltered/positive/filtered distribution. The existing `min_reviews` applies independently to usable timed samples in both windows. A reset or invalid review history suppresses changes; a zero earlier median makes the ratio null. `timing.change.reveal` reports the same independently gated comparisons for reveal offsets. Faster is not automatically better recall: examine rating mix, origin, structure and sample sizes.

## Multiline answer items

`multiline_items.items` exposes only stored item index, Rem ID, numeric score, mapped rating and raw response milliseconds/state. Unknown numeric scores retain their number and a null rating. Malformed entries are counted; unrelated metadata and answer text are not exported.

In the verified desktop implementation, an item time runs from the previous item score or the review start. A grouped submission can attach the **same interval to several items**. Consequently these are separate observations, not additive time accounting. They never create additional outer review attempts or contribute to whole-card timing totals. Item IDs refer to the stored event and may no longer identify current content.

## Verification and limitations

Verified against RemNote Desktop 1.28.0, review controller bundle `45827.acbbdf059c097136.bundle.js` and multiline controller bundle `33576.e51ae303fd1d87e4.bundle.js`. The adapter checks the installed version and required bundle filenames before claiming supported semantics. RemNote's [flashcard statistics documentation](https://help.remnote.com/en/articles/7970392-flashcard-statistics) also describes response time as including both sides. Other clients and historical imports may record different defaults; raw values and origin hints remain visible.

Unit tests cover cutoff boundaries, invalid and zero timings, quantiles, raw/filtered parity across the five views, mode/external filtering, multiline non-additivity, sample limits, resets and pagination. `scripts/verify-timing.mjs` checks live read-only parity; `scripts/smoke-test.mjs` checks the MCP interface with temporary notes only. No historical timing data is rewritten, and no activity tracker is installed.
