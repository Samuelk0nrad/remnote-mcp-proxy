# RemNote MCP proxy

An MCP proxy for RemNote Desktop that keeps flashcard fronts and backs separate, verifies edits, and exposes card labels such as **Leech** and **Edit Later**.

The proxy forwards RemNote's built-in tools and adds guarded editing and inspection tools. It reads the local synced database in read-only mode and makes note changes through the RemNote Agent Runtime SDK.

## What it adds

| Task | Tool | Behavior |
| --- | --- | --- |
| Inspect a card before editing | `read_flashcard` | Returns stored front/back, rich text, card IDs, direction and a revision. |
| Change a question or answer | `update_flashcard` | Updates each side separately and verifies the saved result. |
| Change only a Rem's front/text | `update_rem_front` | Preserves the back and card direction. |
| Review pending corrections | `get_edit_later_queue` | Returns queued items with totals and pagination. |
| Finish a correction | `resolve_edit_later_item` | Requires proof of a verified edit before clearing Edit Later. |
| Inspect labels and tags | `get_card_status` | Returns per-card labels, direct built-in powerups and direct tags. |
| Find cards by label | `list_cards_by_status` | Searches supported status labels with pagination. |
| Delete an individual Rem | `delete_rem` | Requires a fresh revision; refuses documents and folders. |

The legacy `update_rem` tool accepts plain Rem text only and requires a revision. It refuses flashcards; use `update_flashcard` for those.

## Requirements

- **Node.js 24 or newer.** The proxy has no third-party runtime dependencies.
- **RemNote Desktop**, with its built-in MCP endpoint enabled.
- **RemNote Agent Runtime / SDK bridge**, already installed, built and running.
- Read access to the database for the currently open knowledge base and the relevant authentication files.

The database, built-in MCP endpoint and SDK runtime must all refer to the **same knowledge base**. Update the database configuration when switching knowledge bases.

Card-label inspection is currently tied to **RemNote 1.28.0** and a specific installed worker bundle. If that version or bundle changes, label tools refuse to report native labels until the adapter is reviewed. This does not disable the SDK editing tools.

## Run locally

This repository provides the proxy, not a complete RemNote or SDK runtime installer.

```sh
git clone https://github.com/Samuelk0nrad/remnote-mcp-proxy.git
cd remnote-mcp-proxy
npm test
REMNOTE_DB=/absolute/path/to/remnote.db npm start
```

Replace the database path with your own. Start RemNote and its SDK runtime first, and run the proxy as a user that can read their configuration.

The MCP endpoint defaults to `http://127.0.0.1:7789/mcp`. Clients must send the configured RemNote MCP token as a bearer token. A remote client needs a suitable authenticated transport to this local endpoint; see [deployment examples](deploy/README.md).

### Configuration

| Variable | Default or purpose |
| --- | --- |
| `REMNOTE_DB` | **Required.** Absolute path to the active knowledge base's `remnote.db`. |
| `HOST` | `127.0.0.1` |
| `PORT` | `7789` |
| `REMNOTE_UPSTREAM_URL` | `http://127.0.0.1:7788/mcp` |
| `REMNOTE_AGENT_URL` | `http://127.0.0.1:3001/mcp` |
| `REMNOTE_CONFIG_PATH` | `~/.config/RemNote/config.json` |
| `REMNOTE_AGENT_AUTH_PATH` | `~/.remnote-agent/auth.json` |
| `REMNOTE_MCP_TOKEN` | Optional override for `remNoteMcpAccessToken` in the RemNote config. |
| `REMNOTE_AGENT_TOKEN` | Optional override for `httpToken` in the runtime auth file. |
| `REMNOTE_APP_ASAR` | `/opt/remnote/app/resources/app.asar`; used to validate the label adapter. |

Here, `~` means the home directory of the user running the proxy. Keep tokens and personal deployment configuration outside Git.

## Edit a flashcard

Use the **Rem ID**, not a practice Card ID. One Rem can produce multiple practice cards, for example when both directions are enabled.

The examples below show tool arguments. Replace the placeholder ID and copy the revision and verification token from actual responses.

1. Read the card with `read_flashcard`:

   ```json
   { "rem_id": "YOUR_REM_ID" }
   ```

2. Change only the answer with `update_flashcard`:

   ```json
   {
     "rem_id": "YOUR_REM_ID",
     "expected_revision": "COPY_REVISION_FROM_READ",
     "back": "The new answer."
   }
   ```

   Omitted sides are preserved. Use `front` to change the stored front. Arrows and separators in strings are literal text; do not combine a question and answer into one field.

3. Check the response for `verified: true`. The proxy reads the card back and checks both sides, card IDs, direction, parent and children.

4. If correcting an Edit Later item, pass the returned token to `resolve_edit_later_item`:

   ```json
   {
     "id": "YOUR_REM_ID",
     "verification_token": "COPY_TOKEN_FROM_VERIFIED_UPDATE"
   }
   ```

   Clearing the marker is refused if the content or queued feedback changed. An update that changes nothing does not issue a correction token.

For formatted sides or embedded references, use `front_rich_text` or `back_rich_text`. Read the existing rich-text arrays first and preserve their structured nodes and formatting. Plain-text replacement is refused when it would discard that structure.

### Supported cards and editing limits

- Basic forward, backward and bidirectional cards are supported. Stored front/back are not necessarily the displayed question/answer of a backward practice card.
- Cloze, multiline, multiple-choice and other unsupported card structures are refused for editing. Reads remain available when the SDK provides complete metadata.
- Revisions reject stale edits, and writes through this proxy are serialized per Rem. Other clients can still change a card between a check and a write.
- Updating both sides requires separate SDK operations. A failure can leave a partial change. Read the card again before recovery; the proxy leaves Edit Later unresolved and does not automatically retry or roll back.
- `delete_rem` refuses unknown types, documents and folders. Deleting a parent requires `allow_descendants: true`, which also authorizes deletion of its subtree. Git rollback restores code, not notes.
- Verification tokens expire after seven days. Changing the MCP authentication token invalidates them.

## Inspect labels and tags

Call `list_cards_by_status` with, for example:

```json
{ "status": "leech", "limit": 50 }
```

Supported statuses are `leech`, `struggling`, `disabled`, `enabled`, `edit_later`, `new`, `not_yet_learned` and `stale`. Use `get_card_status` with a `rem_id` to inspect an individual Rem's practice cards and direct tags.

Leech and Struggling are computed labels, not ordinary tags. The adapter follows the pinned RemNote version's review-history rules and configured leech threshold. Leech status occurs at positive multiples of the effective threshold, not simply whenever total failures exceed it.

Status results reflect the local synced database. Direct tags are read through the SDK. Inherited tags and effective document pause state are not calculated, and unknown powerup codes are reported as unknown.

For paginated status and queue results, follow `next_cursor` while `has_more` is true. The underlying data can change between pages; restart a scan when you need to include newly added items that sort before your cursor.

## Validation

Run the unit suite without a live RemNote installation:

```sh
npm test
```

Two additional checks require a configured installation:

```sh
# Read-only comparison with the pinned app's native label logic.
REMNOTE_DB=/absolute/path/to/remnote.db node scripts/verify-status.mjs

# Exercise the running proxy using temporary test notes.
REMNOTE_DB=/absolute/path/to/remnote.db \
  MCP_PROXY_URL=http://127.0.0.1:7789/mcp \
  node scripts/smoke-test.mjs
```

The smoke test creates, edits and cleans up its own temporary notes. Run it as the RemNote service user: it reads the default RemNote and runtime authentication files in that user's home and uses the default local runtime endpoint. Unlike the server, it does not honor the authentication-file or token overrides. Omitting `MCP_PROXY_URL` tests the in-process handler instead of the HTTP endpoint.

## Deployment and maintenance

See [the deployment README](deploy/README.md) for the service examples, optional tunnel configuration and rollback procedure. Refresh your MCP client's tool catalog after schema changes; ChatGPT may need a fresh conversation to use the updated tools.

Commit completed changes and keep a rollback checkpoint before deploying. Contributor guidance is in [AGENTS.md](AGENTS.md).
