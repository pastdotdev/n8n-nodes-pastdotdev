import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

/** Keep it equal to "version" in package.json. A test checks it. */
export const VERSION = '0.1.0';

export const CREDENTIAL = 'pastDevApi';

const DEFAULT_API_HOST = 'https://api.past.dev';

/** An ISO 8601 time with a zone: Z or an offset. */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

type Context = IExecuteFunctions | ILoadOptionsFunctions;

/** The API host of the credential, with no slash at the end. */
async function apiHost(this: Context): Promise<string> {
	const credentials = await this.getCredentials(CREDENTIAL);
	const value =
		typeof credentials.apiHost === 'string' && credentials.apiHost.trim() !== ''
			? credentials.apiHost
			: DEFAULT_API_HOST;
	return value.trim().replace(/\/+$/, '');
}

/**
 * Send one request to the past dev API with the past dev API credential. When the API refuses the
 * request, this throws a NodeApiError with the code of the API, its message and the request ID.
 */
export async function pastDevApiRequest(
	this: Context,
	method: IHttpRequestMethods,
	path: string,
	options: { body?: IDataObject; qs?: IDataObject; itemIndex?: number } = {},
): Promise<IDataObject> {
	const request: IHttpRequestOptions = {
		method,
		url: `${await apiHost.call(this)}${path}`,
		headers: { Accept: 'application/json', 'User-Agent': `n8n-nodes-pastdotdev/${VERSION}` },
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};
	if (options.body !== undefined) request.body = options.body;
	if (options.qs !== undefined) request.qs = options.qs;

	let response: IN8nHttpFullResponse;
	try {
		response = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			CREDENTIAL,
			request,
		)) as IN8nHttpFullResponse;
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: options.itemIndex });
	}

	const status = response.statusCode;
	const data = (
		response.body && typeof response.body === 'object' ? response.body : {}
	) as IDataObject;
	if (status < 400) return data;

	throw new NodeApiError(this.getNode(), data as JsonObject, {
		itemIndex: options.itemIndex,
		httpCode: String(status),
		...refusal(status, data, response.headers ?? {}),
	});
}

/** The message and the description of a refusal of the API, in words for the person. */
export function refusal(
	status: number,
	data: IDataObject,
	headers: IDataObject,
): { message: string; description?: string } {
	const code = typeof data.code === 'string' ? data.code : undefined;
	const debugMessage = typeof data.debugMessage === 'string' ? data.debugMessage : undefined;
	const requestId = headers['x-request-id'];
	const retryAfter = headers['retry-after'];

	const hints: string[] = [];
	if (debugMessage) hints.push(debugMessage);
	if (status === 401) hints.push("Check the 'API Key' of the past dev API credential.");
	if (status === 402) hints.push('Add credits to the organization in the past dev console.');
	if (status === 429) {
		hints.push(
			retryAfter
				? `Too many requests. Try again after ${String(retryAfter)} seconds.`
				: 'Too many requests. Try again later, or turn on Retry On Fail in the node settings.',
		);
	}
	if (requestId) hints.push(`Request ID: ${String(requestId)}.`);

	return {
		message: code
			? `past dev refused the request: ${code}`
			: `past dev answered with status ${status}`,
		description: hints.length > 0 ? hints.join(' ') : undefined,
	};
}

/**
 * Read a time parameter. An empty value gives undefined. A value with no zone is refused, because
 * the API reads each time with its zone.
 */
export function checkTime(
	this: IExecuteFunctions,
	value: unknown,
	displayName: string,
	itemIndex: number,
): string | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	const text =
		value instanceof Date
			? value.toISOString()
			: typeof (value as { toISO?: () => string }).toISO === 'function'
				? (value as { toISO: () => string }).toISO()
				: String(value).trim();
	if (!ISO_WITH_ZONE.test(text) || Number.isNaN(Date.parse(text))) {
		throw new NodeOperationError(
			this.getNode(),
			`'${displayName}' is not an ISO 8601 time with a zone [item ${itemIndex}]`,
			{
				itemIndex,
				description:
					'Write the time with a zone, for example 2026-07-28T16:00:00Z, or use the expression {{ $now.toISO() }}.',
			},
		);
	}
	return text;
}

interface RecallSource {
	sourceId: string;
	occurredAt: string;
	label?: string;
	excerpts?: string[];
}

interface RecallResult {
	rank: number;
	occurredAt: string;
	content: string;
	artifact?: { kind?: string; supersededAt?: string };
	sources?: RecallSource[];
}

/** The text before the list of memories. It is the same text as in the past dev SDKs. */
export const MEMORIES_HEADER =
	'Memories recalled from past.dev, most relevant first. Each memory has the date it refers to and the ' +
	'sources it rests on. A memory marked "superseded" was replaced by a later statement. Use a memory only ' +
	'when it is relevant, and cite its source id.';

/**
 * Write a recall page as one flat text for the prompt of a model: one numbered memory for each
 * result, in rank order, with one line for each source. A page with no result gives an empty
 * string. The text is the same as the formatMemories function of the past dev SDKs.
 */
export function formatMemories(page: IDataObject): string {
	const results = (
		Array.isArray(page.results) ? (page.results as unknown as RecallResult[]) : []
	).slice();
	if (results.length === 0) return '';
	results.sort((a, b) => a.rank - b.rank);
	const lines = [MEMORIES_HEADER, '', `<memories as_of="${String(page.asOf)}">`];
	for (const result of results) {
		const tags = [result.occurredAt, result.artifact?.kind];
		if (result.artifact?.supersededAt) tags.push(`superseded ${result.artifact.supersededAt}`);
		lines.push(`${result.rank}. (${tags.join(', ')}) ${result.content}`);
		for (const source of result.sources ?? []) {
			const about = [source.occurredAt, source.label].filter(Boolean).join(', ');
			const excerpts =
				source.excerpts && source.excerpts.length > 0
					? `: ${source.excerpts.map((excerpt) => JSON.stringify(excerpt)).join(' ')}`
					: '';
			lines.push(`   Source ${source.sourceId} (${about})${excerpts}`);
		}
	}
	lines.push('</memories>');
	return lines.join('\n');
}
