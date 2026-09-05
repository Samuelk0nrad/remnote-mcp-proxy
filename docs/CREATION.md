# Create flashcards in an exact location

`create_flashcards` creates 1–10 question Rems beneath an existing document or ordinary heading. Read the topic outline first and copy the intended heading's Rem ID. A document's outer level and its nested topic heading are different destinations. The tool never guesses a different destination.

## Basic and multiline examples

```json
{
  "parent_rem_id": "DESTINATION_HEADING_ID",
  "placement": { "position": "end" },
  "request_id": "NEW_UNIQUE_REQUEST_KEY",
  "cards": [
    {
      "type": "basic",
      "direction": "both",
      "front": "What does infrastructure provide?",
      "back": "Transport, communication and essential services.",
      "notes": ["Optional source citation"]
    },
    {
      "type": "multiline",
      "direction": "forward",
      "front": "Which factors influence a location?",
      "back": {
        "items": [
          { "text": "Infrastructure and transport connections" },
          { "text": "Availability of qualified workers" },
          { "text": "Energy and property costs" }
        ]
      }
    }
  ]
}
```

The placeholders must be replaced. Use a fresh UUID or equivalent unique request key for each intended batch. The tool supports any subject; it does not impose section names or educational categories.

- `type`: `basic` or `multiline`. Each type validates its own back structure. Other types, such as cloze, image occlusion and multiple choice, are not supported by this creation tool yet.
- `direction`: `forward`, `backward`, or `both`, supported for both current types; defaults to `forward`. A future type without direction will need a schema that excludes it.
- `front` and basic `back`: nonblank literal strings. Markdown, arrows, `>>` and similar text are never parsed as formatting or extra flashcards. This version does not create rich text, links, images or nested answers.
- Multiline `back.items`: 1–20 `{ "text": "..." }` entries, each stored as a marked child answer. An empty inline back is expected for this structure.
- `notes`: up to 10 plain context/source notes per card. These are unmarked children and are not extra answer items.
- Batch limit: 10 question Rems, 60 total Rems including children, 200,000 serialized content characters; each text field allows at most 50,000 characters. Split larger work across distinct requests.

## Placement

`placement` defaults to `{ "position": "end" }`. `start` inserts before existing children; `end` inserts after them. `before` and `after` require an existing direct sibling:

```json
{
  "position": "after",
  "sibling_rem_id": "EXISTING_SIBLING_REM_ID"
}
```

Sibling anchors must belong directly to `parent_rem_id`. The batch retains its input order. Returned positions are zero-based. Card/answer destinations, ambiguous state, mismatched sibling anchors and destinations with over 500 direct children are refused. Existing card content is not moved or rewritten.

## Verification and retries

A first successful result returns verified literal front/back content, source notes, parent and position, question/answer/note Rem IDs, and generated practice-card IDs. Both sides remain in their stored orientation even for backward practice. Verification covers SDK structure and placement; it is not a rendered practice-screen test.

A proxy-owned SQLite journal records a request hash, argument hash, execution state, created IDs and a compact receipt, without storing question or answer text. It is separate from the read-only RemNote database. Keep it persistent across deploys and restarts; see [deployment](../deploy/README.md#creation-request-state).

- Retry the **same request key with the same arguments** after a timeout.
- A completed retry returns the original compact receipt with `replayed: true` and `verification_scope: "original_creation_receipt"`. It omits the content fields and does not assert that the cards remain unchanged; use `read_flashcard` for a fresh inspection.
- The same key with different arguments is rejected.
- An interrupted or failed request returns an MCP tool error with structured `status: "needs_inspection"`, known created IDs and an uncertainty flag. It never automatically repeats creation.
- If the SDK allocated a Rem but its response was lost, that ID may be unavailable; `uncertain_creation` makes this explicit. Do not bypass this state by choosing a new request key. Inspect the live outline/recent Rems and reconcile the partial result first.

Creation is a sequence of SDK operations, not a RemNote transaction. A failure can leave detached or partially configured new Rems. The tool preserves them for inspection rather than deleting potentially edited content. Destination changes are checked before placement, between insertions, and after verification. Concurrent edits can cause a reported conflict; the SDK offers no atomic compare-and-insert guarantee.

## Validate your installation

Run `npm test` for offline tests. With the matching RemNote installation and runtime running:

```sh
REMNOTE_DB=/absolute/path/to/remnote.db \
MCP_PROXY_URL=http://127.0.0.1:7789/mcp \
node scripts/smoke-create-flashcards.mjs
```

This live test uses only its own temporary fixtures, verifies basic and multiline cards in all three directions, checks all four placement modes, tests retry protection and invalid destinations, and verifies fixture removal. It does not grade cards or alter existing notes. Omit `MCP_PROXY_URL` to exercise a candidate handler directly before deployment.
