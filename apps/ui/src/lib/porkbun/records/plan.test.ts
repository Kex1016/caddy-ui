import { describe, expect, it } from 'vitest';
import type { DnsRecord } from '$lib/api/porkbun';
import { patchOf, planChanges, summarise } from './plan';
import type { RecordChange } from './types';
import { snapshotOf } from './validate';

const D = 'example.com';

let nextId = 1;
function rec(host: string, type: string, content: string, extra: Partial<DnsRecord> = {}): DnsRecord {
	return {
		id: String(nextId++),
		name: host === '' ? D : `${host}.${D}`,
		host,
		type,
		content,
		ttl: 600,
		prio: null,
		notes: null,
		...extra
	};
}

const zone = () => {
	nextId = 1;
	return [
		rec('', 'A', '203.0.113.10'), // 1
		rec('www', 'A', '203.0.113.10', { notes: 'served by Caddy' }), // 2
		rec('blog', 'CNAME', 'example.org', { ttl: 3600 }), // 3
		rec('', 'MX', 'mail.example.com', { prio: 10 }), // 4
		rec('', 'TXT', 'v=spf1 mx -all'), // 5
		rec('odd', 'LOC', '52 22 23.000 N 4 53 32.000 E -2.00m') // 6: a type this build only shows
	];
};

const create = (host: string, type: string, content: string, extra: object = {}): RecordChange => ({
	op: 'create',
	record: { host, type, content, ...extra } as never
});

describe('planChanges', () => {
	it('works out a create, an edit and a delete, with before and after', () => {
		const z = zone();
		const plan = planChanges(
			z,
			[
				create('new', 'A', '198.51.100.1', { ttl: 900, notes: 'fresh' }),
				{ op: 'edit', id: '2', record: { host: 'www', type: 'A', content: '203.0.113.11', notes: '' } },
				{ op: 'delete', id: '4' }
			],
			D
		);
		expect(plan.map((p) => p.problems)).toEqual([[], [], []]);
		expect(plan[0]).toMatchObject({
			op: 'create',
			name: 'new.example.com',
			type: 'A',
			before: null,
			after: { host: 'new', type: 'A', content: '198.51.100.1', ttl: 900, prio: null, notes: 'fresh' },
			input: { host: 'new', type: 'A', content: '198.51.100.1', ttl: 900, notes: 'fresh' }
		});
		expect(plan[1]).toMatchObject({
			op: 'edit',
			name: 'www.example.com',
			before: { content: '203.0.113.10', notes: 'served by Caddy' },
			after: { content: '203.0.113.11', ttl: 600, notes: null },
			changed: ['content', 'notes']
		});
		expect(patchOf(plan[1] as never)).toEqual({ content: '203.0.113.11', notes: '' });
		expect(plan[2]).toMatchObject({ op: 'delete', name: 'example.com', type: 'MX', after: null });
		expect(plan[2]?.before).toMatchObject({ content: 'mail.example.com', prio: 10 });
	});

	it('sends nothing for an edit that changes nothing, and keeps what an edit leaves out', () => {
		const [same, ttlOnly] = planChanges(
			zone(),
			[
				{ op: 'edit', id: '2', record: { host: 'www', type: 'A', content: '203.0.113.10' } },
				{ op: 'edit', id: '3', record: { host: 'blog', type: 'CNAME', content: 'example.org', ttl: 600 } }
			],
			D
		);
		expect(same).toMatchObject({ changed: [], problems: [] });
		expect(same?.after?.notes).toBe('served by Caddy');
		expect(patchOf(same as never)).toEqual({});
		expect(ttlOnly?.changed).toEqual(['ttl']);
		expect(patchOf(ttlOnly as never)).toEqual({ ttl: 600 });
	});

	it('refuses an invalid record with the fields that are wrong', () => {
		const [p] = planChanges(zone(), [create('bad host', 'A', 'nope')], D);
		expect(p?.problems[0]).toMatchObject({ code: 'INVALID' });
		expect(p?.problems[0]?.fields?.map((f) => f.field)).toEqual(['host', 'content']);
	});

	it('finds a duplicate in the zone and in the batch itself', () => {
		const [inZone, first, again] = planChanges(
			zone(),
			[
				create('www', 'A', '203.0.113.10'),
				create('x', 'A', '198.51.100.1'),
				create('x', 'A', '198.51.100.1')
			],
			D
		);
		expect(inZone?.problems[0]).toMatchObject({ code: 'DUPLICATE' });
		expect(inZone?.problems[0]?.message).toMatch(/already an A record at www\.example\.com/);
		expect(first?.problems).toEqual([]);
		expect(again?.problems[0]?.message).toMatch(/earlier change in the same batch/);
	});

	it('keeps a CNAME alone at its name, both ways', () => {
		const [cnameOnA, aOnCname] = planChanges(
			zone(),
			[create('www', 'CNAME', 'target.example.net'), create('blog', 'TXT', 'hello')],
			D
		);
		expect(cnameOnA?.problems[0]).toMatchObject({ code: 'CNAME_CONFLICT' });
		expect(cnameOnA?.problems[0]?.message).toMatch(/www\.example\.com has 1 other record\. Delete it first/);
		expect(cnameOnA?.problems[0]?.records).toHaveLength(1);
		expect(aOnCname?.problems[0]).toMatchObject({ code: 'CNAME_CONFLICT' });
		expect(aOnCname?.problems[0]?.message).toMatch(/blog\.example\.com has a CNAME record/);
	});

	it('judges each change against the zone as earlier changes leave it', () => {
		const swap: RecordChange[] = [{ op: 'delete', id: '2' }, create('www', 'CNAME', 'target.example.net')];
		const inOrder = planChanges(zone(), swap, D);
		expect(inOrder.map((p) => p.problems)).toEqual([[], []]);
		// Porkbun's dry run would refuse the CNAME today, because the A record is still there.
		expect(inOrder.map((p) => p.needsEarlier)).toEqual([false, true]);

		const reversed = planChanges(zone(), [...swap].reverse(), D);
		expect(reversed[0]?.problems[0]?.code).toBe('CNAME_CONFLICT');
		expect(reversed[1]?.problems).toEqual([]);
	});

	it('lets an edit free a value for a later create', () => {
		const plan = planChanges(
			zone(),
			[
				{ op: 'edit', id: '1', record: { host: '', type: 'A', content: '203.0.113.99' } },
				create('', 'A', '203.0.113.10')
			],
			D
		);
		expect(plan.map((p) => p.problems)).toEqual([[], []]);
		expect(plan[1]?.needsEarlier).toBe(true);
	});

	it('refuses a second SPF record at the bare domain, and only there', () => {
		const [apex, sub] = planChanges(
			zone(),
			[create('', 'TXT', 'v=spf1 include:_spf.example.net ~all'), create('mail', 'TXT', 'v=spf1 a -all')],
			D
		);
		expect(apex?.problems[0]).toMatchObject({ code: 'SPF_CONFLICT' });
		expect(sub?.problems).toEqual([]);
	});

	it('notices a record that was changed or deleted somewhere else', () => {
		const z = zone();
		const seen = { ...snapshotOf(z[1] as DnsRecord), content: '203.0.113.9' };
		const [stale, fine, gone] = planChanges(
			z,
			[
				{ op: 'edit', id: '2', record: { host: 'www', type: 'A', content: '203.0.113.11' }, expect: seen },
				{ op: 'delete', id: '3', expect: snapshotOf(z[2] as DnsRecord) },
				{ op: 'delete', id: '999' }
			],
			D
		);
		expect(stale?.problems[0]).toMatchObject({ code: 'STALE' });
		expect(stale?.problems[0]?.message).toMatch(
			/It now reads: 203\.0\.113\.10 · TTL 600 · note: served by Caddy/
		);
		expect(fine?.problems).toEqual([]);
		expect(gone?.problems[0]).toMatchObject({ code: 'MISSING' });
	});

	it('refuses to change one record twice', () => {
		const [, second] = planChanges(
			zone(),
			[
				{ op: 'delete', id: '2' },
				{ op: 'edit', id: '2', record: { host: 'www', type: 'A', content: '203.0.113.11' } }
			],
			D
		);
		expect(second?.problems[0]).toMatchObject({ code: 'REPEATED' });
		expect(second?.problems[0]?.message).toMatch(/also by change 1/);
	});

	it('leaves records of a type it does not know alone', () => {
		const [edit, del] = planChanges(
			zone(),
			[
				{ op: 'edit', id: '6', record: { host: 'odd', type: 'A', content: '203.0.113.1' } },
				{ op: 'delete', id: '6' }
			],
			D
		);
		expect(edit?.problems[0]).toMatchObject({ code: 'READ_ONLY_TYPE' });
		expect(del?.problems[0]).toMatchObject({ code: 'REPEATED' });
		expect(planChanges(zone(), [{ op: 'delete', id: '6' }], D)[0]?.problems[0]?.code).toBe('READ_ONLY_TYPE');
	});

	it('does not let an edit change the type', () => {
		const [p] = planChanges(
			zone(),
			[{ op: 'edit', id: '2', record: { host: 'www', type: 'AAAA', content: '2001:db8::1' } }],
			D
		);
		expect(p?.problems[0]).toMatchObject({ code: 'TYPE_CHANGE' });
	});

	it('does not hold an old clash against an edit of the TTL or the notes', () => {
		const z = [...zone(), rec('blog', 'TXT', 'left over from before')];
		const [p] = planChanges(
			z,
			[
				{
					op: 'edit',
					id: '3',
					record: { host: 'blog', type: 'CNAME', content: 'example.org', notes: 'noted' }
				}
			],
			D
		);
		expect(p).toMatchObject({ problems: [], changed: ['notes'] });
	});

	it('moves a record to another name and checks the new place', () => {
		const [moved, clash] = planChanges(
			zone(),
			[
				{ op: 'edit', id: '2', record: { host: 'web', type: 'A', content: '203.0.113.10' } },
				{ op: 'edit', id: '1', record: { host: 'blog', type: 'A', content: '203.0.113.10' } }
			],
			D
		);
		expect(moved).toMatchObject({ name: 'web.example.com', changed: ['host'], problems: [] });
		expect(patchOf(moved as never)).toEqual({ host: 'web' });
		expect(clash?.problems[0]?.code).toBe('CNAME_CONFLICT');
	});

	it('lets an edit keep a stored value this page would not write, but not write a new one', () => {
		const stored = 'a form this build does not read';
		const z = [...zone(), rec('h3', 'HTTPS', stored), rec('old', 'MX', 'not a hostname', { prio: 5 })];
		const [retimed, moved, rewritten, reprioritised] = planChanges(
			z,
			[
				{
					op: 'edit',
					id: '7',
					record: { host: 'h3', type: 'HTTPS', content: stored, ttl: 3600, notes: 'kept' }
				},
				{ op: 'edit', id: '8', record: { host: 'older', type: 'MX', content: 'not a hostname', prio: 5 } }
			],
			D
		).concat(
			planChanges(
				z,
				[{ op: 'edit', id: '7', record: { host: 'h3', type: 'HTTPS', content: 'still not one' } }],
				D
			),
			planChanges(
				z,
				[{ op: 'edit', id: '8', record: { host: 'old', type: 'MX', content: 'not a hostname', prio: 6 } }],
				D
			)
		);
		expect(retimed).toMatchObject({ problems: [], changed: ['ttl', 'notes'] });
		expect(patchOf(retimed as never)).toEqual({ ttl: 3600, notes: 'kept' });
		expect(moved).toMatchObject({ problems: [], changed: ['host'], name: 'older.example.com' });
		expect(moved?.after).toMatchObject({ content: 'not a hostname', prio: 5 });
		expect(rewritten?.problems[0]).toMatchObject({ code: 'INVALID' });
		expect(rewritten?.problems[0]?.message).toMatch(/not the form of an HTTPS value/);
		expect(reprioritised?.problems[0]).toMatchObject({ code: 'INVALID' });
	});

	it('keeps the priority of an MX record through an edit', () => {
		const [p] = planChanges(
			zone(),
			[{ op: 'edit', id: '4', record: { host: '', type: 'MX', content: 'mx2.example.com', prio: 20 } }],
			D
		);
		expect(p?.after).toMatchObject({ content: 'mx2.example.com', prio: 20 });
		expect(patchOf(p as never)).toEqual({ content: 'mx2.example.com', prio: 20 });
	});
});

describe('summarise', () => {
	it('puts the priority in front where the type has one', () => {
		expect(
			summarise({ host: '', type: 'MX', content: 'mail.example.com', ttl: 600, prio: 10, notes: null })
		).toBe('10 mail.example.com · TTL 600');
		expect(summarise({ host: 'a', type: 'A', content: '203.0.113.1', ttl: 900, prio: 0, notes: 'n' })).toBe(
			'203.0.113.1 · TTL 900 · note: n'
		);
	});
});
