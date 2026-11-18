import type { DnsRecord } from '$lib/api/porkbun';
import type { ChallengeRecord } from '$lib/api/porkbun-caddy';
import type { Db } from '../../db';

/**
 * `_acme-challenge` TXT records (docs/porkbun-plan.md §4). Caddy creates one for a certificate order and
 * deletes it when the order is done, which takes minutes. One that is still there a day later was left
 * behind (Caddy was stopped mid-order, or the delete failed) and can be cleaned up.
 *
 * Porkbun does not say when a record was made, so this UI remembers when it first saw each one, by record
 * id, in the `settings` table. A record Caddy makes for a new order has a new id and starts fresh.
 */
const PREFIX = '_acme-challenge';
const SETTINGS_KEY = 'porkbun.caddy.challenges';
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

type Seen = Record<string, Record<string, number>>;

export function isChallenge(record: Pick<DnsRecord, 'type' | 'name'>): boolean {
	return record.type === 'TXT' && (record.name === PREFIX || record.name.startsWith(PREFIX + '.'));
}

/** The name a challenge record is for: `_acme-challenge.app.example.com` → `app.example.com`. */
export function challengeSubject(name: string): string {
	return name.slice(PREFIX.length + 1);
}

function readSeen(db: Db): Seen {
	const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as
		{ value: string } | undefined;
	if (!row) return {};
	try {
		const parsed = JSON.parse(row.value) as unknown;
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Seen) : {};
	} catch {
		return {};
	}
}

/**
 * The challenge records of one zone as it was just read, with when each was first seen. Remembers new ones
 * and forgets those that are gone. `hosts` are the site host names of the Caddyfile, to name the sites a
 * record belongs to.
 */
export function observeChallenges(
	db: Db,
	domain: string,
	records: readonly DnsRecord[],
	hosts: readonly string[],
	now: number
): ChallengeRecord[] {
	const seen = readSeen(db);
	const before = seen[domain] ?? {};
	const after: Record<string, number> = {};
	const out: ChallengeRecord[] = [];
	for (const r of records) {
		if (!isChallenge(r)) continue;
		const firstSeen = before[r.id] ?? now;
		after[r.id] = firstSeen;
		const subject = challengeSubject(r.name);
		out.push({
			id: r.id,
			domain,
			name: r.name,
			subject,
			content: r.content,
			firstSeen,
			stale: now - firstSeen > STALE_AFTER_MS,
			sites: hosts.filter((h) => h === subject || h === `*.${subject}`)
		});
	}
	const changed =
		Object.keys(before).length !== Object.keys(after).length ||
		Object.keys(after).some((id) => !(id in before));
	if (changed) {
		if (Object.keys(after).length > 0) seen[domain] = after;
		else delete seen[domain];
		db.prepare(
			'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
		).run(SETTINGS_KEY, JSON.stringify(seen));
	}
	return out;
}
