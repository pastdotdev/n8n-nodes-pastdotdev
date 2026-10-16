// The past dev node and its credential, run against a fake n8n context: the requests that each
// operation sends, the items it returns and the errors it raises. The tests run against the build
// in dist. Nothing leaves the machine.
const assert = require('node:assert/strict')
const {readFileSync} = require('node:fs')
const {join} = require('node:path')
const {describe, test} = require('node:test')

const {NodeApiError, NodeOperationError} = require('n8n-workflow')

const {PastDev} = require('../dist/nodes/PastDev/PastDev.node.js')
const {PastDevApi} = require('../dist/credentials/PastDevApi.credentials.js')
const {VERSION, MEMORIES_HEADER, formatMemories} = require('../dist/nodes/PastDev/GenericFunctions.js')

const RECALL_PAGE = {
  asOf: '2026-09-22T10:00:00Z',
  usedEvidenceTokens: 18,
  results: [
    {
      id: '39d9d745-c9f4-4884-a602-e538def76815',
      rank: 1,
      occurredAt: '2026-07-28T16:00:00Z',
      content: 'Acme pilot budget: currently 40k.',
      artifact: {id: '9f74f854-d11d-4bc4-bf68-5b2012ac9c15', kind: 'claim', occurredAt: '2026-07-28T16:00:00Z'},
      sources: [
        {sourceId: 'call-8821', occurredAt: '2026-07-28T16:00:00Z', label: 'Email from Nadia', excerpts: ['Budget for the Acme pilot moved to 40k.']},
      ],
    },
    {
      id: '5b0e0c64-2f36-4b8f-9d0a-4f0f2d0c8a11',
      rank: 2,
      occurredAt: '2026-02-03T09:00:00Z',
      content: 'Acme pilot budget: 32k.',
      artifact: {id: '0c1d1f39-0000-4000-8000-000000000000', kind: 'claim', occurredAt: '2026-02-03T09:00:00Z', supersededAt: '2026-07-28T16:00:00Z'},
      sources: [{sourceId: 'call-8820', occurredAt: '2026-02-03T09:00:00Z', excerpts: ['Budget is 32k.']}],
    },
  ],
}
const RECEIPT = {projectId: 1, ingestionId: 'a6f0c9a2-3c1e-4f63-9a51-6f1d1b2e8c10', sourceId: 'call-8821', status: 'queued'}

/**
 * A fake IExecuteFunctions (and ILoadOptionsFunctions). `items` is one parameter object for each
 * input item. `replies` are the responses of httpRequestWithAuthentication, in order:
 * {statusCode, body, headers}, or {throws} for a network failure.
 */
function context({items = [{}], replies = [], credentials = {apiKey: 'past_sk_fake', apiHost: 'https://api.example.test/'}, continueOnFail = false}) {
  const calls = []
  const node = {id: 'n1', name: 'past dev', type: 'n8n-nodes-pastdotdev.pastDev', typeVersion: 1, position: [0, 0], parameters: {}}
  return {
    calls,
    getInputData: () => items.map(() => ({json: {}})),
    getNodeParameter: (name, index, fallback, options) => {
      let value = items[index][name]
      if (value === undefined) {
        if (fallback !== undefined) return fallback
        throw new Error(`no parameter ${name}`)
      }
      if (options && options.extractValue && value && typeof value === 'object' && '__rl' in value) value = value.value
      return value
    },
    getNode: () => node,
    getCredentials: async (type) => {
      assert.equal(type, 'pastDevApi')
      return credentials
    },
    continueOnFail: () => continueOnFail,
    helpers: {
      httpRequestWithAuthentication: async function (type, options) {
        calls.push({type, ...options})
        const reply = replies.shift() ?? {statusCode: 200, body: {}}
        if (reply.throws) throw reply.throws
        return {statusCode: reply.statusCode, statusMessage: '', headers: reply.headers ?? {}, body: reply.body}
      },
    },
  }
}

const run = (ctx) => new PastDev().execute.call(ctx)
const rl = (value, mode = 'id') => ({__rl: true, mode, value})
const ingestItem = (extra = {}) => ({resource: 'memory', operation: 'ingest', content: 'Budget moved to 40k.', identity: rl(''), additionalFields: {}, ...extra})
const recallItem = (extra = {}) => ({resource: 'memory', operation: 'recall', query: 'What is the Acme budget?', identity: rl('user-123'), options: {}, ...extra})
const deleteItem = (extra = {}) => ({resource: 'memory', operation: 'deleteDataPoint', sourceId: 'ticket-4821', ...extra})

describe('description', () => {
  test('the node is past dev, usable as a tool, with the three Memory operations', () => {
    const {description} = new PastDev()
    assert.equal(description.name, 'pastDev')
    assert.equal(description.displayName, 'past dev')
    assert.equal(description.defaults.name, 'past dev')
    assert.equal(description.usableAsTool, true)
    assert.deepEqual(description.credentials, [{name: 'pastDevApi', required: true}])
    const resource = description.properties.find((p) => p.name === 'resource')
    assert.deepEqual(resource.options, [{name: 'Memory', value: 'memory'}])
    const operations = description.properties.find((p) => p.name === 'operation').options
    assert.deepEqual(
      operations.map((o) => [o.name, o.value]),
      [['Delete Data Point', 'deleteDataPoint'], ['Ingest', 'ingest'], ['Recall', 'recall']],
    )
    for (const option of operations) assert.doesNotMatch(`${option.name} ${option.action} ${option.description}`, /remember|save|store|search/i)
  })

  test('the fields of Ingest and Recall use the keys of the API', () => {
    const {description} = new PastDev()
    const ingestKeys = description.properties.find((p) => p.name === 'additionalFields').options.map((o) => o.name)
    assert.deepEqual(ingestKeys.sort(), ['audience', 'id', 'idempotencyKey', 'label', 'metadata', 'timestamp'])
    const recallKeys = description.properties.find((p) => p.name === 'options').options.map((o) => o.name)
    assert.deepEqual(recallKeys.sort(), ['level', 'limit', 'maxTokens', 'occurredFrom', 'occurredTo', 'queryTimestamp', 'sort'])
    const identities = description.properties.filter((p) => p.name === 'identity')
    assert.equal(identities.length, 2)
    assert.deepEqual(identities.map((p) => p.required), [false, true])
  })

  test('the credential sends the key as a bearer and tests it on GET /api/v1/audiences', () => {
    const credential = new PastDevApi()
    assert.equal(credential.name, 'pastDevApi')
    const key = credential.properties.find((p) => p.name === 'apiKey')
    assert.equal(key.typeOptions.password, true)
    assert.equal(key.required, true)
    assert.equal(credential.properties.find((p) => p.name === 'apiHost').default, 'https://api.past.dev')
    assert.deepEqual(credential.authenticate, {type: 'generic', properties: {headers: {Authorization: '=Bearer {{$credentials.apiKey}}'}}})
    assert.equal(credential.test.request.method, 'GET')
    assert.equal(credential.test.request.url, '/api/v1/audiences')
    assert.deepEqual(credential.test.request.headers, {'User-Agent': `n8n-nodes-pastdotdev/${VERSION}`})
  })

  test('the base URL of the credential test removes a slash at the end, and has a default', () => {
    const expression = new PastDevApi().test.request.baseURL
    const match = /^=\{\{(.*)\}\}$/.exec(expression)
    assert.ok(match, expression)
    const evaluate = new Function('$credentials', `return ${match[1]}`)
    assert.equal(evaluate({apiHost: 'https://memory.example.test//'}), 'https://memory.example.test')
    assert.equal(evaluate({apiHost: ''}), 'https://api.past.dev')
    assert.equal(evaluate({}), 'https://api.past.dev')
  })

  test('VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
    assert.equal(VERSION, pkg.version)
  })
})

describe('Memory: Ingest', () => {
  test('sends the content alone when nothing else is set', async () => {
    const ctx = context({items: [ingestItem()], replies: [{statusCode: 202, body: RECEIPT}]})
    const [items] = await run(ctx)
    assert.deepEqual(items, [{json: RECEIPT, pairedItem: {item: 0}}])
    const [call] = ctx.calls
    assert.equal(call.type, 'pastDevApi')
    assert.equal(call.method, 'POST')
    assert.equal(call.url, 'https://api.example.test/api/v1/ingest')
    assert.equal(call.headers['User-Agent'], `n8n-nodes-pastdotdev/${VERSION}`)
    assert.deepEqual(call.body, {content: 'Budget moved to 40k.'})
    assert.equal(call.returnFullResponse, true)
    assert.equal(call.ignoreHttpStatusErrors, true)
  })

  test('sends every field with the keys of the API', async () => {
    const ctx = context({
      items: [
        ingestItem({
          identity: rl('user-123', 'list'),
          additionalFields: {
            id: ' ticket-4821 ',
            label: 'Email from Nadia',
            audience: 'acme',
            idempotencyKey: 'run-77',
            timestamp: '2026-07-28T16:00:00Z',
            metadata: '{"channel":"email","thread":42}',
          },
        }),
      ],
      replies: [{statusCode: 202, body: RECEIPT}],
    })
    await run(ctx)
    assert.deepEqual(ctx.calls[0].body, {
      content: 'Budget moved to 40k.',
      identity: 'user-123',
      id: 'ticket-4821',
      label: 'Email from Nadia',
      audience: 'acme',
      idempotencyKey: 'run-77',
      timestamp: '2026-07-28T16:00:00Z',
      metadata: {channel: 'email', thread: 42},
    })
  })

  test('takes a Date from an expression as the time', async () => {
    const ctx = context({items: [ingestItem({additionalFields: {timestamp: new Date('2026-07-28T16:00:00Z')}})], replies: [{statusCode: 202, body: RECEIPT}]})
    await run(ctx)
    assert.equal(ctx.calls[0].body.timestamp, '2026-07-28T16:00:00.000Z')
  })

  test('refuses empty content, a time with no zone, and a key with no time, before any request', async () => {
    for (const item of [
      ingestItem({content: '   '}),
      ingestItem({additionalFields: {timestamp: '2026-07-28 16:00'}}),
      ingestItem({additionalFields: {idempotencyKey: 'run-77'}}),
      ingestItem({additionalFields: {metadata: '{not json'}}),
    ]) {
      const ctx = context({items: [item]})
      await assert.rejects(run(ctx), NodeOperationError)
      assert.equal(ctx.calls.length, 0)
    }
  })
})

describe('Memory: Recall', () => {
  test('sends the query and the options, and returns the page with a flat context text', async () => {
    const ctx = context({
      items: [recallItem({options: {limit: 20, level: 'medium', sort: 'chronological', occurredFrom: '2026-01-01T00:00:00Z', occurredTo: '2026-12-31T23:59:59Z', queryTimestamp: '2026-09-01T00:00:00+02:00'}})],
      replies: [{statusCode: 200, body: RECALL_PAGE}],
    })
    const [items] = await run(ctx)
    assert.equal(items.length, 1)
    const {context: text, ...page} = items[0].json
    assert.deepEqual(page, RECALL_PAGE)
    assert.equal(text, formatMemories(RECALL_PAGE))
    assert.deepEqual(items[0].pairedItem, {item: 0})
    const [call] = ctx.calls
    assert.equal(call.method, 'POST')
    assert.equal(call.url, 'https://api.example.test/api/v1/recall')
    assert.deepEqual(call.body, {
      query: 'What is the Acme budget?',
      identity: 'user-123',
      limit: 20,
      level: 'medium',
      sort: 'chronological',
      occurredFrom: '2026-01-01T00:00:00Z',
      occurredTo: '2026-12-31T23:59:59Z',
      queryTimestamp: '2026-09-01T00:00:00+02:00',
    })
  })

  test('an empty page gives an empty context text', async () => {
    const ctx = context({items: [recallItem()], replies: [{statusCode: 200, body: {...RECALL_PAGE, results: []}}]})
    const [items] = await run(ctx)
    assert.equal(items[0].json.context, '')
    assert.deepEqual(items[0].json.results, [])
  })

  test('refuses an empty identity, an empty query, and Level with Max Tokens, before any request', async () => {
    for (const item of [
      recallItem({identity: rl('  ')}),
      recallItem({query: ''}),
      recallItem({options: {level: 'low', maxTokens: 4000}}),
      recallItem({options: {occurredFrom: 'yesterday'}}),
    ]) {
      const ctx = context({items: [item]})
      await assert.rejects(run(ctx), NodeOperationError)
      assert.equal(ctx.calls.length, 0)
    }
  })
})

describe('Memory: Delete Data Point', () => {
  test('deletes by source ID and returns deleted: true', async () => {
    const reply = {operationId: '7d1f0c2e-9a3b-4c5d-8e6f-0a1b2c3d4e5f', ids: ['ticket/4821']}
    const ctx = context({items: [deleteItem({sourceId: 'ticket/4821'})], replies: [{statusCode: 202, body: reply}]})
    const [items] = await run(ctx)
    assert.deepEqual(items, [{json: {deleted: true, sourceId: 'ticket/4821', ...reply}, pairedItem: {item: 0}}])
    assert.equal(ctx.calls[0].method, 'DELETE')
    assert.equal(ctx.calls[0].url, 'https://api.example.test/api/v1/data-points/ticket%2F4821')
    assert.equal(ctx.calls[0].body, undefined)
  })

  test('refuses an empty source ID', async () => {
    const ctx = context({items: [deleteItem({sourceId: ' '})]})
    await assert.rejects(run(ctx), NodeOperationError)
    assert.equal(ctx.calls.length, 0)
  })
})

describe('refusals of the API', () => {
  test('a refusal gives a NodeApiError with the code, the message and the request ID', async () => {
    const ctx = context({
      items: [recallItem()],
      replies: [{statusCode: 402, headers: {'x-request-id': 'req_123'}, body: {code: 'out-of-credits', status: 402, debugMessage: 'No credits left.'}}],
    })
    const error = await run(ctx).then(() => null, (e) => e)
    assert.ok(error instanceof NodeApiError)
    assert.equal(error.message, 'past dev refused the request: out-of-credits')
    assert.match(error.description, /No credits left\./)
    assert.match(error.description, /Request ID: req_123\./)
    assert.equal(error.httpCode, '402')
    assert.equal(ctx.calls.length, 1, 'a 402 is not retried')
  })

  test('a 429 names the Retry-After time and is not retried by the node', async () => {
    const ctx = context({
      items: [ingestItem()],
      replies: [{statusCode: 429, headers: {'retry-after': '12'}, body: {code: 'rate-limited', status: 429}}],
    })
    const error = await run(ctx).then(() => null, (e) => e)
    assert.ok(error instanceof NodeApiError)
    assert.match(error.description, /after 12 seconds/)
    assert.equal(ctx.calls.length, 1)
  })

  test('a 404 on Delete Data Point keeps the code of the API', async () => {
    const ctx = context({items: [deleteItem()], replies: [{statusCode: 404, body: {code: 'data-point-not-found', status: 404}}]})
    await assert.rejects(run(ctx), (e) => e instanceof NodeApiError && e.message === 'past dev refused the request: data-point-not-found')
  })

  test('a network failure gives a NodeApiError', async () => {
    const ctx = context({items: [recallItem()], replies: [{throws: Object.assign(new Error('connect ECONNREFUSED'), {code: 'ECONNREFUSED'})}]})
    await assert.rejects(run(ctx), NodeApiError)
  })

  test('with Continue On Fail, each item gets its own result or its own message', async () => {
    const ctx = context({
      items: [recallItem(), recallItem({identity: rl('')}), recallItem()],
      replies: [{statusCode: 200, body: RECALL_PAGE}, {statusCode: 400, body: {code: 'recall-range-invalid', status: 400}}],
      continueOnFail: true,
    })
    const [items] = await run(ctx)
    assert.equal(items.length, 3)
    assert.ok(items[0].json.context.startsWith(MEMORIES_HEADER))
    assert.match(items[1].json.error, /'Identity' is empty/)
    assert.equal(items[2].json.error, 'past dev refused the request: recall-range-invalid')
    assert.deepEqual(items.map((item) => item.pairedItem.item), [0, 1, 2])
  })
})

describe('load options', () => {
  test('Audience lists the slugs of GET /api/v1/audiences', async () => {
    const ctx = context({
      replies: [{statusCode: 200, body: {audiences: [
        {slug: 'project', name: 'Project', kind: 'default', memberCount: 5},
        {slug: 'acme', name: 'Acme team', kind: 'fixed', memberCount: 1},
      ]}}],
    })
    const options = await new PastDev().methods.loadOptions.getAudiences.call(ctx)
    assert.deepEqual(options, [
      {name: 'Project (project)', value: 'project', description: '5 identities'},
      {name: 'Acme team (acme)', value: 'acme', description: '1 identity'},
    ])
    assert.equal(ctx.calls[0].method, 'GET')
    assert.equal(ctx.calls[0].url, 'https://api.example.test/api/v1/audiences')
  })

  test('Identity pages through GET /api/v1/identities with the cursor, and filters the page', async () => {
    const ctx = context({
      replies: [
        {statusCode: 200, body: {identities: [{identity: 'user-123'}, {identity: 'nadia'}], hasMore: true, endCursor: 'c1'}},
        {statusCode: 200, body: {identities: [{identity: 'user-456'}], hasMore: false, endCursor: null}},
      ],
    })
    const search = new PastDev().methods.listSearch.searchIdentities
    const first = await search.call(ctx, 'USER')
    assert.deepEqual(first, {results: [{name: 'user-123', value: 'user-123'}], paginationToken: 'c1'})
    const second = await search.call(ctx, '', 'c1')
    assert.deepEqual(second, {results: [{name: 'user-456', value: 'user-456'}], paginationToken: undefined})
    assert.deepEqual(ctx.calls.map((call) => call.qs), [{limit: 100}, {limit: 100, after: 'c1'}])
  })
})

describe('formatMemories', () => {
  test('writes the memories in rank order with their sources, as the SDKs do', () => {
    const reversed = {...RECALL_PAGE, results: [...RECALL_PAGE.results].reverse()}
    assert.equal(
      formatMemories(reversed),
      [
        MEMORIES_HEADER,
        '',
        '<memories as_of="2026-09-22T10:00:00Z">',
        '1. (2026-07-28T16:00:00Z, claim) Acme pilot budget: currently 40k.',
        '   Source call-8821 (2026-07-28T16:00:00Z, Email from Nadia): "Budget for the Acme pilot moved to 40k."',
        '2. (2026-02-03T09:00:00Z, claim, superseded 2026-07-28T16:00:00Z) Acme pilot budget: 32k.',
        '   Source call-8820 (2026-02-03T09:00:00Z): "Budget is 32k."',
        '</memories>',
      ].join('\n'),
    )
  })

  test('an empty page gives an empty string', () => {
    assert.equal(formatMemories({asOf: '2026-09-22T10:00:00Z', results: []}), '')
  })
})
