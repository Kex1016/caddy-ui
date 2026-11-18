import type { ApiError } from '$lib/api/porkbun';

/**
 * What to tell a person about an error, by its code (docs/porkbun-plan.md §3.1 rule 7). Porkbun's own
 * `message` and `hint` are shown as written next to this; the text here adds what has to change and where.
 * Codes without an entry get a neutral title and Porkbun's words.
 */
export type Explanation = {
	title: string;
	/** What to change. Absent when Porkbun's message already says it all. */
	fix?: string;
	/** Where to change it, when Porkbun sent no link of its own. */
	url?: string;
};

const API_PAGE = 'https://porkbun.com/account/api';

const BY_CODE: Record<string, Explanation> = {
	NOT_CONFIGURED: { title: 'Porkbun is not set up.' },
	READ_ONLY: {
		title: 'Read-only mode is on.',
		fix: 'Set CADDY_UI_PORKBUN_READONLY=false on the caddy-ui service and restart it to allow changes.'
	},
	UNREACHABLE: {
		title: 'Porkbun could not be reached.',
		fix: 'If this server only has IPv6 trouble, set PORKBUN_API_URL to https://api-ipv4.porkbun.com/api/json/v3.'
	},
	RATE_LIMIT_EXCEEDED: { title: 'Porkbun is rate limiting this key.' },
	INVALID_API_KEYS_001: {
		title: 'Porkbun does not accept these keys.',
		fix: 'Check PORKBUN_API_KEY and PORKBUN_API_SECRET_KEY on the caddy-ui service against the key at Porkbun.',
		url: API_PAGE
	},
	INVALID_API_KEYS_002: {
		title: 'Porkbun does not accept these keys.',
		fix: 'Check PORKBUN_API_SECRET_KEY on the caddy-ui service; the secret is shown only once, when the key is made.',
		url: API_PAGE
	},
	INVALID_USER: { title: 'The Porkbun account behind this key is not active.' },
	ACCOUNT_VERIFICATION_REQUIRED: { title: 'Porkbun wants the account verified first.' },
	IP_NOT_ALLOWED: {
		title: "This server's address is not on the key's allowlist.",
		fix: "Add this server's public IP to the key's allowed addresses, or clear the list.",
		url: API_PAGE
	},
	DOMAIN_NOT_ALLOWED: {
		title: "This domain is not on the key's allowlist.",
		fix: "Add the domain to the key's allowed domains, or clear the list.",
		url: API_PAGE
	},
	INSUFFICIENT_SCOPE: {
		title: 'The API key may not do this.',
		fix: 'Give the key the permission named here. The "Manage, but no purchases" preset covers everything this page does.',
		url: API_PAGE
	},
	API_ACCESS_DISABLED: {
		title: 'API access is off for this domain.',
		fix: 'Turn on "API access" in the domain\'s details at Porkbun, or opt in all domains in the account settings.'
	},
	DOMAIN_NOT_ACTIVE: { title: 'The domain can not be managed right now.' },
	DOMAIN_NOT_FOUND: { title: 'The domain is not in this Porkbun account.' },
	DOMAIN_NOT_IN_ACCOUNT: { title: 'The domain is not in this Porkbun account.' },
	INVALID_DOMAIN: { title: 'Porkbun does not know this domain in this account.' },
	ZONE_RECORD_LIMIT: {
		title: 'The zone is full.',
		fix: 'Porkbun allows 2,500 records in a zone. Delete records that are no longer needed, then try again.'
	},
	DUPLICATE_RECORD: {
		title: 'This record already exists.',
		fix: 'Nothing was created. The existing record can be used as it is.'
	},
	RECORD_CONFLICT: {
		title: 'The record can not share its name with what is already there.',
		fix: 'A CNAME must be the only record at its name. Remove the records listed, or use another name.'
	},
	INVALID_RECORD_ID: {
		title: 'The record no longer exists.',
		fix: 'Refresh the list; it may have been changed elsewhere.'
	},
	RESTORE_POINT_NOT_FOUND: { title: 'That restore point no longer exists.' },
	DNSSEC_ALGORITHM_DEPRECATED: {
		title: 'The registry no longer accepts this DNSSEC algorithm.',
		fix: 'Use algorithm 8 or 13 with digest type 2.'
	},
	IDEMPOTENCY_KEY_IN_USE: { title: 'The same change is still being processed.' }
};

export function explain(error: Pick<ApiError, 'code' | 'retryable'>): Explanation {
	return (
		BY_CODE[error.code] ?? {
			title: error.retryable ? 'Porkbun could not do that just now.' : 'Porkbun refused the request.'
		}
	);
}
