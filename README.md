# RemNote MCP proxy

This proxy preserves RemNote Desktop's built-in MCP tools and adds safe flashcard editing and Edit Later inspection. It requires Node.js 24 or newer and the existing RemNote Agent Runtime/SDK bridge. No third-party runtime dependencies are required by the proxy itself.

## Editing workflow

1. `read_flashcard({rem_id})` returns the live stored front/back, their rich-text arrays, practice direction, card IDs, children and a revision.
2. `update_flashcard({rem_id, expected_revision, back: "New answer"})` changes the back only. `front` is separate; omitted sides are preserved. Use `front_rich_text`/`back_rich_text` for existing formatting and embedded references. Structured nodes must be preserved. Arrows are literal text, never delimiters.
3. The update reads both sides back and checks card IDs, direction, parent and children. It returns `verified: true`, the updated card and an opaque `verification_token`.
4. For an Edit Later item, pass that token to `resolve_edit_later_item({id, verification_token})`. The proxy verifies the content and queued feedback still match, then removes and checks the marker.

`update_rem_front` explicitly edits only a Rem's stored front/text. `update_rem` remains a compatibility entry point but requires a revision and refuses flashcards. Old clients that send whole cards through `text` receive an actionable error instead of corrupting the front. No-op updates do not issue correction tokens.

Basic forward and backward cards are supported. Persisted card IDs are also read through the SDK because its ordinary card-list operation omits cards held in Edit Later. Bidirectional basic cards retain both practice-card IDs. Cloze, multiline and other card types are deliberately refused until their structures have dedicated editing support. Reading them remains supported when the SDK returns complete metadata. Stored front/back are not the rendered question/answer of a backward card.

## Safety and limits

- Revisions reject changes since the last read, and per-Rem locks serialize writes through this proxy.
- The SDK has separate front/back operations, not an atomic compare-and-swap transaction. Concurrent edits from other clients can still race between a check and a write. Avoid simultaneous editing of the same Rem.
- If a multi-side update fails partway, the tool reports that content may have partially changed and leaves Edit Later unresolved. It does not blindly retry or roll back over a potential user edit. Read again before recovery.
- `delete_rem` requires the latest revision, a confirmed non-document/non-folder type, and explicit `allow_descendants:true` for a parent. It verifies absence after deletion. Git rollback restores code, not deleted notes.
- Queue reads use SQLite read-only; all note writes use the SDK. `get_edit_later_queue` includes `total`, `has_more` and `next_cursor`. Follow the cursor for complete traversal. Queue contents can change during traversal; restart a scan to include newly added items that sort before its cursor.
- Successful tool calls require valid runtime results and readback. Runtime calls have bounded timeouts; an uncertain write must be inspected before retrying.
- Verification tokens are signed with the proxy's existing authentication secret, expire after seven days and survive restarts. They contain hashes and identifiers, not note text. Changing the secret invalidates old tokens.

## Running and testing

```sh
npm test
npm start
```

Required: `REMNOTE_DB` points to the currently open RemNote knowledge-base database. The SDK runtime, built-in MCP and database must refer to that same knowledge base. Switching knowledge bases requires updating this configuration.

Defaults: proxy `127.0.0.1:7789`, built-in MCP `http://127.0.0.1:7788/mcp`, Agent Runtime `http://127.0.0.1:3001/mcp`. Override with `HOST`, `PORT`, `REMNOTE_UPSTREAM_URL`, `REMNOTE_AGENT_URL`.

The proxy reads authentication from the RemNote config and runtime auth files under the service user's home. Optional overrides are `REMNOTE_MCP_TOKEN`, `REMNOTE_AGENT_TOKEN`, `REMNOTE_CONFIG_PATH`, and `REMNOTE_AGENT_AUTH_PATH`. Never put credentials in Git.

## Git and deployment

Local source checkout: `/home/remnote/remnote/remnote-mcp-proxy`. The `AGENTS.md` in that repository requires completed changes and deployment checkpoints to be committed.

Server: Example server (`192.0.2.10`), `/opt/remnote-mcp-proxy`, owned by `remnote`; service `remnote-mcp-proxy.service`.

The deployed original is committed and tagged `before-flashcard-safety`. Commit every completed change before deployment. Keep the working tree clean and run tests before restarting the proxy. Refresh the ChatGPT RemNote plugin's tool catalog after schema changes, then start a fresh conversation.

To restore the original code while retaining history, on the server as root:

```sh
runuser -u remnote -- git -C /opt/remnote-mcp-proxy switch -c rollback-flashcard-safety before-flashcard-safety
systemctl restart remnote-mcp-proxy
systemctl is-active remnote-mcp-proxy
```

Use a new rollback branch name if that name already exists. Refresh ChatGPT's tool catalog after rolling back. Do not use `git reset --hard`; the history and deployment branches should remain recoverable.

## Read-only labels and tags

- `get_card_status({rem_id})` shows computed labels for each practice card, direct built-in Rem labels/powerups and live direct tags. Use `limit`/`cursor` for Rems with many practice cards.
- `list_cards_by_status({status: "leech", limit: 50})` finds cards with a label and returns totals and pagination. Supported labels: `leech`, `struggling`, `disabled`, `enabled`, `edit_later`, `new`, `not_yet_learned`, `stale`.
- Leech and Struggling are computed card labels, not ordinary tags. The adapter follows the installed app's exact history logic and reads the `leechThreshold` user setting. RemNote 1.28.0 clamps that threshold to at least four and marks positive multiples, not every count above the threshold.
- These labels use a read-only snapshot of the local synced database. Direct tags are read through the live SDK. Unknown powerup codes are returned as unknown, not guessed. Inherited tags and effective document pause state are not calculated.
- The label adapter checks the installed version and worker-bundle fingerprint. If RemNote is upgraded, status calls refuse to claim native labels until the adapter is reviewed; the SDK editing tools remain available. `REMNOTE_APP_ASAR` overrides the default server app archive `/opt/remnote/app/resources/app.asar`.
- Validation: `REMNOTE_DB=... node scripts/verify-status.mjs` compares Leech, Struggling and New against the installed app's extracted native history functions without modifying notes. `REMNOTE_DB=... node scripts/smoke-test.mjs` tests only temporary notes created by the script. Set `MCP_PROXY_URL=http://127.0.0.1:7789/mcp` to test the deployed HTTP endpoint.
