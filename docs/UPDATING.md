# Update existing flashcards

`update_flashcard` uses the same card content fields as `create_flashcards`: `type`, `direction`, `front`, `back`, and `notes`. It updates one existing question Rem at a time. Creation wraps these fields in `cards`; updating adds `rem_id`, `expected_revision`, and `request_id` to identify and protect the existing card.

Images can be added, replaced or explicitly removed with `image_changes`; see the [image guide](IMAGES.md) for side/item targeting and source options.

Read the card with `read_flashcard` first. Copy its Rem ID and revision; practice Card IDs identify review directions and are not edit targets. All omitted content fields and direction remain unchanged. A supplied `type` must match the existing layout. This release supports basic and flat multiline cards; it refuses type conversion, cloze and multiple-choice editing.

## Basic answer

```json
{
  "rem_id": "EXISTING_QUESTION_REM_ID",
  "expected_revision": "COPY_REVISION_FROM_READ",
  "request_id": "NEW_UNIQUE_REQUEST_KEY",
  "type": "basic",
  "back": "The revised answer."
}
```

`front` and basic `back` are separate literal strings. Arrows and Markdown do not define card sides. Questions and basic answers must remain nonblank. Use `front_rich_text` or `back_rich_text` for existing formatted sides, preserving their structured nodes, references and formatting. The older basic `front`/`back` call without typed fields or a request key remains compatible; use the typed form for the additional history/schedule checks and durable retry protection.

## Multiline answer

```json
{
  "rem_id": "EXISTING_QUESTION_REM_ID",
  "expected_revision": "COPY_REVISION_FROM_READ",
  "request_id": "NEW_UNIQUE_REQUEST_KEY",
  "type": "multiline",
  "front": "Which steps are required?",
  "back": {
    "items": [
      { "rem_id": "EXISTING_ITEM_ONE", "text": "The revised first step." },
      { "rem_id": "EXISTING_ITEM_TWO", "text": "The revised second step." },
      { "text": "An additional step." }
    ]
  }
}
```

Each answer item remains a marked child Rem. The inline back stays empty. Item IDs come from `read_flashcard.answer_items`; the question and retained answer items are updated in place.

- With **any item ID supplied**, entries with IDs update/reorder those existing items; entries without IDs create new marked children.
- With **no item IDs supplied**, surviving existing items are reused in order, and extra entries create children. Explicit IDs are preferable when reordering.
- Every surviving existing answer item must appear exactly once. A shorter list never silently removes answers.
- Removing an answer requires its ID in `delete_item_rem_ids` **and** the complete replacement `back.items` list. Only direct leaves without independent practice cards or an inline answer can be removed.
- For formatted items, use `rich_text` instead of `text` and preserve the existing structured nodes. New items are literal text in this version.
- Nested answer replacement is refused. Omitting `back` preserves the existing answer tree while allowing the question to be edited.

## Notes and placement

`notes` has the same array-of-strings shape as creation. Existing surviving unmarked children are reused in order; extra entries create unmarked context/source notes. Omit the field to preserve all context. A shorter list requires `delete_note_rem_ids` naming the leaves to remove. Independent child flashcards must be edited through their own Rem IDs, and rich context cannot be flattened. The read response includes direct `context_items` so callers can inspect their IDs and stored text.

The question stays under its current parent. Answer order follows `back.items`; context retains its relative slots around answers where possible. Moving a question to a different heading uses [`move_flashcards`](MOVING.md), not this updater.

## Spaced repetition

Updating existing content **does not request a reset or grade the card**. The typed updater checks retained practice-card IDs, review history and stored scheduling fields before reporting success. There is no reset or reschedule option in this tool.

If direction is unchanged, it also checks the stored active-queue fields. An explicit direction change can activate/deactivate directions or generate a new practice card. Existing histories and underlying schedules of retained cards are checked; active-queue fields are allowed to reflect the requested direction. A newly generated direction has its own scheduling state, not a copied review history. The response reports this in `spaced_repetition`, including `new_practice_card_ids`. RemNote may delete a disabled direction that has **no review history**; the updater permits only that narrow exception and reports `removed_unreviewed_practice_card_ids`. It never accepts the disappearance of a card with retained history. Re-enabling a removed unreviewed direction creates a new practice identity.

Preserving a schedule does not establish that old grades still measure mastery after a substantial change in meaning. That is a study decision; the updater does not silently reset anything. Concurrent practice, sync or scheduler changes can make verification fail even when the content edit was applied.

## Verification, limits and retries

Use a fresh UUID or equivalent request key for each intended typed update. After a timeout, retry **the same key and identical arguments**. A completed retry returns the original compact receipt with `replayed: true`; it does not assert current content and omits the full card. Read again for current state. The persistent journal is shared with creation/moving, using a separate operation namespace; it stores hashes, IDs and compact receipts rather than note text. Keep it across restarts and rollbacks.

A verified changed update returns a correction token for `resolve_edit_later_item`; updating does not itself clear Edit Later. An unchanged update issues no correction token. A stale parent revision—including direct context changes—is rejected before writing. Reads cover marked answer branches and direct context within the reader's bounds.

SDK edits are separate operations, not an atomic transaction. Other clients can still edit between a check and a write. A failure can leave partial changes, including created or explicitly removed leaves. The tool returns `needs_inspection`, known created IDs and any allocation uncertainty, does not repeat the write, and does not automatically undo it. Inspect and reconcile before beginning a new request. Git rollback restores code, not RemNote content.

Limits: one question per update, 1–20 answer items, up to 10 supplied context notes, no more than 50 current-plus-new direct children, 200,000 serialized request characters, and 50,000 characters per text field. Existing deep or large structures remain subject to read limits.

Run offline tests with `npm test`. With the matching RemNote installation and runtime running:

```sh
REMNOTE_DB=/absolute/path/to/remnote.db \
MCP_PROXY_URL=http://127.0.0.1:7789/mcp \
node scripts/smoke-update-flashcards.mjs
```

The live check creates its own disposable basic/multiline cards, verifies edits, item identity, additions/reordering/removal, notes, directions, retries and stored history/schedules, then verifies cleanup. It does not grade cards or use personal notes. Omit `MCP_PROXY_URL` to exercise a candidate handler before deployment. Real retained review histories are covered by synthetic offline fixtures; the live fixtures start without study history.
