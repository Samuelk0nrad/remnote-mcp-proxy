# Images in flashcards

Version 0.12.0 adds `get_flashcard_image` and extends reading, creation, updating and listing. The catalog contains 41 tools. Basic and multiline cards can contain images; image-occlusion creation/editing is not included.

## Find and inspect images

1. Use `list_flashcards` with `filters: { "has_images": true }`, optionally within `root_rem_id`.
2. Read a result with `read_flashcard`. Its `images` array lists each image occurrence with `image_id`, owner `rem_id`, `side`, location (`question`, `answer_item` or `context`), rich-text element index, source and stored metadata. Dimensions and titles can be missing or outdated.
3. Pass the **image owner's** Rem ID and image ID to `get_flashcard_image`:

```json
{
  "rem_id": "OWNER_REM_ID",
  "image_id": "COPY_IMAGE_ID_FROM_READ",
  "max_bytes": 5242880
}
```

The response contains an MCP `image` content block with base64 pixels and a separate JSON metadata block. It does not merely return a URL. Whether the client displays or supplies that image to its model depends on the client's support for MCP image content. The proxy follows the [MCP image-content format](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#image-content).

Image IDs identify a particular stored occurrence, not a global media file. They remain stable while the owner, side, element index and image node are unchanged. A changed or moved image requires a new read. Retrieval checks that the occurrence still exists before and after reading its pixels. A hosted URL's remote bytes may change independently of the Rem revision.

The list's `image_count` and `has_images` include the question's front/back and recursively marked child answers. They exclude unmarked context notes, portals, referenced notes and occlusion masks. Sort or filter on numeric `image_count`; ranking still happens before pagination. `read_flashcard` additionally discovers images in its inspected direct context notes. These tools enumerate stored inline image nodes, not every visual element that might appear in practice.

## Create cards with images

Use `front_images` and, for a basic card, `back_images`. For multiline answers, use `back.items[].images`. Each list appends images after the field's text content in the supplied order. Text must remain nonblank on creation. Source/context notes accept plain strings or [formatted text spans](FORMATTING.md).

```json
{
  "parent_rem_id": "HEADING_REM_ID",
  "request_id": "new-image-batch-001",
  "cards": [
    {
      "type": "basic",
      "front": "Which process does this diagram show?",
      "front_images": [
        { "url": "https://example.org/diagram.png", "width": 640, "height": 480 }
      ],
      "back": "The process illustrated in the diagram."
    },
    {
      "type": "multiline",
      "front": "Explain these stages.",
      "back": {
        "items": [
          {
            "text": "First stage",
            "images": [
              { "source_rem_id": "IMAGE_OWNER_REM_ID", "image_id": "COPY_IMAGE_ID_FROM_READ" }
            ]
          }
        ]
      }
    }
  ]
}
```

An image source is **either** a public HTTPS `url` with optional width/height, **or** `source_rem_id` plus `image_id` to reuse an existing stored image. Reuse copies the image node, retaining its URL and metadata; it does not duplicate or upload the underlying file. Each field supports up to 10 images, and a creation batch supports at most 40. Existing limits on card count, child count and serialized request size still apply. Read created cards for their new image IDs.

The SDK builds image nodes and writes them through the existing card creation path. Hosted URLs are stored as links; creation verifies the stored structure, not the URL's availability or its rendered appearance. Use the image reader to check retrieval. There is no supported SDK upload method in the installed version, so this release does not accept local paths, attachments or base64 as new image sources and does not promise RemNote cloud hosting or cross-device availability for a local source. Host a new file at an appropriate HTTPS location or import it into RemNote normally first.

## Update an existing card

Read first, then send `image_changes` with the current revision and a unique retry key:

```json
{
  "rem_id": "QUESTION_REM_ID",
  "expected_revision": "COPY_REVISION_FROM_READ",
  "request_id": "replace-card-image-001",
  "image_changes": [
    {
      "action": "replace",
      "side": "front",
      "image_id": "COPY_IMAGE_ID_FROM_READ",
      "image": { "url": "https://example.org/corrected-diagram.png" }
    }
  ]
}
```

- `add`: requires `image`, forbids `image_id`. Optional `position` is an index in the side's **rich-text array**, defaulting to its end.
- `replace`: requires an existing `image_id` and an `image`; retains that occurrence's position.
- `remove`: requires an existing `image_id`, forbids `image` and `position`.
- `side` is `front` or `back`. Omit `target_rem_id` for the question. Set it to a surviving **direct multiline answer item's** ID to edit that item's `front`. A multiline question has no inline back image destination.

Up to 20 operations apply in order. Replace/remove refer to the original image occurrences in that request, so earlier removals do not accidentally select a different image. Each occurrence can be replaced or removed once per request. If a simultaneous rich-text edit moves an image to a different element index, perform that text edit and read again before targeting the image.

All omitted images and unrelated rich elements remain intact. Text editing must still preserve structured content through the existing rich-text fields. Image changes do not enable arbitrary rich-node replacement. A deletion cannot leave a question or answer blank. New answer leaves can be created through the existing updater; read their IDs before adding images to those new leaves. Context-note images, nested answer edits, card-type conversion and image-occlusion edits require other workflows.

Image updates retain the question and surviving answer IDs and use the same journal, revision, history and schedule checks as typed text updates. They do not reset spaced repetition. Retry the identical request with the same `request_id`; an uncertain write remains blocked for inspection. Removing an image node does not delete its source media file. An Edit Later marker is not automatically cleared.

## Retrieval limits and network behavior

The reader supports RemNote-managed `%LOCAL_FILE%` images through the runtime's configured media roots, and public HTTPS PNG, JPEG, GIF and WebP URLs. Default and maximum output size is 5 MiB per image; `max_bytes` can lower it to at least 1 KiB. Unsupported schemes, SVG/HTML, missing local files, inaccessible URLs and oversized files return errors without inventing image contents.

Hosted retrieval sends no RemNote tokens, browser cookies or user credentials. It permits HTTPS on the default port, checks public IPv4 DNS results, pins the connection to a checked address, revalidates up to three redirects, bounds download time/bytes and checks file signatures. IPv6-only hosts and private-network destinations are unsupported. The remote host receives a normal image request from the proxy server. File signatures are checked; the proxy does not decode, resize or transcode images.

The retrieved image is the stored source image. It is **not** a screenshot of practice, does not show occlusion overlays or reveal state, and is not evidence that RemNote's rendered card looks correct. Long image-related review times retain the same measurement limitations as other review times.

## Verify and deploy

Run `npm test` offline. With RemNote and the Agent Runtime running, execute as their service user:

```sh
REMNOTE_DB=/path/to/remnote.db \
MCP_PROXY_URL=http://127.0.0.1:7789/mcp \
node scripts/smoke-images.mjs
```

The live test creates only its own temporary notes and a synthetic PNG in the database's sibling `files` directory (`SMOKE_MEDIA_DIR` can override that directory). It checks managed and hosted pixel retrieval, basic/multiline creation, add/replace/remove, retries, stale image IDs, list filtering/sorting, unchanged empty fixture histories/schedules, and cleanup. It retrieves a public Google logo as the hosted-image fixture; it does not send note contents to that host. Synthetic offline tests cover preserved nonempty review history. Omit `MCP_PROXY_URL` to test a candidate handler before deployment.

Follow the [deployment and rollback guide](../deploy/README.md): commit first, preserve the previous deployment and private operation journal, run checks, restart and verify the live proxy, then refresh ChatGPT's catalog after approval. Keep test files and personal snapshots out of Git. The new tool must return native image content through any intermediate tunnel or client; metadata-only success is insufficient.
