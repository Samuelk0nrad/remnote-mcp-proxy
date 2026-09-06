# Formatting flashcard text

Version 0.13.0 allows explicit **bold**, *italic* and underline formatting in both `create_flashcards` and `update_flashcard`. The catalog remains at 41 tools. This works for question fronts, basic backs, multiline answer items and source/context notes. The same content structure works across subjects.

A text value can be a literal string or an object containing `spans`:

```json
{
  "spans": [
    { "text": "Important term", "formats": ["bold"] },
    { "text": " — an explanation in normal text." },
    { "text": " Extra emphasis", "formats": ["italic", "underline"] }
  ]
}
```

Omitted `formats` or an empty array means normal text. All three formats can be combined. A whole line can be bold by putting its entire text in one bold span. Spaces and punctuation are literal and must be included in the spans; `**Markdown**`, HTML, arrows and card separators are not parsed.

## Create a multiline card

```json
{
  "parent_rem_id": "HEADING_REM_ID",
  "request_id": "formatted-card-001",
  "cards": [
    {
      "type": "multiline",
      "front": "Explain the process.",
      "back": {
        "items": [
          {
            "text": {
              "spans": [
                { "text": "First stage", "formats": ["bold"] },
                { "text": ": the initial change." }
              ]
            }
          },
          { "text": "Second stage: the consequence." }
        ]
      }
    }
  ]
}
```

Use the same content object in `front`, a basic `back`, `back.items[].text`, or a `notes` entry. Existing plain-string inputs remain supported. Image arrays append after this text as before. Creation never accepts preservation references because there is no existing side to reference.

## Update and preserve embedded content

Read with `read_flashcard` first. The response adds `front_content` and `back_content` span views to the question, marked answer items and inspected direct context items. These are editable views of the corresponding rich-text arrays. The original arrays remain available. Empty sides can have an empty span view; writing a blank question or answer is still refused.

Plain strings and SDK bold/italic/underline text nodes become text spans. Images, references, links, clozes, colored text and unknown structures become `{ "preserve_element": index }`. Each index refers to the **original rich-text array of that exact side or item** in the same fresh read. Copy it rather than guessing.

For example, if a side contains normal text at index 0 and an image at index 1:

```json
{
  "rem_id": "QUESTION_REM_ID",
  "expected_revision": "COPY_CURRENT_REVISION",
  "request_id": "bold-question-001",
  "front": {
    "spans": [
      { "text": "New bold question", "formats": ["bold"] },
      { "preserve_element": 1 }
    ]
  }
}
```

Every embedded or unsupported element must appear exactly once and in its original relative order. The tool copies the exact node, preserving its data. Omitting, duplicating, reordering or inventing a protected element is rejected before writes. Text can be split into different spans and its supported styles can change. A preservation reference can also keep an existing supported text element unchanged.

To remove bold, supply that text in a span without `bold`; this is an explicit formatting change. Plain-string updates retain their existing protection against flattening rich content. Legacy `front_rich_text`, `back_rich_text` and item `rich_text` still require preserving their original structured nodes and formatting; use the span interface for new formatting changes. Never supply both a content value and its raw rich-text replacement field.

Multiline updates still use the complete `back.items` list, preserving every surviving answer item exactly once. Set `rem_id` on existing items to identify them when reordering; new items may also contain formatted text. Removed leaves still require explicit deletion lists. Context notes retain their positional identity rules and cannot be used to rewrite independent child cards. Basic/multiline type conversion, nested-answer replacement and cloze/multiple-choice editing remain unsupported.

Formatting and `image_changes` may be combined when the targeted image's identity and element index have not moved during the text change. Otherwise finish the formatting update, read again and use the new image ID. No image is silently removed by text formatting.

## Safeguards and limits

- At most 100 spans per content field and 200 spans per create batch or update.
- At most 50,000 text characters per content field; spans must contain nonempty text, and the complete content must be nonblank.
- Existing batch, serialized-size, child-count and image limits remain in force.
- Formatted updates require a fresh revision and `request_id`, even if `type` is omitted. Reuse the same arguments and key after a timeout; uncertain requests remain blocked for inspection.
- Formatting uses the SDK's text builder and existing verified writes. It retains Rem and answer IDs and verifies retained review history and schedules. It does not reset spaced repetition or automatically clear Edit Later.
- Supported text formatting is bold, italic and underline. Other formatting and non-text nodes are preserved, not transformed. This is not a Markdown importer or a general rich-document editor.

## Verification and deployment

Run `npm test` offline. With RemNote and the Agent Runtime running, execute as their service user:

```sh
REMNOTE_DB=/path/to/remnote.db \
MCP_PROXY_URL=http://127.0.0.1:7789/mcp \
node scripts/smoke-formatting.mjs
```

The live check creates only its own disposable cards and verifies selective/combined styles, formatting removal, multiline creation/updates, new formatted answers, source notes, image preservation, refusal to drop embedded content, literal separators, retries, existing IDs, empty fixture histories/schedules and cleanup. Offline fixtures verify nonempty history preservation. The check inspects stored SDK formatting, not a screenshot of the practice renderer. Omit `MCP_PROXY_URL` to test a candidate before deployment.

Follow the [deployment and rollback procedure](../deploy/README.md). Commit before deployment, retain the previous Git checkpoint and private operation journal, verify the live proxy, then refresh ChatGPT's catalog with approval to load the updated schemas. See also [creation](CREATION.md), [updating](UPDATING.md) and [images](IMAGES.md).
