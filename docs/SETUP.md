# First-time setup

This is the complete source-install path for the proxy's tested Linux setup. Use one computer and one operating-system account for RemNote Desktop, the bridge, the runtime and the proxy. A computer running these services must stay awake for ChatGPT to reach them.

## Compatible components

| Component | Setup used here |
| --- | --- |
| Node.js | 24 or newer; the source build was checked with Node 24. |
| pnpm | 11.19.0, as pinned by the runtime's `packageManager` field. |
| RemNote Desktop | 1.28.0 for the proxy's current native-label adapter. |
| Agent Runtime and Agent Bridge | 0.20.3 from the same pinned source revision below. |
| This proxy | 0.3.0 |

The independent [RemNote Agent Runtime](https://github.com/Gabriel7w7r/remnote-agent-runtime) supplies both the SDK server and the RemNote plugin. Use those two components together. Installing a similarly named marketplace bridge or the separate `remnote-mcp-server` npm package is not the installation path tested for this proxy.

Runtime source used here: [`42ef1bec0808649b926581896f2bd32ed2a63d28`](https://github.com/Gabriel7w7r/remnote-agent-runtime/tree/42ef1bec0808649b926581896f2bd32ed2a63d28). The dependency installation and build below were checked in a fresh checkout. Its server, bridge and protocol source match the existing working installation. A new user's RemNote login, plugin loading and pairing still need the local verification steps below.

## 1. Prepare RemNote and Node

Install Git and Node.js 24+ using your preferred package manager. With Node and npm available, install the runtime's pinned pnpm version if needed:

```sh
npm install --global pnpm@11.19.0
```

Check the versions:

```sh
node --version
pnpm --version
```

Open RemNote Desktop and your intended knowledge base. In **Settings → Desktop App → MCP Server**, enable the built-in MCP server. Choose **Read and write** for the full proxy workflow. The [official RemNote setup guide](https://help.remnote.com/en/articles/16424066-connecting-ai-agents-to-remnote-with-mcp) explains this setting and where to find the built-in connection details.

The built-in MCP access mode controls upstream tools. The Agent Bridge has separate permissions for SDK writes; changing the built-in server to read-only is not a global read-only switch for this proxy.

Keep RemNote open. Its setup prompt contains a token, so do not include it in screenshots, issues or committed files.

## 2. Build the runtime and bridge

From a working directory of your choice:

```sh
git clone https://github.com/Gabriel7w7r/remnote-agent-runtime.git
cd remnote-agent-runtime
git checkout --detach 42ef1bec0808649b926581896f2bd32ed2a63d28
pnpm install --frozen-lockfile
pnpm build
```

This builds the server into `packages/server/dist/`, the plugin into `packages/bridge/dist/`, and a plugin archive at `packages/bridge/PluginZip.zip`. The upstream repository retains some older package-specific documentation; use this pinned monorepo build for this guide.

In this terminal, start the runtime:

```sh
node packages/server/dist/index.js
```

Keep it running. It listens locally on port 3001 for MCP and port 3002 for the bridge. On first startup it creates its private authentication state under `~/.remnote-agent/`.

## 3. Load the bridge into RemNote

Open a second terminal in the **runtime repository**, then serve the built plugin:

```sh
node packages/bridge/scripts/serve-dist.js --port 8080
```

In RemNote:

1. Open **Settings → Plugins → Build**.
2. Choose **Develop from localhost**.
3. Enter `http://localhost:8080/` and load the plugin.
4. Confirm that **RemNote Agent Bridge** is enabled.
5. Open its panel in the right sidebar. Its WebSocket URL should be `ws://127.0.0.1:3002`.

Keep the plugin's local server running whenever this development installation is in use. It serves only the built plugin files; it is separate from the runtime and proxy.

The bridge should request pairing. Complete that in step 5 after cloning the proxy. If a different bridge already owns this runtime connection, stop and resolve the duplicate installation before pairing another one.

## 4. Get the proxy

In a third terminal, return to the parent working directory and clone this repository:

```sh
git clone https://github.com/Samuelk0nrad/remnote-mcp-proxy.git
cd remnote-mcp-proxy
npm test
```

The proxy has no third-party runtime dependencies, so it needs no separate dependency installation to run.

## 5. Pair the bridge

From the **proxy repository**, run this local read-only pairing-status request as the same user that started the runtime:

```sh
node --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntimeMcpRunner } from './src/server.mjs';

const authPath = path.join(os.homedir(), '.remnote-agent', 'auth.json');
const { httpToken } = JSON.parse(await readFile(authPath, 'utf8'));
const run = createRuntimeMcpRunner({ token: httpToken });
console.log(JSON.stringify(await run('remnote_pairing_status', {}), null, 2));
JS
```

Enter the returned one-time `pairingCode` in the RemNote Agent Bridge panel and complete pairing. Run the status request again and confirm `paired` and `authenticated` are true. If no code is present, confirm that the plugin has attempted to connect; if the code expired, reconnect the plugin and request status again.

The status output contains a temporary pairing credential. Keep it local. The request reads the runtime bearer token from its private file without displaying it.

For editing, enable **Accept write operations** in the bridge settings and review the permissions granted during pairing. The runtime and bridge enforce their own capability scopes. This proxy does not bypass them.

## 6. Select the database and start the proxy

Find the `remnote.db` belonging to the knowledge base currently open in RemNote. On Linux, RemNote's local data folders are commonly under `~/remnote/`; layouts can vary. A read-only filename search can help:

```sh
find "$HOME/remnote" -type f -name remnote.db
```

To inspect the active knowledge-base identity, repeat the local script from step 5 with its final line replaced by:

```js
console.log(JSON.stringify(await run('remnote_knowledge_base', { operation: 'current' }), null, 2));
```

Match the returned identity to the knowledge-base folder containing the database. If the layout does not make that mapping clear, resolve it before starting the proxy. Do not pick an arbitrary database or copy it to this repository. The live SDK, built-in MCP and database must refer to the same knowledge base.

From the proxy checkout, set your paths and run:

```sh
export REMNOTE_DB=/absolute/path/to/active/remnote.db
export REMNOTE_APP_ASAR=/absolute/path/to/RemNote/resources/app.asar
npm start
```

`REMNOTE_APP_ASAR` is needed for native-label validation when the installed archive differs from the default `/opt/remnote/app/resources/app.asar`. The proxy reads the default authentication files described in the [configuration table](../README.md#configuration).

## 7. Verify, then connect ChatGPT

In another terminal in the proxy checkout, set the same database and archive paths and follow the [live validation instructions](../README.md#validation). The label check is read-only; the smoke test creates and removes its own temporary notes. A successful unit test alone does not verify plugin pairing or live edits.

Then follow the [ChatGPT integration guide](CHATGPT.md). Tunnel traffic must target the proxy on **7789**, while its local health dashboard uses **8081** in that guide to avoid the plugin server on **8080**.

Once the foreground setup works, use the [service examples](../deploy/README.md) if you want background processes. Those examples start only the runtime and proxy; the plugin file server and tunnel client also need to remain running for this setup.

## Ports at a glance

| Local port | Process |
| --- | --- |
| 7788 | RemNote Desktop's built-in MCP |
| 3001 | Agent Runtime MCP |
| 3002 | Agent Runtime bridge WebSocket |
| 8080 | Agent Bridge plugin files |
| 7789 | This proxy's MCP endpoint |
| 8081 | Tunnel client's local health dashboard in our example |

These are local endpoints. Keep the runtime, WebSocket and plugin file server on loopback; the ChatGPT guide connects only the proxy through the private tunnel.
