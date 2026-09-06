# Deployment examples

These files are templates for an existing RemNote Desktop and Agent Runtime installation. For a new installation, complete the [first-time setup guide](../docs/SETUP.md) first. Adapt these templates to your environment; they are not an installer.

| File | Purpose |
| --- | --- |
| [agent-remnote-write-bridge.service](agent-remnote-write-bridge.service) | Starts an already-built Agent Runtime SDK bridge. |
| [remnote-mcp-proxy.service](remnote-mcp-proxy.service) | Starts the proxy after the runtime bridge. |
| [cloudflared-remnote.config.yml](cloudflared-remnote.config.yml) | Optional Cloudflare routing example for the proxy's MCP endpoint. |

## Service configuration

The service templates target a systemd user session. Copy the adapted units into that user's `~/.config/systemd/user/` directory. They assume Node is available at `/usr/bin/node`.

Before enabling them, set:

- The checkout and runtime paths in `WorkingDirectory` and `ExecStart`.
- `REMNOTE_DB` to the database for the currently open knowledge base.
- Endpoint overrides if your built-in MCP or runtime uses different addresses.
- Authentication-file overrides if the service user's home does not contain the default files.

The account running the services needs access to the active RemNote database and authentication files. RemNote Desktop must already be running with its MCP endpoint enabled. The bridge template starts the compiled runtime; it does not build it.

After saving the adapted units:

```sh
systemctl --user daemon-reload
systemctl --user enable --now agent-remnote-write-bridge.service
systemctl --user enable --now remnote-mcp-proxy.service
systemctl --user status remnote-mcp-proxy.service
```

See the [configuration table](../README.md#configuration) for defaults and overrides. Store credentials outside the repository.

## Remote access

For ChatGPT, use the [step-by-step integration guide](../docs/CHATGPT.md), including private tunnel setup and authentication.

The proxy binds to loopback by default and requires bearer-token authentication. Choose a transport compatible with your MCP client and preserve that authentication requirement.

The optional Cloudflare file contains example domains, an all-zero tunnel identifier and a placeholder credentials path. Replace them with your own values if using Cloudflare. Both example hostnames route to the **proxy** on port 7789; neither directly exposes the SDK runtime. The file only describes routing—it does not provision a tunnel or configure client authentication.

## Update and verify

Commit changes before deployment and create a tag for the version you are about to replace:

```sh
git tag checkpoint-before-update
```

Use a unique tag name for each update. From a clean working tree, install the intended committed version, run `npm test`, and restart the proxy:

```sh
systemctl --user restart remnote-mcp-proxy.service
systemctl --user is-active remnote-mcp-proxy.service
```

Then run the [live validation checks](../README.md#validation). A running service alone does not establish that edits work through the SDK. Refresh the client's tool catalog if tool schemas changed.

## Roll back

From a clean working tree, create a branch at your saved checkpoint:

```sh
git switch -c rollback-proxy checkpoint-before-update
systemctl --user restart remnote-mcp-proxy.service
systemctl --user is-active remnote-mcp-proxy.service
```

Use a new branch name for each rollback and repeat the relevant validation checks. Refresh the client's catalog when reverting tool schemas.

The repository also retains historical rollback tags. In particular, `before-flashcard-safety` predates the guarded editing tools; restoring it removes those protections. Prefer the checkpoint for your own last working deployment. Public history was sanitized, so its commit identifiers differ from those of the original private checkout.

Git checkpoints restore the proxy code. They do not restore deleted notes or undo edits in RemNote.


## Creation request state

Version 0.8.0 needs a writable, persistent proxy-owned SQLite journal for creation retry protection. The default is under the service user's `~/.local/state/remnote-mcp-proxy/`; set `REMNOTE_CREATION_JOURNAL` to override it. Use a separate journal for each knowledge base and share it among proxy instances serving that same knowledge base. Never point it at `remnote.db`. Do not place it in a temporary release directory or commit it to Git.

Keep the journal through service restarts, upgrades and code rollbacks. Back it up using SQLite's backup facility (or while the proxy is stopped). Restoring an older journal can lose completed-request receipts and allow duplicate creation; reconcile requests before accepting retries after such a restore. The journal does not back up note content.

After deploying, run the existing smoke test and `REMNOTE_DB=/absolute/path/to/remnote.db MCP_PROXY_URL=http://127.0.0.1:7789/mcp node scripts/smoke-create-flashcards.mjs`. The latter creates and removes only its own temporary fixtures. Verify the current catalog (40 tools in 0.10.0), then refresh the client with the user's approval.

The same persistent journal also protects `move_flashcards` retries under a separate request namespace. For 0.10.0, additionally run `scripts/smoke-move-flashcards.mjs` with the same database/proxy environment. It relocates only its own temporary fixtures and verifies cleanup. Keep distinct Git checkpoints for creation, listing and moving if deploying incrementally.

Version 0.11.0 shares that persistent journal with typed `update_flashcard` requests in a separate operation namespace. Run `scripts/smoke-update-flashcards.mjs` with the same database/proxy environment before and after deployment; omit `MCP_PROXY_URL` to test a candidate handler. Create a committed checkpoint before this upgrade, keep the journal when rolling back, and refresh the client catalog after changing the schema. Typed updates add multiline editing and retained history/schedule verification; [the update guide](../docs/UPDATING.md) documents explicit leaf deletion, direction changes and recovery.

## Image support upgrade

Version 0.12.0 adds native MCP image content and a 41-tool catalog. Run `scripts/smoke-images.mjs` with the same environment as the existing live tests; it requires write access to its own synthetic fixture in the runtime's managed-media directory. It verifies pixels through the proxy as well as SDK image writes, stale/retry guards and cleanup. The [image guide](../docs/IMAGES.md) explains media roots, hosted retrieval, limits and test behavior. Preserve the prior committed deployment and operation journal, run both the image and existing regression smoke tests, then refresh the client catalog with approval.

## Formatting upgrade

Version 0.13.0 extends the creation/update schemas without changing the 41-tool count. Run `scripts/smoke-formatting.mjs` with the database/proxy environment and retain the existing image and card regression checks. Preserve the previous committed release and operation journal, verify the deployed schemas, and refresh the client catalog with approval. See [formatting](../docs/FORMATTING.md) for limits and fixture behavior.
