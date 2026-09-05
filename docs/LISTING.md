# Search, filter and rank flashcards

`list_flashcards` is a read-only inventory and analytics tool. It returns one row per question Rem, with its included practice-card rows grouped underneath. This avoids showing a bidirectional question twice while keeping each direction's metrics inspectable.

## Example: the most time-consuming matching questions

```json
{
  "root_rem_id": "TOPIC_OR_HEADING_REM_ID",
  "search": { "text": "infrastructure", "in": ["front", "back", "answer_items"] },
  "filters": {
    "types": ["basic", "multiline"],
    "enabled": true,
    "review_count": { "min": 3 }
  },
  "period": {
    "start_date": "2026-09-01",
    "end_date": "2026-09-05",
    "timezone": "Europe/Vienna"
  },
  "sort": [
    { "field": "recorded_review_seconds", "order": "desc" },
    { "field": "review_count", "order": "desc" }
  ],
  "limit": 20
}
```

All fields are optional. `{}` lists the knowledge base, sorted by stored front text. Replace example IDs/dates with the user's selection. No topic names or subject-specific rules are built in.

## Scope and search

- `root_rem_id`: the root and its parent-linked descendants. Omit for the whole knowledge base. Tags and portals do not expand membership.
- `include_descendants: false`: root plus direct children only.
- `include_retired`: defaults to false. True includes retained retired practice rows in both membership and statistics. Orphaned practice rows without an existing question Rem are always excluded and counted separately.
- `search.text`: literal, case-insensitive substring, normalized to Unicode NFC. `search.in` defaults to front, inline back and marked child answer text. Ordinary context notes are not silently treated as answers. Search uses the complete stored text, before output clipping.
- `include_content: false`: omits answer/question text in results but still searches and ranks on full text.
- `content_limit`: default 4,000 characters per result, shared across front/back/child-answer text; 100–20,000 allowed. `content_truncated` explicitly reports clipping. `read_flashcard` or the document reader can inspect more content.

## Filters

Different fields combine with AND. Alternatives in `types`, `directions` and `labels_any` use OR. `labels_all` requires every named label.

| Field | Values or meaning |
| --- | --- |
| `types` | `basic`, `multiline`, `multiple_choice`, `other` |
| `directions` | `forward`, `backward`, `both`, `none`, `unknown` |
| `enabled` | At least one included practice direction is enabled; false means none. |
| `labels_any`, `labels_all` | `leech`, `struggling`, `disabled`, `enabled`, `edit_later`, `new`, `not_yet_learned`, `stale` |
| Count/timing fields below | Inclusive `{ "min": number, "max": number }`; either bound may be omitted. |
| Date fields below | Inclusive ISO timestamp ranges, with an explicit timezone. |

Type classification uses verified stored fields: marked child answers imply multiline; the multiple-choice powerup takes precedence; basic requires inline back plus ordinary forward/backward practice codes. Unrecognized structures remain visible as `other` with their raw practice type codes. They are not misreported as basic. Child answers are ordered by RemNote's stored fractional sibling index, with ID fallback when unavailable.

Labels use the existing native adapter and configured leech threshold. A question's label is true when any included direction has it; all labels remain available separately on each practice row. Thus one question can have both an enabled and a disabled direction. `enabled_all` is separate. Malformed score data makes affected history-derived labels unknown when they cannot be established. Document pausing is not the same as disabled state.

## Sort and metric fields

Up to three ordered `{ "field": "...", "order": "asc|desc" }` keys are accepted. Every match is ranked before pagination. Missing values always sort last, in either direction; Rem ID is the final stable tie breaker. Unknown values never satisfy a numeric/date range, even a minimum of zero.

- Text/type: `front`, `type`, `direction`.
- Dates: `created_at`, `updated_at`, `last_review_at`, `next_review_at`.
- Counts: `review_count`, `again_count`, `hard_count`, `good_count`, `easy_count`, `practice_card_count`.
- Proportions: `again_share`, `hard_share`, `good_share`, `easy_share` (0–1, null without grades).
- Recorded timing: `recorded_review_seconds`, `median_review_seconds`, `recorded_reveal_seconds`, `median_reveal_seconds`.
- Measured samples: `timed_reviews`, `reveal_timed_reviews`.
- Optional filtered timing: `filtered_review_seconds`, `filtered_median_review_seconds`, `filtered_reveal_seconds`, `filtered_median_reveal_seconds`.

All numeric fields also accept range filters. Text/type sorting uses deterministic lexical order. There is no inferred "workload score": total recorded time, review count and median duration are distinct choices.

## History and timing semantics

Without `period`, metrics cover all retained history. With `period`, supply `start_date` and `timezone`; `end_date` defaults to start and the window is at most 366 study dates. The study-day boundary follows the configured RemNote setting unless `day_start_hour` overrides it.

Question metrics combine the actual review events across included practice directions. Medians are calculated from their combined observations, never averaged from per-direction medians. Retired histories are excluded by default; enable them when analyzing historical workload. Deleted/purged/undone history is unavailable. Invalid events are counted; missing timings stay null and are not zero seconds. Simulated reviews and administrative events are not completed grades. Administration/reset counts and timing quality remain in the result.

`max_review_seconds` and `max_reveal_seconds` independently enable filtered metrics. With no respective threshold, those filtered fields are null. Unfiltered measurements and exclusion counts remain visible. Recorded time does not measure uninterrupted retrieval; see [timing semantics](TIMING.md).

`last_review_at` is the latest retained graded review across included directions, independent of the selected metric period. `next_review_at` is the earliest stored schedule across included practice rows, including disabled ones; it does not claim native queue membership or account for deck priorities and daily limits. Creation/update dates belong to the question Rem, not its practice rows.

## Results, pagination and verification

Results include content, outline location, type/direction, labels, dates, period/lifetime metrics according to `period`, timing quality, and each included practice-card ID with its own metrics. They are a read-only synced-database snapshot, not a rendered practice preview. Use `read_flashcard` for live SDK inspection and a revision before modifying a card.

`limit` defaults to 20, maximum 50. Follow `next_cursor` with the same query; page size may change. Filters, sorting and the snapshot are bound to the cursor. A changed database or relevant setting causes an explicit restart error rather than silently duplicating/skipping ranks.

Run the offline suite with `npm test`. `scripts/verify-list-flashcards.mjs` is a read-only live check: it compares grouped counts/timing with existing per-card analytics, checks ranking/pagination, and compares selected content, answer membership, direction and dates with SDK reads. It outputs only validation counts and booleans.
