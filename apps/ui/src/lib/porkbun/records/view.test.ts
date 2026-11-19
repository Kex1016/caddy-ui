import { describe, expect, it } from 'vitest';
import type { DnsRecord } from '$lib/api/porkbun';
import { planChanges } from './plan';
import {
	batchHeadline,
	blockedReason,
	overallDryRun,
	problemCount,
	reviewChanges,
	statusText
} from './review';
import { inSendOrder, inputOf, stageCreate, stageDelete, stageEdit, type Pending } from './tray';
import type { BatchItemStatus, BatchResult, Preview, PreviewItem } from './types';
import { buildRows, countTypes, groupRows, matches, ttlLabel } from './view';

const D = 'example.com';

let nextId = 1;
const rec = (host: string, type: string, content: string, extra: Partial<DnsRecord> = {}): DnsRecord => ({
	id: String(nextId++),
	name: host === '' ? D : `${host}.${D}`,
	host,
	type,
	content,
	ttl: 600,
	prio: null,
	notes: null,
	...extra
});

const zone = () => {
	nextId = 1;
	return [
		rec('www', 'A', '203.0.113.10', { notes: 'served by Caddy' }), // 1
		rec('', 'MX', 'mail.example.com', { prio: 10 }), // 2
		rec('', 'A', '203.0.113.10'), // 3
		rec('blog', 'CNAME', 'example.org', { ttl: 3600 }), // 4
		rec('api.www', 'A', '203.0.113.12'), // 5
		rec('odd', 'LOC', '52 22 23.000 N 4 53 32.000 E -2.00m') // 6
	];
};

function tray(z: DnsRecord[]): Pending[] {
	let t = stageCreate([], { host: 'new', type: 'TXT', content: 'hello', notes: 'fresh' });
	t = stageEdit(t, z[0] as DnsRecord, { ...inputOf(z[0] as DnsRecord), host: 'web', ttl: 900 });
	t = stageDelete(t, [z[3] as DnsRecord]);
	return t;
}

describe('the records table', () => {
	it('lays the pending changes over the zone', () => {
		const z = zone();
		const rows = buildRows(z, tray(z), D);
		expect(rows.map((r) => [r.key, r.state, r.name])).toEqual([
			['3', 'live', 'example.com'],
			['2', 'live', 'example.com'],
			['4', 'deleted', 'blog.example.com'],
			['new:1', 'new', 'new.example.com'],
			['6', 'live', 'odd.example.com'],
			['1', 'edited', 'web.example.com'],
			['5', 'live', 'api.www.example.com']
		]);
		const edited = rows.find((r) => r.key === '1');
		expect(edited).toMatchObject({
			changed: ['host', 'ttl'],
			shown: { host: 'web', ttl: 900, notes: 'served by Caddy' }
		});
		expect(edited?.live?.host).toBe('www');
		expect(rows.find((r) => r.key === 'new:1')).toMatchObject({
			live: null,
			shown: { ttl: 600, notes: 'fresh' }
		});
		expect(rows.find((r) => r.key === '6')?.known).toBe(false);
	});

	it('groups rows under their name, the apex first and a subdomain under its parent', () => {
		const z = zone();
		const groups = groupRows(buildRows(z, [], D));
		expect(groups.map((g) => [g.name, g.rows.map((r) => r.shown.type)])).toEqual([
			['example.com', ['A', 'MX']],
			['blog.example.com', ['CNAME']],
			['odd.example.com', ['LOC']],
			['www.example.com', ['A']],
			['api.www.example.com', ['A']]
		]);
	});

	it('counts the types present, in the order of the type picker', () => {
		const z = zone();
		expect(countTypes(buildRows(z, tray(z), D))).toEqual([
			{ type: 'A', count: 3 },
			{ type: 'MX', count: 1 },
			{ type: 'CNAME', count: 1 },
			{ type: 'TXT', count: 1 },
			{ type: 'LOC', count: 1 }
		]);
	});

	it('filters by type, by pending changes and by every word of the search', () => {
		const z = zone();
		const rows = buildRows(z, tray(z), D);
		const keys = (filter: Parameters<typeof matches>[1]) =>
			rows.filter((r) => matches(r, filter)).map((r) => r.key);
		expect(keys({ query: '', type: 'A' })).toEqual(['3', '1', '5']);
		expect(keys({ query: '', type: '', pendingOnly: true })).toEqual(['4', 'new:1', '1']);
		expect(keys({ query: 'caddy', type: '' })).toEqual(['1']);
		expect(keys({ query: '  MAIL  mx ', type: '' })).toEqual(['2']);
		expect(keys({ query: 'www 203.0.113.12', type: '' })).toEqual(['5']);
		expect(keys({ query: 'www', type: 'MX' })).toEqual([]);
		// The record that is being moved is still found by where it is now.
		expect(keys({ query: 'web.example.com', type: '' })).toEqual(['1']);
	});

	it('writes a TTL in the largest unit that divides it', () => {
		expect([600, 3600, 86400, 172800, 90, 45, 5400].map(ttlLabel)).toEqual([
			'10 min',
			'1 h',
			'1 d',
			'2 d',
			'90 s',
			'45 s',
			'90 min'
		]);
	});
});

describe('the review of a batch', () => {
	const marks = {
		'4': { managedByCaddy: false, sites: [{ host: 'blog.example.com', href: null, disabled: false }] }
	};

	it('shows every change with before and after, and what depends on it', () => {
		const z = zone();
		const sent = inSendOrder(tray(z)).map((p) => p.change);
		const lines = reviewChanges(planChanges(z, sent, D), sent, marks);
		expect(lines).toEqual([
			{
				kind: 'delete',
				title: 'CNAME blog.example.com',
				before: 'example.org · TTL 3600',
				note: 'Used by the site blog.example.com: without this record it can not be reached.'
			},
			{
				kind: 'edit',
				title: 'A web.example.com',
				before: '203.0.113.10 · TTL 600 · note: served by Caddy',
				after: '203.0.113.10 · TTL 900 · note: served by Caddy'
			},
			{ kind: 'create', title: 'TXT new.example.com', after: 'hello · TTL 600 · note: fresh' }
		]);
	});

	it('says why a change can not be applied, and blocks the batch', () => {
		const z = zone();
		const sent = [
			{ op: 'create' as const, record: { host: 'blog', type: 'TXT' as const, content: 'x' } },
			{ op: 'delete' as const, id: '999' }
		];
		const plan = planChanges(z, sent, D);
		const lines = reviewChanges(plan, sent);
		expect(lines[0]?.note).toMatch(/^Can not be applied: .*blog\.example\.com has a CNAME record/);
		expect(lines[1]).toMatchObject({ kind: 'delete', title: 'Change 2' });
		expect(lines[1]?.note).toMatch(/no longer in the zone/);
		expect(problemCount(plan)).toBe(2);
		expect(blockedReason(plan)).toMatch(/^2 changes can not be applied/);
		expect(blockedReason(plan.slice(0, 1))).toMatch(/^One change can not be applied/);
		expect(blockedReason(planChanges(z, [], D))).toBeNull();
	});

	it('says what Porkbun could not rehearse and what it would refuse', () => {
		const z = zone();
		const sent = [
			{ op: 'delete' as const, id: '4' },
			{
				op: 'create' as const,
				record: { host: 'blog', type: 'A' as const, content: '198.51.100.1', ttl: 300 }
			},
			{ op: 'edit' as const, id: '3', record: { host: '', type: 'A' as const, content: '203.0.113.10' } }
		];
		const plan = planChanges(z, sent, D);
		const refusal = { code: 'ZONE_RECORD_LIMIT', message: 'The zone is full.', retryable: false };
		const items: PreviewItem[] = [
			{ ...(plan[0] as PreviewItem), dryRun: { wouldSucceed: false, warnings: ['w1'], error: refusal } },
			{ ...(plan[1] as PreviewItem), dryRun: null },
			{ ...(plan[2] as PreviewItem), dryRun: null }
		];
		const lines = reviewChanges(items, sent);
		expect(lines[0]?.note).toBe('Porkbun would refuse this: The zone is full.');
		expect(lines[1]?.note).toMatch(/^Porkbun can not rehearse this one on its own/);
		expect(lines[1]?.note).toMatch(/raises a TTL below its minimum/);
		expect(lines[2]?.note).toBe('Already as asked. Nothing is sent for this one.');

		const preview: Preview = { items, wouldSucceed: false, warnings: ['w1'], fetchedAt: 0, confirm: false };
		expect(overallDryRun(preview)).toEqual({ wouldSucceed: false, warnings: ['w1'], error: refusal });
		const fine: Preview = {
			...preview,
			items: [{ ...(plan[0] as PreviewItem), dryRun: { wouldSucceed: true, warnings: [] } }],
			warnings: []
		};
		expect(overallDryRun(fine)).toEqual({ wouldSucceed: true, warnings: [] });
		// Nothing was rehearsed: there is no verdict to show.
		expect(overallDryRun({ ...preview, items: items.slice(1) })).toBeNull();
	});

	it('sums up what a batch did', () => {
		const result = (statuses: BatchItemStatus[]): BatchResult => {
			const counts = { applied: 0, unchanged: 0, adopted: 0, failed: 0, not_applied: 0 };
			for (const s of statuses) counts[s]++;
			return {
				ok: counts.failed + counts.not_applied === 0,
				counts,
				warnings: [],
				items: statuses.map((status, index) => ({
					index,
					status,
					op: 'create',
					name: '',
					type: 'A',
					warnings: []
				}))
			};
		};
		expect(batchHeadline(result(['applied']))).toBe('1 change applied');
		expect(batchHeadline(result(['applied', 'unchanged', 'adopted']))).toBe('3 changes applied');
		expect(batchHeadline(result(['applied', 'failed', 'not_applied', 'not_applied']))).toBe(
			'1 of 4 changes applied'
		);
		expect(statusText('not_applied')).toBe('Not sent');
		expect(statusText('adopted')).toBe('Already there');
	});
});
