import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

import { VERSION } from '../nodes/PastDev/GenericFunctions';

export class PastDevApi implements ICredentialType {
	name = 'pastDevApi';

	displayName = 'Past Dev API';

	icon: Icon = { light: 'file:pastDev.svg', dark: 'file:pastDev.dark.svg' };

	documentationUrl = 'https://github.com/pastdotdev/n8n-nodes-pastdotdev#credential';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'A project API key from the past dev console. It starts with past_sk_. See https://past.dev/docs/memory-api/quickstart.',
		},
		{
			displayName: 'API Host',
			name: 'apiHost',
			type: 'string',
			default: 'https://api.past.dev',
			description:
				'The address of the past dev API. Change it only when past dev runs in your own cloud.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// Listing the audiences costs no credits, so the test never spends any.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{($credentials.apiHost || "https://api.past.dev").replace(/\\/+$/, "")}}',
			url: '/api/v1/audiences',
			method: 'GET',
			headers: { 'User-Agent': `n8n-nodes-pastdotdev/${VERSION}` },
		},
	};
}
