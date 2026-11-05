import { json } from '@sveltejs/kit';
import { AdminError, AdminUnreachableError } from '../caddy/admin';
import { ApplyError } from './service';

/** Largest Caddyfile the API accepts. David's is about 10 KB; this leaves a lot of room. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export const noStore = { 'cache-control': 'no-store' };

export class BadRequest extends Error {}

/** Read `{ text, ...optional string fields }` from a JSON body, or throw BadRequest naming what is wrong. */
export async function readTextBody<K extends string>(
	request: Request,
	optional: readonly K[] = []
): Promise<{ text: string } & Partial<Record<K, string>>> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw new BadRequest('Send a JSON body such as {"text": "..."}');
	}
	if (!body || typeof body !== 'object') throw new BadRequest('Send a JSON object');
	const b = body as Record<string, unknown>;
	if (typeof b.text !== 'string') throw new BadRequest('"text" must be a string');
	if (Buffer.byteLength(b.text, 'utf8') > MAX_TEXT_BYTES) throw new BadRequest('"text" is larger than 2 MB');
	const out: Record<string, string> = { text: b.text };
	for (const key of optional) {
		const v = b[key];
		if (v === undefined || v === null) continue;
		if (typeof v !== 'string') throw new BadRequest(`"${key}" must be a string`);
		out[key] = v;
	}
	return out as { text: string } & Partial<Record<K, string>>;
}

export function authorOf(locals: App.Locals): string {
	return locals.identity?.user ?? 'unknown';
}

/** Turn the service's known failures into JSON responses; anything else is a real 500. */
export function failure(err: unknown): Response {
	if (err instanceof BadRequest) return json({ message: err.message }, { status: 400 });
	if (err instanceof ApplyError) return json(err.body, { status: err.status });
	if (err instanceof AdminUnreachableError)
		return json({ message: err.message, code: 'unreachable' }, { status: 503 });
	if (err instanceof AdminError) {
		return json(
			{ message: `Caddy answered ${err.status}: ${err.message}`, code: 'caddy_error' },
			{ status: 502 }
		);
	}
	throw err;
}
