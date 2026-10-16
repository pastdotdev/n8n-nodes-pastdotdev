import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeListSearchResult,
	INodeProperties,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { jsonParse, NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { checkTime, CREDENTIAL, formatMemories, pastDevApiRequest } from './GenericFunctions';

const showIngest = { show: { resource: ['memory'], operation: ['ingest'] } };
const showRecall = { show: { resource: ['memory'], operation: ['recall'] } };
const showDelete = { show: { resource: ['memory'], operation: ['deleteDataPoint'] } };

/** The identity picker. The identity is the person; set it from the trigger, never from a model. */
function identityField(
	show: typeof showIngest,
	required: boolean,
	description: string,
): INodeProperties {
	return {
		displayName: 'Identity',
		name: 'identity',
		type: 'resourceLocator',
		default: { mode: 'id', value: '' },
		required,
		description,
		displayOptions: show,
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod: 'searchIdentities', searchable: true },
			},
			{
				displayName: 'By ID',
				name: 'id',
				type: 'string',
				placeholder: 'e.g. user-123',
			},
		],
	};
}

const resource: INodeProperties = {
	displayName: 'Resource',
	name: 'resource',
	type: 'options',
	noDataExpression: true,
	options: [{ name: 'Memory', value: 'memory' }],
	default: 'memory',
};

const operation: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['memory'] } },
	options: [
		{
			name: 'Delete Data Point',
			value: 'deleteDataPoint',
			description: 'Delete one data point by its source ID, and the memory made from it',
			action: 'Delete data point',
		},
		{
			name: 'Ingest',
			value: 'ingest',
			description: 'Send one timestamped data point to memory',
			action: 'Ingest data point',
		},
		{
			name: 'Recall',
			value: 'recall',
			description: 'Retrieve the ranked memories for a query, as one identity',
			action: 'Recall memories',
		},
	],
	default: 'ingest',
};

const ingestFields: INodeProperties[] = [
	{
		displayName: 'Content',
		name: 'content',
		type: 'string',
		typeOptions: { rows: 4 },
		required: true,
		default: '',
		placeholder: 'e.g. The budget for the Acme pilot moved to 40k.',
		description: 'The text to keep in memory. Send the original text, not a summary.',
		displayOptions: showIngest,
	},
	identityField(
		showIngest,
		false,
		'The ID of the person who wrote the content. past dev adds the identity the first time it sees it. Set it from the trigger or the user record, never from a model.',
	),
	{
		displayName: 'Additional Fields',
		name: 'additionalFields',
		type: 'collection',
		placeholder: 'Add Field',
		default: {},
		displayOptions: showIngest,
		options: [
			{
				displayName: 'Audience Name or ID',
				name: 'audience',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getAudiences' },
				default: '',
				description:
					'The audience that can read the data point. Without it, every identity of the project can read it. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Idempotency Key',
				name: 'idempotencyKey',
				type: 'string',
				default: '',
				description:
					"A replay key. The same key with the same body returns the first receipt and ingests nothing twice. Set 'Occurred At' with it.",
			},
			{
				displayName: 'Label',
				name: 'label',
				type: 'string',
				default: '',
				placeholder: 'e.g. Email from Nadia',
				description: 'A short title for the data point. Recall returns it with the source.',
			},
			{
				displayName: 'Metadata',
				name: 'metadata',
				type: 'json',
				default: '{}',
				description: 'Your own JSON, kept with the data point and returned by recall',
			},
			{
				displayName: 'Occurred At',
				name: 'timestamp',
				type: 'string',
				default: '',
				placeholder: 'e.g. 2026-07-28T16:00:00Z',
				description:
					'When the content occurred, in ISO 8601 with a zone. Without it, past dev uses the time of the request.',
			},
			{
				displayName: 'Source ID',
				name: 'id',
				type: 'string',
				default: '',
				placeholder: 'e.g. ticket-4821',
				description:
					"Your own stable ID for the data point. A second ingest with the same ID makes a new revision of the same data point. 'Delete Data Point' uses this ID. Without it, past dev uses the SHA-256 of the content.",
			},
		],
	},
];

const recallFields: INodeProperties[] = [
	{
		displayName: 'Query',
		name: 'query',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. What is the budget for the Acme pilot?',
		description: 'The question or the words to look for',
		displayOptions: showRecall,
	},
	identityField(
		showRecall,
		true,
		'The ID of the person the recall is for. Recall reads the memory of the project and of each audience this identity is in. Set it from the trigger or the user record, never from a model.',
	),
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: showRecall,
		options: [
			{
				displayName: 'Level',
				name: 'level',
				type: 'options',
				default: 'low',
				options: [
					{ name: 'Low', value: 'low', description: 'About 8,000 tokens of evidence' },
					{ name: 'Medium', value: 'medium', description: 'About 16,000 tokens of evidence' },
					{ name: 'High', value: 'high', description: 'About 24,000 tokens of evidence' },
					{
						name: 'Extra High',
						value: 'extra-high',
						description: 'About 32,000 tokens of evidence',
					},
				],
				description:
					"The evidence budget of the page. The plan of the organization can lower it. Set 'Level' or 'Max Tokens', not both.",
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 50,
				description: 'Max number of results to return',
			},
			{
				displayName: 'Max Tokens',
				name: 'maxTokens',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 8000,
				description: "An exact evidence budget in tokens. Set 'Level' or 'Max Tokens', not both.",
			},
			{
				displayName: 'Occurred From',
				name: 'occurredFrom',
				type: 'string',
				default: '',
				placeholder: 'e.g. 2026-01-01T00:00:00Z',
				description: 'Only memories that occurred at or after this time, in ISO 8601 with a zone',
			},
			{
				displayName: 'Occurred To',
				name: 'occurredTo',
				type: 'string',
				default: '',
				placeholder: 'e.g. 2026-12-31T23:59:59Z',
				description: 'Only memories that occurred at or before this time, in ISO 8601 with a zone',
			},
			{
				displayName: 'Query Time',
				name: 'queryTimestamp',
				type: 'string',
				default: '',
				placeholder: 'e.g. 2026-07-01T00:00:00Z',
				description:
					'Read memory as it was at this time: only evidence at or before it can match. In ISO 8601 with a zone. Without it, recall reads memory as it is now.',
			},
			{
				displayName: 'Sort',
				name: 'sort',
				type: 'options',
				default: 'relevance',
				options: [
					{ name: 'Relevance', value: 'relevance', description: 'Most relevant first' },
					{
						name: 'Chronological',
						value: 'chronological',
						description: 'Oldest first. Each result keeps its rank.',
					},
				],
				description: 'The order of the results',
			},
		],
	},
];

const deleteFields: INodeProperties[] = [
	{
		displayName: 'Source ID',
		name: 'sourceId',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. ticket-4821',
		description:
			"The source ID of the data point, as it was sent to 'Ingest'. past dev deletes the data point and the memory made from it.",
		displayOptions: showDelete,
	},
];

export class PastDev implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'past dev',
		name: 'pastDev',
		icon: { light: 'file:pastDev.svg', dark: 'file:pastDev.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'past dev is a memory API for AI agents. Ingest, recall and delete memory.',
		defaults: {
			name: 'past dev',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: CREDENTIAL,
				required: true,
			},
		],
		properties: [resource, operation, ...ingestFields, ...recallFields, ...deleteFields],
	};

	methods = {
		loadOptions: {
			async getAudiences(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const page = await pastDevApiRequest.call(this, 'GET', '/api/v1/audiences');
				const audiences = Array.isArray(page.audiences) ? (page.audiences as IDataObject[]) : [];
				return audiences.map((audience) => ({
					name: `${String(audience.name ?? audience.slug)} (${String(audience.slug)})`,
					value: String(audience.slug),
					description:
						typeof audience.memberCount === 'number'
							? `${audience.memberCount} ${audience.memberCount === 1 ? 'identity' : 'identities'}`
							: undefined,
				}));
			},
		},
		listSearch: {
			async searchIdentities(
				this: ILoadOptionsFunctions,
				filter?: string,
				paginationToken?: string,
			): Promise<INodeListSearchResult> {
				const qs: IDataObject = { limit: 100 };
				if (paginationToken) qs.after = paginationToken;
				const page = await pastDevApiRequest.call(this, 'GET', '/api/v1/identities', { qs });
				const identities = Array.isArray(page.identities) ? (page.identities as IDataObject[]) : [];
				const needle = (filter ?? '').trim().toLowerCase();
				const results = identities
					.map((identity) => String(identity.identity))
					.filter((id) => needle === '' || id.toLowerCase().includes(needle))
					.map((id) => ({ name: id, value: id }));
				return {
					results,
					paginationToken:
						page.hasMore === true && typeof page.endCursor === 'string'
							? page.endCursor
							: undefined,
				};
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resourceName = this.getNodeParameter('resource', i) as string;
				const operationName = this.getNodeParameter('operation', i) as string;

				let json: IDataObject;
				if (resourceName === 'memory' && operationName === 'ingest') {
					json = await ingest.call(this, i);
				} else if (resourceName === 'memory' && operationName === 'recall') {
					json = await recall.call(this, i);
				} else if (resourceName === 'memory' && operationName === 'deleteDataPoint') {
					json = await deleteDataPoint.call(this, i);
				} else {
					throw new NodeOperationError(
						this.getNode(),
						`The operation '${operationName}' is not known for '${resourceName}'`,
						{ itemIndex: i },
					);
				}
				returnData.push({ json, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				// A refusal of the API is already a NodeApiError with its status and its item. A
				// NodeOperationError made from a NodeOperationError keeps it as it is.
				const nodeError =
					error instanceof NodeApiError
						? error
						: new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
				throw nodeError;
			}
		}

		return [returnData];
	}
}

function identityOf(this: IExecuteFunctions, i: number): string {
	const value = this.getNodeParameter('identity', i, '', { extractValue: true });
	return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

async function ingest(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	const content = this.getNodeParameter('content', i) as string;
	const identity = identityOf.call(this, i);
	const fields = this.getNodeParameter('additionalFields', i, {}) as IDataObject;

	if (typeof content !== 'string' || content.trim() === '') {
		throw new NodeOperationError(this.getNode(), `'Content' is empty [item ${i}]`, {
			itemIndex: i,
			description: "past dev refuses empty content. Map a field with the text to 'Content'.",
		});
	}

	const body: IDataObject = { content };
	if (identity) body.identity = identity;
	for (const key of ['id', 'label', 'audience', 'idempotencyKey'] as const) {
		const value = typeof fields[key] === 'string' ? (fields[key] as string).trim() : fields[key];
		if (value !== undefined && value !== null && value !== '') body[key] = value;
	}
	const timestamp = checkTime.call(this, fields.timestamp, 'Occurred At', i);
	if (timestamp) body.timestamp = timestamp;
	if (body.idempotencyKey && !body.timestamp) {
		throw new NodeOperationError(
			this.getNode(),
			`Set 'Occurred At' when you set 'Idempotency Key' [item ${i}]`,
			{
				itemIndex: i,
				description:
					'Without a time, past dev uses the time of the request. A retry then has a different body, and the key refuses it.',
			},
		);
	}
	if (fields.metadata !== undefined && fields.metadata !== '' && fields.metadata !== '{}') {
		body.metadata =
			typeof fields.metadata === 'string'
				? jsonParse<IDataObject>(fields.metadata, {
						errorMessage: `'Metadata' is not valid JSON [item ${i}]`,
					})
				: fields.metadata;
	}

	return await pastDevApiRequest.call(this, 'POST', '/api/v1/ingest', { body, itemIndex: i });
}

async function recall(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	const query = String(this.getNodeParameter('query', i) ?? '').trim();
	const identity = identityOf.call(this, i);
	const options = this.getNodeParameter('options', i, {}) as IDataObject;

	if (!query) {
		throw new NodeOperationError(this.getNode(), `'Query' is empty [item ${i}]`, {
			itemIndex: i,
			description: 'Give the question or the words to look for.',
		});
	}
	if (!identity) {
		throw new NodeOperationError(this.getNode(), `'Identity' is empty [item ${i}]`, {
			itemIndex: i,
			description:
				'Recall needs the ID of the person it is for. Set it from the trigger, for example {{ $json.userId }}.',
		});
	}
	if (options.level !== undefined && options.maxTokens !== undefined) {
		throw new NodeOperationError(
			this.getNode(),
			`Set 'Level' or 'Max Tokens', not both [item ${i}]`,
			{ itemIndex: i, description: "Remove one of the two from 'Options'." },
		);
	}

	const body: IDataObject = { query, identity };
	for (const key of ['limit', 'level', 'maxTokens', 'sort'] as const) {
		if (options[key] !== undefined && options[key] !== '') body[key] = options[key];
	}
	const times = [
		['occurredFrom', 'Occurred From'],
		['occurredTo', 'Occurred To'],
		['queryTimestamp', 'Query Time'],
	] as const;
	for (const [key, displayName] of times) {
		const value = checkTime.call(this, options[key], displayName, i);
		if (value) body[key] = value;
	}

	const page = await pastDevApiRequest.call(this, 'POST', '/api/v1/recall', { body, itemIndex: i });
	return { ...page, context: formatMemories(page) };
}

async function deleteDataPoint(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	const sourceId = String(this.getNodeParameter('sourceId', i) ?? '').trim();
	if (!sourceId) {
		throw new NodeOperationError(this.getNode(), `'Source ID' is empty [item ${i}]`, {
			itemIndex: i,
			description: "Give the source ID that was sent to 'Ingest'.",
		});
	}
	const operation = await pastDevApiRequest.call(
		this,
		'DELETE',
		`/api/v1/data-points/${encodeURIComponent(sourceId)}`,
		{ itemIndex: i },
	);
	return { deleted: true, sourceId, ...operation };
}
