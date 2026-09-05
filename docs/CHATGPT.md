# Connect the RemNote proxy to ChatGPT

This guide connects your own running proxy as a personal ChatGPT MCP connection. Publishing the source on GitHub does not host an MCP endpoint or connect anyone to your notes.

## Connection layout

```text
ChatGPT → OpenAI Secure MCP Tunnel → tunnel-client
                                      ↓
                            RemNote proxy :7789/mcp
                               ↙              ↘
                  Built-in MCP :7788    Agent Runtime :3001
```

Point the tunnel at the **proxy**, not directly at RemNote's built-in MCP or the Agent Runtime. Only the proxy adds this repository's guarded flashcard updates and label tools.

## 1. Start the RemNote services

Follow the [first-time setup guide](SETUP.md), or use the [deployment guide](../deploy/README.md) for an installation that is already configured. RemNote Desktop, the SDK runtime and the proxy must be running against the same knowledge base.

Use the proxy's local endpoint, normally `http://127.0.0.1:7789/mcp`, as the tunnel target. Loopback refers to the machine running the tunnel client, so run it alongside the proxy for this example.

## 2. Create a private tunnel

Open [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels), create a tunnel, and associate it with your target ChatGPT workspace and Platform organization. Creating tunnels requires **Tunnels Read + Manage**; running or selecting one requires **Tunnels Read + Use**. ChatGPT developer-mode access is separate.

Install `tunnel-client` using the download linked from those settings. The client needs a runtime API key, outbound HTTPS access to OpenAI, and local access to the proxy. Keep it running during discovery and use. This route does not require opening an inbound public port. See the [official Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

### Supply the proxy's authentication header

There are two separate credentials:

| Credential | Purpose |
| --- | --- |
| OpenAI runtime API key | Authenticates the tunnel client to OpenAI. |
| RemNote MCP token | Authenticates forwarded requests to this proxy and RemNote's built-in MCP. |

The RemNote MCP token is the `remNoteMcpAccessToken` value in the RemNote configuration, unless overridden as described in the [configuration table](../README.md#configuration). It is **not** the Agent Runtime's `httpToken`; the proxy handles that separate SDK connection itself.

Prepare two files outside the repository, readable only by the account running the tunnel:

- `/absolute/path/to/openai-runtime-key`: the OpenAI runtime API key alone.
- `/absolute/path/to/remnote-auth-header`: the complete header value `Bearer YOUR_REMNOTE_MCP_TOKEN`, replacing the placeholder with your actual token.

Do not paste either credential into ChatGPT. Use your secret manager or a private editor to create these files and restrict their permissions, for example with `chmod 600`.

Run the client with your tunnel ID and actual secret-file paths:

```sh
tunnel-client run \
  --control-plane.tunnel-id tunnel_YOUR_TUNNEL_ID \
  --control-plane.api-key file:/absolute/path/to/openai-runtime-key \
  --mcp.server-url 'url=http://127.0.0.1:7789/mcp,channel=main' \
  --mcp.extra-headers 'Authorization: file:/absolute/path/to/remnote-auth-header' \
  --mcp.discovery-extra-headers 'Authorization: file:/absolute/path/to/remnote-auth-header' \
  --health.listen-addr 127.0.0.1:8081
```

These flags were checked against the installed `tunnel-client` 0.0.13 CLI. Check `tunnel-client run --help` for your installed version. The `file:` references keep secret values out of command arguments. Both normal requests and discovery probes need the RemNote header.

Inspect the local readiness endpoint at `http://127.0.0.1:8081/readyz` and the operator UI at `http://127.0.0.1:8081/ui`. For an unattended installation, run this command under a service manager and keep its secret files outside Git. The [existing service examples](../deploy/README.md) cover the RemNote runtime and proxy; they do not start the tunnel client.

## 3. Add the connection in ChatGPT

1. Open **Settings → Security and login** and enable **Developer mode**, if your account or workspace permits it.
2. Open [ChatGPT Plugins](https://chatgpt.com/plugins) and select the **plus** button.
3. Enter a name such as **RemNote** and a description of your personal notes connection.
4. Under **Connection**, choose **Tunnel** and select your tunnel or enter its ID.
5. For this private setup with the RemNote bearer header injected by the tunnel client, choose **No Auth** if the form asks for application authentication.
6. Create the connection and inspect the discovered actions.

“No Auth” here means no additional interactive application login. The proxy still requires its bearer token, and access to the tunnel is controlled separately. This repository does not implement an OAuth authorization server.

The connection steps follow [OpenAI's connect-and-test guide](https://developers.openai.com/plugins/deploy/connect-chatgpt). Interface labels and availability can vary by account or workspace policy.

## 4. Check that ChatGPT sees the proxy tools

Look for these actions in the connection details:

- `read_flashcard`
- `update_flashcard`
- `update_rem_front`
- `get_card_status`
- `list_cards_by_status`

The total number of actions also depends on the upstream RemNote catalog, so check the names rather than requiring a fixed count. You do not add each tool manually; they are discovered from the server's catalog.

Start a new conversation and add the RemNote connection from the tools menu, or select it through `@RemNote` where available. Begin with a read-only request to list leech cards or inspect the Edit Later queue. Confirm that ChatGPT actually calls the matching tool and receives a result; a prose answer alone does not verify the connection.

For a write check, use a disposable card that you create for testing. Change only its answer, then verify the front and back in RemNote. The expected sequence is `read_flashcard` followed by `update_flashcard`, using the returned Rem ID and revision. See [the editing workflow](../README.md#edit-a-flashcard) for the separate side fields and verification result.

## 5. Refresh after tool changes

After deploying a version that changes tool schemas:

1. Open the RemNote connection in ChatGPT Plugins.
2. Select **Refresh**.
3. Confirm the expected action names and fields appear.
4. Start a new conversation and repeat the relevant check.

Restarting the server alone does not refresh the connection's saved metadata. This developer-mode workflow is documented in [OpenAI's metadata refresh instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Tunnel is missing from ChatGPT | Target workspace association and the creator's tunnel permissions. |
| Connection is offline | Tunnel client readiness, then RemNote, runtime and proxy service health. |
| Unauthorized response from the proxy | The header file must contain `Bearer ` followed by the same MCP token the proxy expects. Check both header flags and file readability. |
| Only built-in RemNote actions appear | The tunnel may target port 7788 instead of the proxy on 7789. Correct the target and refresh. |
| New tools or revision fields are missing | Deploy the current proxy, refresh the connection, and use a new conversation. |
| Reads work but edits fail | Check SDK runtime availability and authentication. A working built-in MCP endpoint does not establish that the SDK bridge works. |
| Label tools report an unsupported adapter | Check the RemNote version and `REMNOTE_APP_ASAR`; the current adapter is pinned to the version described in the main README. |
| An edit reports a stale revision or uncertain result | Read the card again. Do not retry with an old revision or assume a failed multi-side edit changed nothing. |

## Public HTTPS alternative

Secure MCP Tunnel is for private connections, not public plugin distribution. OpenAI requires a stable public HTTPS MCP endpoint for public plugin submission. See the [official tunnel guidance](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

The optional Cloudflare file in this repository only supplies routing. It does not adapt this proxy's static bearer authentication into ChatGPT's interactive OAuth flow. A publicly reachable URL by itself is therefore not a complete integration for this proxy. Keep the personal tunnel setup above unless you also implement and verify an appropriate authenticated public gateway.

## Study and unchanged-review tools

After updating to proxy 0.4.0, refresh the catalog to discover `keep_edit_later_item`, `get_study_workload`, and `list_card_review_stats`. See the [usage examples and count definitions](../README.md#study-activity-and-workload).

Try asking ChatGPT to summarize today's graded reviews in your timezone, compare the outlines of two topic documents, or show how often individual cards were reviewed. For an already correct Edit Later item, it should read the content and feedback, explain its assessment, then use the unchanged-review tool with both fresh revisions. A no-op text update still does not issue a correction token.

Review counts and schedule candidates answer different questions. ChatGPT should retain the response's coverage limits and avoid calling stored schedule candidates the exact RemNote queue.

Proxy 0.5.0 adds `get_card_review_history`, `get_review_difficulty_trends`, `compare_study_topics`, and `get_study_workload_forecast`. Refresh the catalog after updating. These work with any subject or material. Timeline defaults to 30 study dates; trends and comparisons default to 14. Ask for a particular range when that distinction matters. See the [rating definitions, sample-size rules and forecast limitations](../README.md#review-timeline-and-difficulty-patterns).

Proxy 0.5.1 corrects child-answer detection in `read_flashcard` without adding tools (the catalog remains 37). Refresh the catalog to load the updated description. Ask ChatGPT to inspect `answer_items` and `answer_inspection` before treating an empty inline back as a missing answer. Marked child answers are included in revision checks; they cannot be flattened through the basic-card updater. This read does not verify the rendered practice screen. See [supported cards and editing limits](../README.md#supported-cards-and-editing-limits).

### Timing analytics

Proxy 0.6.0 extends five existing analytics tools with recorded timing data. Refresh the catalog to load their updated descriptions and optional `max_review_seconds` parameter; there are still 37 tools. No duration cutoff is applied unless the agent supplies one. Ask for raw and filtered results, excluded review counts/time, median and quartiles, and timing by rating. A long review does not prove a pause. See the [timing reference](TIMING.md).

Proxy 0.7.0 adds separate reveal-offset summaries and trends under `timing.reveal` and `timing.change.reveal`, plus optional `max_reveal_seconds`. Refresh the same 37-tool catalog to load this parameter. The existing response-time fields stay compatible. Thresholds filter each measurement independently, with raw and filtered statistics visible; samples can differ. Neither measurement proves active recall, and their totals must not be added.


### Creating cards in the right section

Proxy 0.8.0 adds `create_flashcards`; refresh the catalog to load all 38 tools. Ask ChatGPT to read the outline, select the exact destination heading, and use this tool instead of appending card-formatted Markdown to a document. Each card has a type, separate answer structure, and a supported direction. Reuse the same request key and arguments after a timeout. A replay is the original receipt, not a fresh content inspection. See the [creation guide](CREATION.md).
