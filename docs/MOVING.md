# Move existing flashcards

`move_flashcards` relocates question Rems and their child answers/context. It does not recreate cards, grade them, change their content, or clear Edit Later. It works with any subject and uses exact IDs rather than guessing from topic names.

## Read, choose the destination, then move

Read every source question and the intended destination with `read_flashcard`. Copy the source revisions and the destination revision into the request:

```json
{
  "cards": [
    { "rem_id": "EXISTING_QUESTION_REM_ID", "expected_revision": "COPY_SOURCE_REVISION" }
  ],
  "parent_rem_id": "DESTINATION_HEADING_REM_ID",
  "expected_parent_revision": "COPY_DESTINATION_REVISION",
  "placement": { "position": "end" },
  "request_id": "NEW_UNIQUE_MOVE_REQUEST_KEY"
}
```

Replace all placeholders, including the full revision values. The tool accepts 1–10 source question Rems. It rejects duplicate IDs, documents, folders, standalone answer items, destinations that are themselves questions/answers, moves into a source subtree, and batches containing both an ancestor and its descendant.

`placement` defaults to end. `start` and `end` use the destination's child list. `before`/`after` require a `sibling_rem_id` that is a remaining direct child, not one of the moving cards. Final batch order follows the input `cards` order, including same-parent reordering. Positions in the result are zero-based. An already-correct placement is a verified no-op.

The public tool hides a native SDK detail: `moveRems` counts positions before source removal and reorders multi-source selections. The proxy moves one source at a time before a fixed remaining anchor to preserve the requested order, checking sibling lists between moves.

## What gets verified

Before writing, the tool checks fresh source/destination revisions, source sibling lists, descendant snapshots and retained review records. It then verifies:

- The destination and original source sibling orders.
- Unchanged question/answer rich text, marked child answers, context subtree, direction and state.
- The same practice-card identities on the question and nested Rems.
- Unchanged retained review records for those practice cards. Missing and empty history both mean no retained events; actual events are compared structurally.

The first result includes each moved Rem ID, previous/new parent, position, current revision and root practice-card IDs. This verifies stored structure and records, not the rendered practice screen. Destination deck/ancestor settings can affect practice queue membership.

Verification is bounded to eight descendant levels, 100 descendants per source and the existing card-reader limits. Excessive or ambiguous structures are refused. If new card identities have not yet synced into the database, wait and obtain fresh reads before moving.

## Retry and recovery

Use a new request key for each intended move. After a timeout, repeat the **same key and arguments**. Completed retries return the original receipt, with `replayed: true` and `verification_scope: "original_move_receipt"`; obtain a fresh SDK read to inspect current state. A changed payload under the same key is rejected.

The move journal shares the persistent proxy-owned database used for creation, under a separate request namespace. It contains IDs and verification receipts, not note content or review-history records. Keep it through restarts, upgrades and code rollbacks; see [persistent state](../deploy/README.md#creation-request-state).

SDK moves are not an atomic transaction. A failure, concurrent edit or lost response can leave some or all sources moved. The tool returns an MCP error with structured `status: "needs_inspection"` and the involved IDs. It does not repeat or reverse uncertain moves automatically. Inspect current locations and content before a deliberate repair; never choose a new request key just to bypass the guard.

Git rollback restores proxy code, not note locations. The original parent IDs in successful receipts help plan a deliberate move back, using fresh revisions and the intended sibling positions.

## Live test

```sh
REMNOTE_DB=/absolute/path/to/remnote.db \
MCP_PROXY_URL=http://127.0.0.1:7789/mcp \
node scripts/smoke-move-flashcards.mjs
```

The test creates its own temporary basic, multiline and nested cards, moves/reorders them, checks identities, retained history, notes and answer structure, exercises retry and stale-revision guards, and verifies fixture deletion. It never moves existing user notes. Omit the proxy URL to exercise a candidate handler before deployment.
