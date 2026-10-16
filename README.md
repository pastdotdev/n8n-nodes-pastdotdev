# n8n-nodes-pastdotdev

This is an n8n community node for [past dev](https://past.dev).

past dev is a memory API for AI agents. You ingest data points (messages, tickets, notes, call
transcripts), and past dev turns them into memories that keep their sources and their dates. Then
you recall the memories that answer a query, for one person.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/)
workflow automation platform.

- [Installation](#installation)
- [Credential](#credential)
- [Operations](#operations)
- [Identity](#identity)
- [Use with the AI Agent node](#use-with-the-ai-agent-node)
- [Example workflows](#example-workflows)
- [Errors and credits](#errors-and-credits)
- [Compatibility](#compatibility)
- [Resources](#resources)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in
the n8n documentation. The package name is `n8n-nodes-pastdotdev`.

In n8n, open **Settings > Community Nodes**, select **Install**, and enter `n8n-nodes-pastdotdev`.

## Credential

The node uses one credential, **Past Dev API**.

1. Open the past dev console and create a project API key. The key starts with `past_sk_`. The
   [quickstart](https://past.dev/docs/memory-api/quickstart) shows how.
2. In n8n, add a **Past Dev API** credential.
3. Paste the key into **API Key**.
4. Keep **API Host** at `https://api.past.dev`. Change it only when past dev runs in your own cloud.

The node sends the key as `Authorization: Bearer <key>`. The credential test lists the audiences of
the project (`GET /api/v1/audiences`). The test spends no credits.

A project key reaches one project. To use a different project, add a different credential.

## Operations

The node has one resource, **Memory**, with three operations.

### Ingest

Sends one data point to memory (`POST /api/v1/ingest`). past dev processes it in the background,
and the node returns the receipt: `ingestionId`, `sourceId` and `status`.

| Field | API key | Notes |
| --- | --- | --- |
| Content | `content` | Required. The original text, not a summary. |
| Identity | `identity` | The person who wrote the content. past dev adds the identity the first time it sees it. The identity does not limit who can read the data point. |
| Audience | `audience` | The audience that can read the data point. Without it, every identity of the project can read it. |
| Source ID | `id` | Your own stable ID. A second ingest with the same ID makes a new revision of the same data point. **Delete Data Point** uses this ID. Without it, past dev uses the SHA-256 of the content. |
| Occurred At | `timestamp` | When the content occurred, in ISO 8601 with a zone, for example `2026-07-28T16:00:00Z` or `{{ $now.toISO() }}`. Without it, past dev uses the time of the request. |
| Label | `label` | A short title. Recall returns it with the source. |
| Metadata | `metadata` | Your own JSON. Recall returns it as it was sent. |
| Idempotency Key | `idempotencyKey` | A replay key. Set **Occurred At** with it, so that a retry sends the same body. |

### Recall

Retrieves the ranked memories that answer a query, for one identity (`POST /api/v1/recall`).

| Field | API key | Notes |
| --- | --- | --- |
| Query | `query` | Required. The question or the words to look for. |
| Identity | `identity` | Required. The person the recall is for. Recall reads the memory of the project and of each audience this identity is in. |
| Limit | `limit` | Max number of results. |
| Level | `level` | The evidence budget: Low (about 8,000 tokens), Medium, High or Extra High. The plan can lower it. |
| Max Tokens | `maxTokens` | An exact evidence budget. Set **Level** or **Max Tokens**, not both. |
| Query Time | `queryTimestamp` | Read memory as it was at this time. |
| Occurred From, Occurred To | `occurredFrom`, `occurredTo` | Only memories that occurred in this window. |
| Sort | `sort` | Relevance (default) or Chronological. |

The output is one item: the API response (`asOf`, `usedEvidenceTokens`, `results`) plus a field
`context`. `context` is one flat text with each memory, its date and its sources, ready to put in
the prompt of a model:

```
Memories recalled from past.dev, most relevant first. ...

<memories as_of="2026-10-16T10:00:00Z">
1. (2026-07-28T16:00:00Z, claim) Acme pilot budget: currently 40k.
   Source ticket-4821 (2026-07-28T16:00:00Z, Email from Nadia): "Budget for the Acme pilot moved to 40k."
</memories>
```

When nothing matches, `results` is empty and `context` is an empty string.

### Delete Data Point

Deletes one data point by its source ID, and the memory made from it
(`DELETE /api/v1/data-points/{sourceId}`). The node returns `{ "deleted": true, "sourceId": ...,
"operationId": ... }`. The deletion completes in the background.

## Identity

An identity is the ID of one person in your product: a user ID, an email, a customer ID. Recall
requires an identity, and it returns only the memory that this identity can read.

Set the identity from data you trust: the trigger, the user record, the session of the app. For
example, `{{ $json.userId }}` or `{{ $('Webhook').item.json.body.userId }}`. In the **Identity**
field, choose **By ID** and enter the expression, or choose **From List** to pick an identity that
past dev already knows.

## Use with the AI Agent node

The node can be a tool of the **AI Agent** node. Add it under **Tools**, and choose the operation.

> **Warning:** Never let the model choose the identity. Do not use `$fromAI()` or the "Let the model
> define this parameter" button for **Identity**. Set **Identity** with an expression from the
> trigger, for example `{{ $('Webhook').item.json.body.userId }}`. If the model sets the identity,
> a prompt can make the agent read the memory of a different person.

Let the model set only the fields that are the model's to choose, for example the query of Recall:

| Field | Value in tool mode |
| --- | --- |
| Query | `{{ $fromAI('query', 'The question to look up in memory', 'string') }}` |
| Identity (By ID) | `{{ $('Webhook').item.json.body.userId }}` |

The same rule holds for **Ingest**: set **Identity** and **Audience** from the trigger, and let the
model set only **Content**.

## Example workflows

The folder [`examples/`](examples/) has three workflows. To use one, open n8n, create a workflow,
and paste the file contents into the canvas (or select **Import from File**). Then select your
**Past Dev API** credential in each past dev node.

- [`ingest-from-webhook.json`](examples/ingest-from-webhook.json): a webhook receives a message
  (`userId`, `messageId`, `text`, `sentAt`) and ingests it, with the source ID and the time of the
  message.
- [`ai-agent-with-recall.json`](examples/ai-agent-with-recall.json): a webhook receives a question
  from a user. An AI Agent answers with past dev Recall as its tool (the identity comes from the
  webhook, the query from the model), and the exchange is then ingested for the same identity.
- [`delete-data-point.json`](examples/delete-data-point.json): a webhook receives a source ID and
  deletes that data point.

## Errors and credits

Each Ingest and each Recall spends credits of your past dev organization. The credential test and
the dropdown lists spend none.

When past dev refuses a request, the node shows the code of the API (for example `out-of-credits`
or `recall-range-invalid`), its message, and the request ID (`X-Request-Id`). Give the request ID
when you contact past dev about a request.

- The node does not retry a request. A 400 or a 402 (`out-of-credits`) fails the same way when you
  send it again.
- A 429 means too many requests. The message gives the `Retry-After` time when past dev sends one.
  To retry, turn on **Retry On Fail** in the node settings, with a wait of a few seconds.
- Turn on **Continue On Fail** to keep the workflow running. Each item that fails then returns
  `{ "error": "..." }`.

## Compatibility

Tested with n8n 2.43. The node uses the n8n nodes API version 1 and has no runtime dependencies.

## Resources

- [past dev](https://past.dev)
- [Quickstart](https://past.dev/docs/memory-api/quickstart)
- [API reference](https://past.dev/docs/memory-api/api-reference)
- [OpenAPI document](https://past.dev/openapi.json)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
- [Privacy](https://past.dev/privacy) and [terms](https://past.dev/terms)

Contact: louis@past.dev

## Development

```bash
npm ci
npm run lint      # n8n-node lint, strict mode
npm test          # build, then the unit tests with a fake n8n context (no network)
npm run scan      # the static checks of @n8n/scan-community-package on the source and the tarball
npm run dev       # start a local n8n on http://localhost:5678 with this node
```

Releases are published to npm from GitHub Actions with provenance (`.github/workflows/publish.yml`).

## License

[MIT](LICENSE)
