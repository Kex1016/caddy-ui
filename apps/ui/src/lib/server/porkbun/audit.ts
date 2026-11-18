import type { AuditEntry, AuditList } from '$lib/api/porkbun';
import type { Db } from '../db';
import { redactDeep } from './errors';

/**
 * The write log (`porkbun_audit`, docs/porkbun-plan.md §3). One row per write sent to Porkbun, successful or
 * not, with the state it replaced. Rows never hold an API key or a private key: every value is passed through
 * the client's redactor, and fields with a secret's name are blanked whatever they contain.
 */
export type AuditInput = {
	/** Who asked: `locals.identity.user`. */
	author: string;
	/** The domain, or '' for an account-wide action. */
	domain: string;
	/** Dotted, area first: `dns.create`, `dns.restore`, `ns.update`, `autorenew.set`. */
	action: string;
	/** What was sent, in this UI's terms. */
	request: unknown;
	/** The state the write replaced, where one was read. */
	before?: unknown;
	ok: boolean;
	/** Porkbun's answer on success, or `{ error }` on failure. */
	result: unknown;
	requestId?: string;
};

const SECRET_FIELD =
	/^(apikey|secretapikey|api[-_]?key|api[-_]?secret|private[-_]?key|x-api-key|x-secret-api-key|authorization)$/i;

function scrub(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(scrub);
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = SECRET_FIELD.test(k) ? '[redacted]' : scrub(v);
		return out;
	}
	return value;
}

const clean = (value: unknown, redact: (text: string) => string): string =>
	JSON.stringify(redactDeep(scrub(value ?? null), redact));

export function insertAudit(
	db: Db,
	entry: AuditInput,
	redact: (text: string) => string,
	now: number
): number {
	const res = db
		.prepare(
			'INSERT INTO porkbun_audit (ts, author, domain, action, request_json, before_json, ok, result_json, request_id) ' +
				'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
		)
		.run(
			now,
			redact(entry.author),
			entry.domain.toLowerCase(),
			entry.action,
			clean(entry.request, redact),
			entry.before === undefined ? null : clean(entry.before, redact),
			entry.ok ? 1 : 0,
			clean(entry.result, redact),
			entry.requestId ?? null
		);
	return Number(res.lastInsertRowid);
}

type Row = {
	id: number;
	ts: number;
	author: string;
	domain: string;
	action: string;
	request_json: string;
	before_json: string | null;
	ok: number;
	result_json: string;
	request_id: string | null;
};

function parse(text: string | null): unknown {
	if (text === null) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

export const AUDIT_PAGE = 100;

/** Newest first. `before` is the id to continue below (`nextBefore` of the previous page). */
export function listAudit(
	db: Db,
	opts: { domain?: string; limit?: number; before?: number } = {}
): AuditList {
	const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? AUDIT_PAGE)), 500);
	const where: string[] = [];
	const args: (string | number)[] = [];
	if (opts.domain) {
		where.push('domain = ?');
		args.push(opts.domain.toLowerCase());
	}
	if (opts.before !== undefined) {
		where.push('id < ?');
		args.push(opts.before);
	}
	const sql = `SELECT * FROM porkbun_audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
	const rows = db.prepare(sql).all(...args, limit + 1) as Row[];
	const page = rows.slice(0, limit);
	const entries: AuditEntry[] = page.map((r) => ({
		id: r.id,
		ts: r.ts,
		author: r.author,
		domain: r.domain,
		action: r.action,
		request: parse(r.request_json),
		before: parse(r.before_json),
		ok: r.ok === 1,
		result: parse(r.result_json),
		requestId: r.request_id
	}));
	const last = page[page.length - 1];
	return { entries, nextBefore: rows.length > limit && last ? last.id : null };
}
