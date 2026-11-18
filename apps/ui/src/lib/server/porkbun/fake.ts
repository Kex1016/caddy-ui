/**
 * An in-memory Porkbun for tests (docs/porkbun-plan.md §3.2). It speaks the same HTTP as the real API v3 for
 * every endpoint in §2 of the plan, keeps its own zones, restore points and registry settings, and never
 * touches the network.
 *
 *     const fake = new FakePorkbun(seed);                     // fixtures/seed.json
 *     const pb = new Porkbun({ ...fake.credentials, baseUrl: fake.baseUrl, fetch: fake.fetch });
 *
 * `handle(request)` takes a standard Request, so an HTTP server for e2e tests is a few lines around it.
 *
 * This file has no runtime imports and only erasable TypeScript, so Node 22.18+ can load it as it is.
 *
 * Where the spec (v3.107) leaves behaviour open, the fake picks something plausible and says so with
 * "fake-only" in a comment. Code under test must not depend on those details.
 */

export type FakeRecordSeed = {
	/** Host part, '' for the apex. */
	name: string;
	type: string;
	content: string;
	ttl?: number;
	prio?: number;
	notes?: string;
};

export type FakeDomainSeed = {
	domain: string;
	status: string;
	createDate: string;
	addedDate?: string;
	expireDate: string;
	securityLock: number;
	whoisPrivacy: number;
	autoRenew: number;
	apiAccess: number;
	notLocal: number;
	labels?: { id: string; title: string; color: string }[];
	ns: string[];
	/** Whether Porkbun has issued a certificate for the domain. */
	ssl?: boolean;
	records: FakeRecordSeed[];
	dnssec?: { keyTag: string; alg: string; digestType: string; digest: string }[];
	glue?: { host: string; v4: string[]; v6: string[] }[];
	forwards?: {
		subdomain: string;
		location: string;
		redirectType: string;
		includePath: string;
		wildcard: string;
	}[];
	/** What `/dns/scan` discovers. Default: the zone's own records. */
	scan?: FakeRecordSeed[];
};

export type FakeSeed = {
	account: string;
	apiKey: string;
	apiSecret: string;
	/** `["full"]` or a list of scopes, as `/ping` reports them. */
	scopes: string[];
	ip: string;
	balanceCents: number;
	pricing: Record<string, { registration: string; renewal: string; transfer: string }>;
	domains: FakeDomainSeed[];
};

export type FakeRequest = {
	method: string;
	/** Path after the API base, decoded per segment: `dns/retrieve/example.com`. */
	path: string;
	/** The path exactly as sent, still encoded. */
	rawPath: string;
	query: Record<string, string>;
	/** Lower-case header names. */
	headers: Record<string, string>;
	body: unknown;
};

type Rec = {
	id: string;
	host: string;
	type: string;
	content: string;
	ttl: number;
	prio: number | null;
	notes: string | null;
};
type Snap = { id: number; takenAt: number; reason: string; source: string; records: Rec[] };
type Forward = {
	id: string;
	subdomain: string;
	location: string;
	redirectType: string;
	includePath: string;
	wildcard: string;
};
type Zone = {
	meta: FakeDomainSeed;
	records: Rec[];
	snaps: Snap[];
	ns: string[];
	dnssec: { keyTag: string; alg: string; digestType: string; digest: string }[];
	glue: { host: string; v4: string[]; v6: string[] }[];
	forwards: Forward[];
};
type Json = Record<string, unknown>;
type Canned = { status: number; body?: unknown; text?: string; headers?: Record<string, string> };
type Out = { status: number; body: Json; headers?: Record<string, string> };

const RECORD_TYPES = [
	'A',
	'AAAA',
	'MX',
	'CNAME',
	'ALIAS',
	'TXT',
	'NS',
	'SRV',
	'TLSA',
	'CAA',
	'SSHFP',
	'HTTPS',
	'SVCB',
	'DS'
];
const PORKBUN_NS = [
	'maceio.ns.porkbun.com',
	'curitiba.ns.porkbun.com',
	'salvador.ns.porkbun.com',
	'fortaleza.ns.porkbun.com'
];
const MIN_TTL = 600;
/** Types Porkbun manages elsewhere and can not recreate on a restore. */
const MASKED_TYPES = ['ALIAS', 'HTTPS'];
const DEPRECATED_DNSSEC_ALGS = ['1', '3', '5', '6', '7', '12'];
const HOUR = 3_600_000;

export const FAKE_SPEC_VERSION = '3.107';

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const pad = (n: number) => String(n).padStart(2, '0');

/** ms since the epoch to Porkbun's "YYYY-MM-DD HH:MM:SS" (UTC). */
function stamp(ms: number): string {
	const d = new Date(ms);
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function fail(status: number, code: string, message: string, extra: Json = {}, action?: Json): Out {
	const body: Json = { status: 'ERROR', message, code, ...extra };
	if (action) body.next_action = action;
	return { status, body };
}

const ok = (body: Json = {}): Out => ({ status: 200, body: { status: 'SUCCESS', ...body } });

const sameData = (a: Rec, b: Rec) =>
	a.host === b.host && a.type === b.type && a.content === b.content && (a.prio ?? 0) === (b.prio ?? 0);

export class FakePorkbun {
	readonly baseUrl = 'https://porkbun.invalid/api/json/v3';
	/** Every request received, oldest first. */
	readonly requests: FakeRequest[] = [];
	/** Zone size ceiling; the real one is 2,500. */
	recordLimit = 2500;
	/** The key's scopes, as `/ping` reports them. Change it to test a restricted key. */
	scopes: string[];

	readonly #seed: FakeSeed;
	readonly #now: () => number;
	readonly #zones = new Map<string, Zone>();
	readonly #idempotent = new Map<string, { body: string; out: Out }>();
	readonly #canned: Canned[] = [];
	readonly #throws: Error[] = [];
	#nextId = 100_000;
	#nextSnap = 1000;
	#nextRequest = 1;

	constructor(seed: FakeSeed, opts: { now?: () => number } = {}) {
		this.#seed = seed;
		this.#now = opts.now ?? (() => Date.now());
		this.scopes = [...seed.scopes];
		for (const d of seed.domains) {
			this.#zones.set(d.domain, {
				meta: { ...d },
				records: d.records.map((r) => this.#rec(r)),
				snaps: [],
				ns: [...d.ns],
				dnssec: (d.dnssec ?? []).map((x) => ({ ...x })),
				glue: (d.glue ?? []).map((g) => ({ host: g.host, v4: [...g.v4], v6: [...g.v6] })),
				forwards: (d.forwards ?? []).map((f) => ({ id: String(this.#nextId++), ...f }))
			});
		}
	}

	get credentials(): { apiKey: string; apiSecret: string } {
		return { apiKey: this.#seed.apiKey, apiSecret: this.#seed.apiSecret };
	}

	// ── Test controls ────────────────────────────────────────────────────────────────────────────────────

	/** Answer the next `times` requests with this instead of handling them. */
	respondNext(canned: Canned, times = 1): void {
		for (let i = 0; i < times; i++) this.#canned.push(canned);
	}

	/** Answer the next `times` requests with a 429. */
	rateLimitNext(retryAfterSeconds: number, times = 1): void {
		this.respondNext(
			{
				status: 429,
				headers: { 'retry-after': String(retryAfterSeconds) },
				body: {
					status: 'ERROR',
					code: 'RATE_LIMIT_EXCEEDED',
					message: 'Rate limit exceeded. Please try again later.',
					ttlRemaining: retryAfterSeconds
				}
			},
			times
		);
	}

	/** Make the next request fail before any answer, as a dropped connection or a timeout would. */
	throwNext(error: Error): void {
		this.#throws.push(error);
	}

	/** The live records of a zone, as the fake stores them. */
	records(domain: string): Rec[] {
		return (this.#zones.get(domain)?.records ?? []).map((r) => ({ ...r }));
	}

	/** Replace a zone's records without a restore point, to arrange a test. */
	setRecords(domain: string, records: FakeRecordSeed[]): void {
		const zone = this.#zones.get(domain);
		if (!zone) throw new Error(`fake: no domain ${domain}`);
		zone.records = records.map((r) => this.#rec(r));
	}

	/** Change a domain's flags (`apiAccess`, `autoRenew`, …), to arrange a test. */
	setDomain(domain: string, patch: Partial<FakeDomainSeed>): void {
		const zone = this.#zones.get(domain);
		if (!zone) throw new Error(`fake: no domain ${domain}`);
		Object.assign(zone.meta, patch);
		if (patch.ns) zone.ns = [...patch.ns];
	}

	/** Add a domain to the account, to arrange a test. */
	addDomain(d: FakeDomainSeed): void {
		this.#zones.set(d.domain, {
			meta: { ...d },
			records: d.records.map((r) => this.#rec(r)),
			snaps: [],
			ns: [...d.ns],
			dnssec: [],
			glue: [],
			forwards: []
		});
	}

	/** POSTs received so far that were not dry runs: the writes that would have changed something. */
	get writes(): FakeRequest[] {
		return this.requests.filter((r) => r.method === 'POST' && !(isObj(r.body) && r.body.dryRun === true));
	}

	// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────────

	/** A `fetch` that is answered by this fake. */
	fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
		this.handle(input instanceof Request ? input : new Request(input, init));

	async handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const marker = '/api/json/v3/';
		const at = url.pathname.indexOf(marker);
		const rawPath = at >= 0 ? url.pathname.slice(at + marker.length) : url.pathname.replace(/^\/+/, '');
		const segments = rawPath.split('/').map((s) => decodeURIComponent(s));
		const headers: Record<string, string> = {};
		request.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
		const text = request.method === 'POST' ? await request.text() : '';
		let body: unknown;
		try {
			body = text === '' ? undefined : JSON.parse(text);
		} catch {
			body = text;
		}
		const req: FakeRequest = {
			method: request.method,
			path: segments.join('/'),
			rawPath,
			query: Object.fromEntries(url.searchParams),
			headers,
			body
		};
		this.requests.push(req);

		const thrown = this.#throws.shift();
		if (thrown) throw thrown;
		const canned = this.#canned.shift();
		if (canned) {
			const payload = canned.text ?? JSON.stringify(canned.body ?? {});
			return new Response(payload, {
				status: canned.status,
				headers: { 'content-type': 'application/json', ...canned.headers }
			});
		}

		const key = headers['idempotency-key'];
		if (request.method === 'POST' && key) {
			const seen = this.#idempotent.get(key);
			if (seen && seen.body === text) return this.#respond(seen.out, { 'idempotent-replayed': 'true' });
			if (seen) {
				return this.#respond(
					fail(
						409,
						'IDEMPOTENCY_KEY_MISMATCH',
						'This Idempotency-Key was used with a different request body.'
					)
				);
			}
		}
		const out = this.#route(req, segments);
		if (request.method === 'POST' && key) this.#idempotent.set(key, { body: text, out });
		return this.#respond(out);
	}

	#respond(out: Out, extra: Record<string, string> = {}): Response {
		const requestId = `fake-request-${this.#nextRequest++}`;
		const sandbox = this.#seed.apiKey.startsWith('pk1_sb_');
		const body: Json = { ...out.body, requestId };
		if (sandbox) body.sandbox = true;
		return new Response(JSON.stringify(body), {
			status: out.status,
			headers: {
				'content-type': 'application/json',
				'x-request-id': requestId,
				'x-api-version': FAKE_SPEC_VERSION,
				...(sandbox ? { 'x-porkbun-sandbox': 'true' } : {}),
				...out.headers,
				...extra
			}
		});
	}

	// ── Routing ──────────────────────────────────────────────────────────────────────────────────────────

	#route(req: FakeRequest, seg: string[]): Out {
		const [area, op, a, b, c] = seg;
		const read = req.method === 'GET' || req.method === 'POST';
		const post = req.method === 'POST';
		const body = isObj(req.body) ? req.body : {};

		if (area === 'pricing' && op === 'get' && read) return this.#pricing(req.query, body);

		const creds = this.#credentials(req, body);
		if (area === 'ping' && read) {
			if (creds === 'none') return ok({ yourIp: this.#seed.ip, xForwardedFor: this.#seed.ip });
			if (creds === 'bad') return this.#badKeys();
			return ok({
				yourIp: this.#seed.ip,
				xForwardedFor: this.#seed.ip,
				credentialsValid: true,
				account: this.#seed.account,
				scopes: [...this.scopes]
			});
		}
		if (creds === 'none') {
			return fail(
				400,
				'API_KEY_REQUIRED',
				'No API key was provided.',
				{},
				{ type: 'authenticate', retryable: false }
			);
		}
		if (creds === 'bad') return this.#badKeys();

		const needs = (scope: string): Out | null => this.#scope(scope);
		const write = (scope: string, run: () => Out): Out => {
			if (!post) return fail(405, 'METHOD_NOT_ALLOWED', 'Use POST for this endpoint.');
			return needs(scope) ?? run();
		};
		const dryRun = body.dryRun === true;

		if (area === 'account' && req.method === 'GET') {
			if (op === 'balance') {
				const cents = this.#seed.balanceCents;
				return ok({ balance: cents, display: `$${(cents / 100).toFixed(2)}` });
			}
			if (op === 'apiSettings') {
				return ok({
					settings: {
						monthlySpendLimit: null,
						lowBalanceAlert: null,
						autoTopup: false,
						topupThreshold: null,
						topupAmount: 0
					},
					monthlySpend: 0,
					spendLimit: { limit: 10000, source: 'default', spent: 0, remaining: 10000 },
					topupLimit: { limit: 10000, source: 'default', added: 0 }
				});
			}
		}

		if (area === 'domain') {
			if (op === 'listAll' && read) return this.#listAll({ ...req.query, ...body });
			if (op === 'updateAutoRenew') return write('domains', () => this.#autoRenew(a, body));
			if (op === 'get' && req.method === 'GET') {
				const zone = a === undefined ? undefined : this.#zones.get(a.toLowerCase());
				if (!zone) {
					return fail(404, 'DOMAIN_NOT_FOUND', 'The domain is not in this account.', {
						account: this.#seed.account
					});
				}
				const includeLabels = req.query.includeLabels === 'yes';
				return ok({ domain: this.#domainJson(zone, includeLabels) });
			}
			const found = this.#zone(a, 'domain');
			if ('status' in found) return found;
			const zone = found.zone;
			switch (op) {
				case 'getNs':
					if (read) return ok({ ns: [...zone.ns] });
					break;
				case 'updateNs':
					return write('domains', () => this.#updateNs(zone, body, dryRun));
				case 'getGlue':
					if (read) {
						return ok({
							hosts: zone.glue.map((g) => [g.host, { v4: [...g.v4], v6: [...g.v6] }]),
							glue: zone.glue.map((g) => ({ host: g.host, v4: [...g.v4], v6: [...g.v6] }))
						});
					}
					break;
				case 'createGlue':
				case 'updateGlue':
				case 'deleteGlue':
					return write('domains', () => this.#glue(zone, op, b, body));
				case 'getUrlForwarding':
					if (read) {
						return ok({
							forwards: zone.forwards.map((f) => ({
								...f,
								type:
									f.redirectType === '301'
										? 'permanent'
										: f.redirectType === 'masked'
											? 'masked'
											: 'temporary'
							}))
						});
					}
					break;
				case 'addUrlForward':
					return write('dns', () => this.#addForward(zone, body));
				case 'deleteUrlForward':
					return write('dns', () => {
						const before = zone.forwards.length;
						zone.forwards = zone.forwards.filter((f) => f.id !== b);
						// fake-only: the spec does not name the code for an unknown forward id.
						return zone.forwards.length < before
							? ok()
							: fail(400, 'INVALID_RECORD_ID', 'Invalid record ID.');
					});
			}
		}

		if (area === 'ssl' && op === 'retrieve' && read) {
			const denied = needs('domains');
			if (denied) return denied;
			const found = this.#zone(a, 'domain');
			if ('status' in found) return found;
			// fake-only: the spec says "certificate not ready" is an error but does not name its code.
			if (!found.zone.meta.ssl) return fail(400, 'SSL_NOT_READY', 'The SSL certificate is not ready.');
			const name = found.zone.meta.domain;
			// Assembled at run time so the repository never contains anything shaped like a real key.
			const pem = (label: string, text: string) =>
				`-----BEGIN ${label}-----\n${text}\n-----END ${label}-----\n`;
			return ok({
				certificatechain:
					pem('CERTIFICATE', `fake certificate for ${name}`) + pem('CERTIFICATE', 'fake intermediate'),
				privatekey: pem(['PRIVATE', 'KEY'].join(' '), `fake private key for ${name}`),
				publickey: pem(['PUBLIC', 'KEY'].join(' '), `fake public key for ${name}`)
			});
		}

		if (area === 'dns') {
			const found = this.#zone(a, 'dns');
			if ('status' in found) return found;
			const zone = found.zone;
			switch (op) {
				case 'retrieve':
					if (read) {
						const list = b === undefined ? zone.records : zone.records.filter((r) => r.id === b);
						return ok({ cloudflare: 'disabled', records: list.map((r) => this.#recordJson(zone, r)) });
					}
					break;
				case 'retrieveByNameType':
					if (read) {
						const list = zone.records.filter(
							(r) => r.type === (b ?? '').toUpperCase() && r.host === (c ?? '')
						);
						return ok({ cloudflare: 'disabled', records: list.map((r) => this.#recordJson(zone, r)) });
					}
					break;
				case 'create':
					return write('dns', () => this.#create(zone, body, dryRun));
				case 'edit':
					return write('dns', () => this.#edit(zone, b, body, dryRun));
				case 'editByNameType':
					return write('dns', () => this.#editByNameType(zone, b, c ?? '', body, dryRun));
				case 'delete':
					return write('dns', () => this.#delete(zone, b, dryRun));
				case 'deleteByNameType':
					return write('dns', () => this.#deleteByNameType(zone, b, c ?? '', dryRun));
				case 'history':
					if (req.method === 'GET') return this.#history(zone);
					break;
				case 'diff':
					if (req.method === 'GET') return this.#diff(zone, Number(b));
					break;
				case 'restore':
					return write('dns', () => this.#restore(zone, body, dryRun));
				case 'preflight':
					if (req.method === 'GET') return this.#preflight(zone, req.query.intent ?? 'general');
					break;
				case 'scan':
					if (req.method === 'GET') {
						const records = this.#scan(zone);
						return ok({ domain: zone.meta.domain, recordCount: records.length, records });
					}
					break;
				case 'import':
					return write('dns', () => this.#import(zone, body, dryRun));
				case 'getDnssecRecords':
					if (read) return ok({ records: Object.fromEntries(zone.dnssec.map((d) => [d.keyTag, { ...d }])) });
					break;
				case 'createDnssecRecord':
					return write('domains', () => this.#createDnssec(zone, body));
				case 'deleteDnssecRecord':
					return write('domains', () => {
						const before = zone.dnssec.length;
						zone.dnssec = zone.dnssec.filter((d) => d.keyTag !== b);
						return zone.dnssec.length < before
							? ok()
							: fail(400, 'DNSSEC_DELETE_FAILED', 'The registry did not accept the DS removal.');
					});
			}
		}

		return fail(404, 'NOT_FOUND', `fake: no handler for ${req.method} ${req.path}`);
	}

	// ── Auth and lookups ─────────────────────────────────────────────────────────────────────────────────

	#credentials(req: FakeRequest, body: Json): 'ok' | 'bad' | 'none' {
		const key = typeof body.apikey === 'string' ? body.apikey : req.headers['x-api-key'];
		const secret =
			typeof body.secretapikey === 'string' ? body.secretapikey : req.headers['x-secret-api-key'];
		if (key === undefined && secret === undefined) return 'none';
		return key === this.#seed.apiKey && secret === this.#seed.apiSecret ? 'ok' : 'bad';
	}

	#badKeys(): Out {
		return fail(
			400,
			'INVALID_API_KEYS_001',
			'Invalid API key. (001)',
			{},
			{
				type: 'authenticate',
				hint: 'Check the API key and secret at porkbun.com/account/api.',
				url: 'https://porkbun.com/account/api',
				retryable: false
			}
		);
	}

	#scope(scope: string): Out | null {
		const has = this.scopes.includes('full') || this.scopes.includes(scope) || scope === 'read';
		if (has) return null;
		return fail(
			403,
			'INSUFFICIENT_SCOPE',
			`This API key does not have the "${scope}" permission.`,
			{ requiredScope: scope, keyScopes: [...this.scopes] },
			{
				type: 'enable_setting',
				hint: "The account holder can change the key's permissions in API Access.",
				url: 'https://porkbun.com/account/api',
				retryable: false
			}
		);
	}

	#zone(name: string | undefined, surface: 'dns' | 'domain'): { zone: Zone } | Out {
		const zone = name === undefined ? undefined : this.#zones.get(name.toLowerCase());
		if (!zone) {
			return fail(
				400,
				'INVALID_DOMAIN',
				'Invalid domain.',
				surface === 'dns' ? { account: this.#seed.account } : {},
				{
					type: 'fix_request',
					hint: 'Check the spelling, or list the domains with /domain/listAll.',
					retryable: false
				}
			);
		}
		if (zone.meta.apiAccess !== 1) {
			return fail(
				400,
				'API_ACCESS_DISABLED',
				'Domain is not opted in to API access.',
				{ account: this.#seed.account },
				{
					type: 'enable_setting',
					hint: 'Turn on API access for the domain in its details at porkbun.com.',
					url: 'https://porkbun.com/account/domainsSpeedy',
					retryable: false
				}
			);
		}
		return { zone };
	}

	#rec(r: FakeRecordSeed): Rec {
		return {
			id: String(this.#nextId++),
			host: r.name.toLowerCase(),
			type: r.type.toUpperCase(),
			content: r.content,
			ttl: Math.max(MIN_TTL, r.ttl ?? MIN_TTL),
			prio: r.prio ?? null,
			notes: r.notes ?? null
		};
	}

	#fqdn(zone: Zone, host: string): string {
		return host === '' ? zone.meta.domain : `${host}.${zone.meta.domain}`;
	}

	#recordJson(zone: Zone, r: Rec): Json {
		return {
			id: r.id,
			name: this.#fqdn(zone, r.host),
			type: r.type,
			content: r.content,
			ttl: String(r.ttl),
			prio: r.prio === null ? null : String(r.prio),
			notes: r.notes
		};
	}

	#domainJson(zone: Zone, labels: boolean): Json {
		const m = zone.meta;
		const out: Json = {
			domain: m.domain,
			status: m.status,
			tld: m.domain.slice(m.domain.indexOf('.') + 1),
			createDate: m.createDate,
			addedDate: m.addedDate ?? m.createDate,
			expireDate: m.expireDate,
			securityLock: m.securityLock,
			whoisPrivacy: m.whoisPrivacy,
			autoRenew: m.autoRenew,
			apiAccess: m.apiAccess,
			notLocal: m.notLocal
		};
		if (labels) out.labels = m.labels ?? [];
		return out;
	}

	/** The advisory Porkbun attaches to DNS writes on a zone its nameservers do not serve. */
	#warnings(zone: Zone): Json {
		const foreign = zone.ns.filter((n) => !n.toLowerCase().endsWith('.ns.porkbun.com'));
		if (foreign.length === 0) return {};
		const d = zone.meta.domain;
		return {
			warnings: [
				`${d} is delegated to nameservers we do not operate (${foreign.join(', ')}), so this change was saved to your Porkbun DNS zone but does NOT affect what resolves. Make the same change wherever those nameservers are managed, or point the domain back at ours (${PORKBUN_NS.join(', ')}) with POST /domain/updateNs/${d} -- the zone you just edited is what we would start serving.`
			]
		};
	}

	/** Restore points are taken before the first write to a zone in each hour, and before imports and restores. */
	#snapshot(zone: Zone, reason: string, always = false): number {
		const now = this.#now();
		const last = zone.snaps[0];
		if (!always && last && last.source === 'auto' && now - last.takenAt < HOUR) return last.id;
		const snap: Snap = {
			id: this.#nextSnap++,
			takenAt: now,
			reason,
			source: 'auto',
			records: zone.records.map((r) => ({ ...r }))
		};
		zone.snaps.unshift(snap);
		if (zone.snaps.length > 50) zone.snaps.length = 50;
		return snap.id;
	}

	// ── Domains ──────────────────────────────────────────────────────────────────────────────────────────

	#listAll(q: Json): Out {
		const start = Number(q.start ?? 0) || 0;
		let zones = [...this.#zones.values()];
		if (typeof q.domain === 'string') zones = zones.filter((z) => z.meta.domain === q.domain);
		if (typeof q.nameContains === 'string') {
			const needle = q.nameContains.toLowerCase();
			zones = zones.filter((z) => z.meta.domain.includes(needle));
		}
		if (q.autoRenew === 'yes' || q.autoRenew === 'no') {
			zones = zones.filter((z) => (z.meta.autoRenew === 1) === (q.autoRenew === 'yes'));
		}
		if (q.apiAccess === 'yes' || q.apiAccess === 'no') {
			zones = zones.filter((z) => (z.meta.apiAccess === 1) === (q.apiAccess === 'yes'));
		}
		zones.sort((x, y) => x.meta.expireDate.localeCompare(y.meta.expireDate));
		const page = zones.slice(start, start + 1000);
		return ok({
			count: page.length,
			domains: page.map((z) => this.#domainJson(z, q.includeLabels === 'yes'))
		});
	}

	#autoRenew(pathDomain: string | undefined, body: Json): Out {
		if (body.status !== 'on' && body.status !== 'off') {
			return fail(400, 'INVALID_INPUT', 'status must be "on" or "off".');
		}
		const names = new Set<string>();
		if (pathDomain) names.add(pathDomain.toLowerCase());
		if (Array.isArray(body.domains))
			for (const d of body.domains) if (typeof d === 'string') names.add(d.toLowerCase());
		if (names.size === 0) return fail(400, 'MISSING_PARAMETER', 'No domain was given.');
		const results: Json = {};
		for (const name of names) {
			const zone = this.#zones.get(name);
			if (!zone) results[name] = { status: 'ERROR', message: 'Invalid domain.' };
			else if (zone.meta.apiAccess !== 1)
				results[name] = { status: 'ERROR', message: 'Domain is not opted in to API access.' };
			else {
				zone.meta.autoRenew = body.status === 'on' ? 1 : 0;
				results[name] = { status: 'SUCCESS', message: `Auto renew is now ${body.status}.` };
			}
		}
		return ok({ results });
	}

	#updateNs(zone: Zone, body: Json, dryRun: boolean): Out {
		const ns = Array.isArray(body.ns)
			? body.ns.filter((n): n is string => typeof n === 'string' && n.trim() !== '')
			: [];
		const hostname = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\.?$/i;
		if (ns.length < 2 || ns.some((n) => !hostname.test(n))) {
			return fail(400, 'INVALID_INPUT', 'Send at least two valid nameserver hostnames in ns.');
		}
		if (dryRun) return ok({ dryRun: true, wouldSucceed: true });
		zone.ns = ns.map((n) => n.toLowerCase());
		return ok();
	}

	#glue(zone: Zone, op: string, sub: string | undefined, body: Json): Out {
		if (!sub) return fail(400, 'MISSING_PARAMETER', 'The glue host is missing from the path.');
		const host = `${sub.toLowerCase()}.${zone.meta.domain}`;
		const at = zone.glue.findIndex((g) => g.host === host);
		if (op === 'deleteGlue') {
			if (at < 0) return fail(400, 'INVALID_INPUT', 'No glue record with that host.');
			zone.glue.splice(at, 1);
			return ok();
		}
		const ips = Array.isArray(body.ips) ? body.ips.filter((i): i is string => typeof i === 'string') : [];
		if (ips.length === 0) return fail(400, 'MISSING_PARAMETER', 'ips is required.');
		const entry = { host, v4: ips.filter((i) => !i.includes(':')), v6: ips.filter((i) => i.includes(':')) };
		if (op === 'createGlue') {
			if (at >= 0) return fail(400, 'INVALID_INPUT', 'A glue record with that host already exists.');
			zone.glue.push(entry);
		} else {
			if (at < 0) return fail(400, 'INVALID_INPUT', 'No glue record with that host.');
			zone.glue[at] = entry;
		}
		return ok();
	}

	#addForward(zone: Zone, body: Json): Out {
		const location = typeof body.location === 'string' ? body.location : '';
		if (!/^https?:\/\//.test(location)) return fail(400, 'INVALID_INPUT', 'location must be an http(s) URL.');
		for (const field of ['includePath', 'wildcard']) {
			if (body[field] !== 'yes' && body[field] !== 'no')
				return fail(400, 'MISSING_PARAMETER', `${field} must be yes or no.`);
		}
		const exact = typeof body.redirectType === 'string' ? body.redirectType : undefined;
		const redirectType =
			exact ?? (body.type === 'permanent' ? '301' : body.type === 'masked' ? 'masked' : '302');
		if (!['301', '302', '307', 'masked'].includes(redirectType)) {
			return fail(400, 'INVALID_INPUT', 'redirectType must be 301, 302, 307 or masked.');
		}
		zone.forwards.push({
			id: String(this.#nextId++),
			subdomain: typeof body.subdomain === 'string' ? body.subdomain.toLowerCase() : '',
			location,
			redirectType,
			includePath: body.includePath as string,
			wildcard: body.wildcard as string
		});
		return ok();
	}

	// ── DNS records ──────────────────────────────────────────────────────────────────────────────────────

	/** Why a record can not be stored as given, or null. `self` is the record being edited, if any. */
	#refusal(zone: Zone, next: Rec, self: Rec | null): Out | null {
		if (!RECORD_TYPES.includes(next.type)) return fail(400, 'INVALID_TYPE', 'Invalid record type.');
		if (next.content.trim() === '') return fail(400, 'MISSING_PARAMETER', 'content is required.');
		if (next.type === 'A' && !/^(\d{1,3}\.){3}\d{1,3}$/.test(next.content)) {
			return fail(400, 'INVALID_INPUT', 'content must be an IPv4 address for an A record.');
		}
		if (next.type === 'AAAA' && !next.content.includes(':')) {
			return fail(400, 'INVALID_INPUT', 'content must be an IPv6 address for an AAAA record.');
		}
		const others = zone.records.filter((r) => r !== self);
		const twin = others.find((r) => sameData(r, next));
		if (twin) {
			return fail(
				400,
				'DUPLICATE_RECORD',
				'A record with this name, type and content already exists.',
				{ existingId: twin.id },
				{
					type: 'none',
					hint: 'Use the existing record instead of creating another.',
					retryable: false
				}
			);
		}
		const atName = others.filter((r) => r.host === next.host);
		const blocking =
			next.type === 'CNAME'
				? atName.filter((r) => r.type !== 'CNAME')
				: atName.filter((r) => r.type === 'CNAME');
		const secondCname = next.type === 'CNAME' ? atName.filter((r) => r.type === 'CNAME') : [];
		const conflicts = [...blocking, ...secondCname];
		if (conflicts.length > 0) {
			return fail(
				400,
				'RECORD_CONFLICT',
				'A CNAME can not share a name with any other record.',
				{ conflictingRecords: conflicts.map((r) => this.#recordJson(zone, r)) },
				{
					type: 'fix_request',
					hint: 'Remove the conflicting records first, or use another name.',
					retryable: false
				}
			);
		}
		return null;
	}

	#create(zone: Zone, body: Json, dryRun: boolean): Out {
		if (typeof body.type !== 'string') return fail(400, 'MISSING_PARAMETER', 'type is required.');
		const next = this.#rec({
			name: typeof body.name === 'string' ? body.name : '',
			type: body.type,
			content: typeof body.content === 'string' ? body.content : '',
			ttl: Number(body.ttl) || undefined,
			prio: body.prio === undefined || body.prio === null ? undefined : Number(body.prio),
			notes: typeof body.notes === 'string' && body.notes !== '' ? body.notes : undefined
		});
		const refused = this.#refusal(zone, next, null);
		if (refused) return refused;
		if (zone.records.length >= this.recordLimit) {
			return fail(400, 'ZONE_RECORD_LIMIT', 'The zone is at the maximum number of DNS records.', {
				count: zone.records.length,
				limit: this.recordLimit
			});
		}
		if (dryRun) return ok({ dryRun: true, wouldSucceed: true });
		this.#snapshot(zone, 'before-create');
		zone.records.push(next);
		return ok({ id: Number(next.id), ...this.#warnings(zone) });
	}

	#patched(current: Rec, body: Json): Rec {
		const next = { ...current };
		if (typeof body.name === 'string') next.host = body.name.toLowerCase();
		if (typeof body.type === 'string') next.type = body.type.toUpperCase();
		if (typeof body.content === 'string') next.content = body.content;
		if (body.ttl !== undefined && body.ttl !== null)
			next.ttl = Math.max(MIN_TTL, Number(body.ttl) || MIN_TTL);
		if (body.prio !== undefined && body.prio !== null) next.prio = Number(body.prio);
		if (typeof body.notes === 'string') next.notes = body.notes === '' ? null : body.notes;
		return next;
	}

	#edit(zone: Zone, id: string | undefined, body: Json, dryRun: boolean): Out {
		const current = zone.records.find((r) => r.id === id);
		if (!current) return fail(400, 'INVALID_RECORD_ID', 'Invalid record ID.');
		const next = this.#patched(current, body);
		const refused = this.#refusal(zone, next, current);
		if (refused) return refused;
		if (dryRun) return ok({ dryRun: true, wouldSucceed: true });
		this.#snapshot(zone, 'before-edit');
		Object.assign(current, next);
		return ok(this.#warnings(zone));
	}

	#matching(zone: Zone, type: string | undefined, host: string): Rec[] | Out {
		const t = (type ?? '').toUpperCase();
		if (t === 'NS' || t === 'SOA')
			return fail(400, 'INVALID_TYPE', 'NS and SOA records can not be changed by name and type.');
		if (!RECORD_TYPES.includes(t)) return fail(400, 'INVALID_TYPE', 'Invalid record type.');
		const list = zone.records.filter((r) => r.type === t && r.host === host.toLowerCase());
		// fake-only: the spec does not name the code for "nothing matched".
		if (list.length === 0) return fail(400, 'INVALID_RECORD_ID', 'No records match that name and type.');
		return list;
	}

	#editByNameType(zone: Zone, type: string | undefined, host: string, body: Json, dryRun: boolean): Out {
		const list = this.#matching(zone, type, host);
		if (!Array.isArray(list)) return list;
		if (typeof body.content !== 'string' || body.content === '')
			return fail(400, 'MISSING_PARAMETER', 'content is required.');
		if (dryRun) return ok({ dryRun: true, wouldSucceed: true });
		this.#snapshot(zone, 'before-edit');
		// Every match gets the same content, so they collapse into one record.
		const [first, ...rest] = list;
		Object.assign(first as Rec, this.#patched(first as Rec, { ...body, name: undefined, type: undefined }));
		zone.records = zone.records.filter((r) => !rest.includes(r));
		return ok(this.#warnings(zone));
	}

	#delete(zone: Zone, id: string | undefined, dryRun: boolean): Out {
		const current = zone.records.find((r) => r.id === id);
		if (!current) return fail(400, 'INVALID_RECORD_ID', 'Invalid record ID.');
		if (dryRun) return ok({ dryRun: true, wouldSucceed: true });
		this.#snapshot(zone, 'before-delete');
		zone.records = zone.records.filter((r) => r !== current);
		return ok(this.#warnings(zone));
	}

	#deleteByNameType(zone: Zone, type: string | undefined, host: string, dryRun: boolean): Out {
		const list = this.#matching(zone, type, host);
		if (!Array.isArray(list)) return list;
		if (dryRun) return ok({ dryRun: true, wouldSucceed: true });
		this.#snapshot(zone, 'before-delete');
		zone.records = zone.records.filter((r) => !list.includes(r));
		return ok(this.#warnings(zone));
	}

	// ── Restore points ───────────────────────────────────────────────────────────────────────────────────

	#snapJson(zone: Zone, r: Rec): Json {
		return { name: this.#fqdn(zone, r.host), type: r.type, content: r.content, ttl: r.ttl, prio: r.prio };
	}

	#compare(zone: Zone, snap: Snap): { missing: Rec[]; extra: Rec[] } {
		const scaffold = (r: Rec) => r.type === 'NS' || r.type === 'SOA';
		return {
			missing: snap.records.filter((s) => !scaffold(s) && !zone.records.some((r) => sameData(r, s))),
			extra: zone.records.filter((r) => !scaffold(r) && !snap.records.some((s) => sameData(r, s)))
		};
	}

	#history(zone: Zone): Out {
		return ok({
			domain: zone.meta.domain,
			restorePoints: zone.snaps.map((s) => {
				const { missing, extra } = this.#compare(zone, s);
				return {
					id: s.id,
					takenAt: stamp(s.takenAt),
					reason: s.reason,
					source: s.source,
					recordCount: s.records.length,
					matchesLive: missing.length === 0 && extra.length === 0
				};
			})
		});
	}

	#findSnap(zone: Zone, id: number): Snap | Out {
		const snap = zone.snaps.find((s) => s.id === id);
		return (
			snap ??
			fail(
				404,
				'RESTORE_POINT_NOT_FOUND',
				'That restore point does not exist for this domain.',
				{},
				{
					type: 'fix_request',
					hint: `List them with GET /dns/history/${zone.meta.domain}.`,
					retryable: false
				}
			)
		);
	}

	#diff(zone: Zone, id: number): Out {
		const snap = this.#findSnap(zone, id);
		if ('status' in snap) return snap;
		const { missing, extra } = this.#compare(zone, snap);
		return ok({
			domain: zone.meta.domain,
			snapshot: { id: snap.id, takenAt: stamp(snap.takenAt), reason: snap.reason },
			missing: missing.map((r) => this.#snapJson(zone, r)),
			extra: extra.map((r) => this.#snapJson(zone, r)),
			inSync: missing.length === 0 && extra.length === 0
		});
	}

	#restore(zone: Zone, body: Json, dryRun: boolean): Out {
		const id = Number(body.snapshotId);
		if (!Number.isInteger(id)) return fail(400, 'MISSING_PARAMETER', 'snapshotId is required.');
		const snap = this.#findSnap(zone, id);
		if ('status' in snap) return snap;
		if (snap.records.length === 0)
			return fail(400, 'RESTORE_POINT_EMPTY', 'The restore point holds no records.');
		const prune = body.prune === true;
		const { missing, extra } = this.#compare(zone, snap);
		const failed = missing.filter((r) => MASKED_TYPES.includes(r.type));
		const addable = missing.filter((r) => !MASKED_TYPES.includes(r.type));
		const summary = {
			domain: zone.meta.domain,
			restoredFrom: snap.id,
			restored: addable.length,
			removed: prune ? extra.length : 0,
			failed: failed.map((r) => ({
				name: this.#fqdn(zone, r.host),
				type: r.type,
				reason: 'This record type is managed elsewhere and can not be recreated by a restore.'
			}))
		};
		if (dryRun) return ok({ dryRun: true, wouldSucceed: true, ...summary });
		const saved = this.#snapshot(zone, `before-restore-${snap.id}`, true);
		if (prune) zone.records = zone.records.filter((r) => !extra.includes(r));
		for (const r of addable) zone.records.push({ ...r, id: String(this.#nextId++) });
		return ok({ ...summary, previousStateSavedAs: saved, ...this.#warnings(zone) });
	}

	#preflight(zone: Zone, intent: string): Out {
		const intents = ['general', 'move-nameservers', 'transfer-out', 'enable-dnssec'];
		if (!intents.includes(intent))
			return fail(400, 'INVALID_VALUE', `intent must be one of ${intents.join(', ')}.`);
		const checks: Json[] = [];
		const add = (id: string, severity: string, bad: boolean, title: string, detail: string, next: string) =>
			checks.push({ id, severity, ok: !bad, title, detail, ...(bad ? { next_action: next } : {}) });

		if (intent !== 'enable-dnssec') {
			add(
				'dnssec-active',
				'blocker',
				zone.dnssec.length > 0 && intent !== 'general',
				'DNSSEC is active',
				'DS records are published, so new nameservers would serve answers that do not match them and validating resolvers would refuse the whole zone.',
				'Remove DNSSEC, wait for the DS TTL, then move.'
			);
		}
		const cnameHosts = new Set(zone.records.filter((r) => r.type === 'CNAME').map((r) => r.host));
		const shared = zone.records.some((r) => r.type !== 'CNAME' && cnameHosts.has(r.host));
		add(
			'cname-exclusivity',
			'blocker',
			shared,
			'CNAME shares a name',
			'A CNAME can not share a name with another record type (RFC 1034).',
			'Delete either the CNAME or the other records at that name.'
		);
		const apex = zone.records.some((r) => r.host === '' && ['A', 'AAAA', 'ALIAS', 'CNAME'].includes(r.type));
		add(
			'apex-resolves',
			'warning',
			!apex,
			'Nothing answers at the bare domain',
			'There is no address record at the apex.',
			'Add an A, AAAA or ALIAS record at the apex.'
		);
		const foreign = zone.ns.some((n) => !n.toLowerCase().endsWith('.ns.porkbun.com'));
		add(
			'nameservers-ours',
			'warning',
			foreign,
			'The domain is delegated elsewhere',
			'The domain is delegated to nameservers Porkbun does not operate, so this zone is not what the world resolves.',
			'Make DNS changes where those nameservers are managed, or point the domain back at Porkbun.'
		);
		const failing = checks.filter((c) => c.ok === false);
		const blockers = failing.filter((c) => c.severity === 'blocker').map((c) => c.id as string);
		const warnings = failing.filter((c) => c.severity === 'warning').map((c) => c.id as string);
		return ok({
			domain: zone.meta.domain,
			intent,
			safe: blockers.length === 0 && warnings.length === 0,
			blockers,
			warnings,
			checks
		});
	}

	#scan(zone: Zone): Json[] {
		if (zone.meta.scan) return zone.meta.scan.map((r) => ({ ...r }));
		return zone.records.map((r) => ({
			name: r.host,
			type: r.type,
			content: r.content,
			ttl: r.ttl,
			...(r.prio === null ? {} : { prio: r.prio })
		}));
	}

	#import(zone: Zone, body: Json, dryRun: boolean): Out {
		const given = Array.isArray(body.records) ? body.records.filter(isObj) : this.#scan(zone);
		if (given.length > 500)
			return fail(400, 'TOO_MANY_RECORDS', 'At most 500 records can be imported in one call.');
		const wanted = given.filter((r) => !['NS', 'SOA'].includes(String(r.type).toUpperCase()));
		if (wanted.length === 0)
			return fail(400, 'NOTHING_TO_IMPORT', 'No records were supplied and none could be discovered.');
		let created = 0;
		let skipped = 0;
		const failures: Json[] = [];
		const staged: Rec[] = [];
		const suffix = '.' + zone.meta.domain;
		for (const r of wanted) {
			let name = String(r.name ?? '')
				.toLowerCase()
				.replace(/\.$/, '');
			if (name === '@' || name === zone.meta.domain) name = '';
			else if (name.endsWith(suffix)) name = name.slice(0, -suffix.length);
			const next = this.#rec({
				name,
				type: String(r.type ?? ''),
				content: String(r.content ?? ''),
				ttl: Number(r.ttl) || undefined,
				prio: r.prio === undefined || r.prio === null ? undefined : Number(r.prio)
			});
			const refused = this.#refusal({ ...zone, records: [...zone.records, ...staged] }, next, null);
			if (!refused) {
				created++;
				staged.push(next);
			} else if (refused.body.code === 'DUPLICATE_RECORD') skipped++;
			else failures.push({ name: next.host, type: next.type, reason: refused.body.message });
		}
		if (created === 0 && skipped === 0) {
			return fail(400, 'NOTHING_TO_IMPORT', 'None of the supplied records could be imported.', { failures });
		}
		const summary = { domain: zone.meta.domain, created, skipped, failed: failures.length, failures };
		if (dryRun) return ok({ dryRun: true, wouldSucceed: true, ...summary });
		if (created > 0) {
			this.#snapshot(zone, 'before-import', true);
			zone.records.push(...staged);
		}
		return ok({ ...summary, ...this.#warnings(zone) });
	}

	#createDnssec(zone: Zone, body: Json): Out {
		const field = (k: string) =>
			typeof body[k] === 'string' || typeof body[k] === 'number' ? String(body[k]) : '';
		for (const k of ['keyTag', 'alg', 'digestType', 'digest']) {
			if (field(k) === '') return fail(400, 'MISSING_PARAMETER', `${k} is required.`);
		}
		if (DEPRECATED_DNSSEC_ALGS.includes(field('alg'))) {
			return fail(
				400,
				'DNSSEC_ALGORITHM_DEPRECATED',
				'The registry no longer accepts this DNSSEC algorithm.',
				{},
				{
					type: 'fix_request',
					hint: 'Use algorithm 8 or 13 with digest type 2.',
					retryable: false
				}
			);
		}
		if (zone.dnssec.some((d) => d.keyTag === field('keyTag'))) {
			return fail(
				400,
				'DNSSEC_CREATE_FAILED',
				'The registry refused the DS record: a record with this key tag exists.'
			);
		}
		zone.dnssec.push({
			keyTag: field('keyTag'),
			alg: field('alg'),
			digestType: field('digestType'),
			digest: field('digest')
		});
		return field('digestType') === '1'
			? ok({ warnings: ['Digest type 1 (SHA-1) is being retired by this registry. The record was created.'] })
			: ok();
	}

	// ── Pricing ──────────────────────────────────────────────────────────────────────────────────────────

	#pricing(query: Record<string, string>, body: Json): Out {
		const asked: string[] = [];
		const one = query.tld ?? body.tld;
		const many = query.tlds ?? body.tlds;
		if (typeof one === 'string') asked.push(one);
		if (typeof many === 'string') asked.push(...many.split(','));
		if (Array.isArray(many)) asked.push(...many.filter((t): t is string => typeof t === 'string'));
		const names = asked.map((t) => t.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
		if (names.length === 0) return ok({ pricing: structuredClone(this.#seed.pricing) });
		const pricing: Json = {};
		const unsupported: string[] = [];
		for (const t of names) {
			const price = this.#seed.pricing[t];
			if (price) pricing[t] = { ...price };
			else unsupported.push(t);
		}
		if (Object.keys(pricing).length === 0) {
			return fail(400, 'INVALID_TLD', `None of the requested TLDs is sold: ${unsupported.join(', ')}.`);
		}
		return ok(unsupported.length > 0 ? { unsupported, pricing } : { pricing });
	}
}
