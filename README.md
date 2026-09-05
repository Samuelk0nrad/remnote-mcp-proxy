# RemNote MCP proxy

This local proxy preserves RemNote Desktop's built-in MCP tools and adds the missing Edit Later workflow:

- `get_edit_later_queue`
- `update_rem`
- `resolve_edit_later_item`

Queue reads open `remnote.db` read-only. Writes never modify that database directly; they are sent through `agent-remnote` to a RemNote plugin using the official plugin SDK.

The write bridge is pinned to `agent-remnote` 1.6.0 as a local dependency. Install its bundled `node_modules/agent-remnote/plugin-artifacts/PluginZip.zip` in RemNote under **Settings > Plugins > Developer > Install From Zip**, then start its daemon.

Required environment:

```text
REMNOTE_DB=/absolute/path/to/remnote.db
```

Optional environment:

```text
HOST=127.0.0.1
PORT=7789
REMNOTE_UPSTREAM_URL=http://127.0.0.1:7788/mcp
REMNOTE_MCP_TOKEN=...
```

When `REMNOTE_MCP_TOKEN` is omitted, the proxy reads the current token from `~/.config/RemNote/config.json`.

Run locally:

```bash
npm test
npm start
```
