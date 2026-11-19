import { describe, expect, it } from 'vitest';
import type { DnsRecord, DnsRecordInput } from '$lib/api/porkbun';
import {
	afterBatch,
	inSendOrder,
	inputOf,
	pendingFor,
	restoreTray,
	serialiseTray,
	stageCreate,
	stageDelete,
	stageEdit,
	trayStorageKey,
	unstage,
	type Pending
} from './tray';
import type { BatchItemStatus, BatchResult } from './types';

const live = (id: string, extra: Partial<DnsRecord> = {}): DnsRecord => ({
	id,
	name: 'www.example.com',
	host: 'www',
	type: 'A',
	content: '203.0.113.10',
	ttl: 600,
	prio: null,
	notes: null,
	...extra
});

const a = (host: string, content = '198.51.100.1'): DnsRecordInput => ({ host, type: 'A', content });

function result(statuses: BatchItemStatus[]): BatchResult {
	const counts = { applied: 0, unchanged: 0, adopted: 0, failed: 0, not_applied: 0 };
	const items = statuses.map((status, index) => {
		counts[status]++;
		return { index, status, op: 'create' as const, name: '', type: 'A', warnings: [] };
	});
	return { ok: counts.failed + counts.not_applied === 0, items, counts, warnings: [] };
}

describe('the pending changes', () => {
	it('gives every record to add its own key, and replaces one that is edited again', () => {
		let tray = stageCreate([], a('one'));
		tray = stageCreate(tray, a('two'));
		expect(tray.map((p) => p.key)).toEqual(['new:1', 'new:2']);
		tray = stageCreate(tray, a('uno'), 'new:1');
		expect(tray.map((p) => [p.key, p.change.op === 'create' && p.change.record.host])).toEqual([
			['new:1', 'uno'],
			['new:2', 'two']
		]);
		tray = unstage(tray, 'new:1');
		expect(stageCreate(tray, a('three')).map((p) => p.key)).toEqual(['new:2', 'new:3']);
	});

	it('keeps what the record was when an edit was decided', () => {
		const record = live('7', { notes: 'old' });
		const tray = stageEdit([], record, { ...inputOf(record), content: '203.0.113.11' });
		expect(tray).toEqual([
			{
				key: 'id:7',
				change: {
					op: 'edit',
					id: '7',
					record: { host: 'www', type: 'A', content: '203.0.113.11', ttl: 600, notes: 'old' },
					expect: { host: 'www', type: 'A', content: '203.0.113.10', ttl: 600, prio: null, notes: 'old' }
				}
			}
		]);
		expect(pendingFor(tray, '7')?.change.op).toBe('edit');
		expect(pendingFor(tray, '8')).toBeUndefined();
	});

	it('takes an edit out again when it leaves the record as it is', () => {
		const record = live('7');
		let tray = stageEdit([], record, { ...inputOf(record), ttl: 3600 });
		expect(tray).toHaveLength(1);
		tray = stageEdit(tray, record, inputOf(record));
		expect(tray).toEqual([]);
		// Empty notes and no notes are the same record; so are a missing priority and 0.
		expect(stageEdit([], record, { ...inputOf(record), notes: '', prio: 0 })).toEqual([]);
	});

	it('keeps an edited record in its place in the list', () => {
		const one = live('1');
		const two = live('2', { host: 'two' });
		let tray = stageEdit([], one, { ...inputOf(one), ttl: 900 });
		tray = stageEdit(tray, two, { ...inputOf(two), ttl: 900 });
		tray = stageEdit(tray, one, { ...inputOf(one), ttl: 1800 });
		expect(tray.map((p) => p.key)).toEqual(['id:1', 'id:2']);
	});

	it('lets a delete take the place of an edit of the same record', () => {
		const record = live('7');
		let tray = stageEdit([], record, { ...inputOf(record), ttl: 3600 });
		tray = stageDelete(tray, [record, live('8')]);
		expect(tray.map((p) => [p.key, p.change.op])).toEqual([
			['id:7', 'delete'],
			['id:8', 'delete']
		]);
		expect(tray[0]?.change).toMatchObject({ expect: { content: '203.0.113.10', ttl: 600 } });
	});

	it('sends deletes first, then edits, then new records, each in the order they were made', () => {
		const record = live('7');
		let tray = stageCreate([], a('new-one'));
		tray = stageEdit(tray, record, { ...inputOf(record), ttl: 3600 });
		tray = stageDelete(tray, [live('8')]);
		tray = stageCreate(tray, a('new-two'));
		tray = stageDelete(tray, [live('9')]);
		expect(inSendOrder(tray).map((p) => p.key)).toEqual(['id:8', 'id:9', 'id:7', 'new:1', 'new:2']);
		// The tray itself keeps the order things were decided in.
		expect(tray.map((p) => p.key)).toEqual(['new:1', 'id:7', 'id:8', 'new:2', 'id:9']);
	});

	it('keeps what failed or was not sent after a batch', () => {
		let tray = stageCreate([], a('one'));
		tray = stageCreate(tray, a('two'));
		tray = stageCreate(tray, a('three'));
		tray = stageCreate(tray, a('four'));
		tray = stageDelete(tray, [live('5')]);
		const sent = inSendOrder(tray);
		const left = afterBatch(tray, sent, result(['applied', 'adopted', 'unchanged', 'failed', 'not_applied']));
		expect(left.map((p) => p.key)).toEqual(['new:3', 'new:4']);
		expect(afterBatch(tray, sent, result(['applied', 'applied', 'applied', 'applied', 'applied']))).toEqual(
			[]
		);
	});

	it('turns a live record into the input an edit starts from', () => {
		expect(inputOf(live('1', { type: 'MX', content: 'mail.example.com', prio: 10, notes: 'n' }))).toEqual({
			host: 'www',
			type: 'MX',
			content: 'mail.example.com',
			ttl: 600,
			prio: 10,
			notes: 'n'
		});
		expect(inputOf(live('1'))).toEqual({
			host: 'www',
			type: 'A',
			content: '203.0.113.10',
			ttl: 600,
			notes: ''
		});
	});
});

describe('the stored tray', () => {
	it('has one entry per domain', () => {
		expect(trayStorageKey('example.com')).toBe('caddy-ui:dns-tray:example.com');
	});

	it('comes back as it was stored', () => {
		const record = live('7', { type: 'MX', content: 'mail.example.com', prio: 10 });
		let tray: Pending[] = stageCreate([], { host: '', type: 'TXT', content: 'hello', ttl: 900, notes: 'n' });
		tray = stageEdit(tray, record, { ...inputOf(record), prio: 20 });
		tray = stageDelete(tray, [live('8')]);
		expect(restoreTray(serialiseTray(tray))).toEqual(tray);
	});

	it.each([null, undefined, '', 'not json', '[]', '{"v":2,"items":[]}', '{"v":1,"items":"x"}'])(
		'is empty for %j',
		(text) => {
			expect(restoreTray(text)).toEqual([]);
		}
	);

	it('drops entries that are not changes, one by one', () => {
		const good = {
			key: 'new:1',
			change: { op: 'create', record: { host: 'a', type: 'A', content: '198.51.100.1' } }
		};
		const text = JSON.stringify({
			v: 1,
			items: [
				good,
				good, // the same key twice
				{ key: 'new:2', change: { op: 'create', record: { host: 'a', type: 'LOC', content: 'x' } } },
				{ key: 'new:3', change: { op: 'create', record: { host: 'a', type: 'A', content: 5 } } },
				{
					key: 'new:4',
					change: { op: 'create', record: { host: 'a', type: 'A', content: 'x', ttl: '600' } }
				},
				{ key: 'id:9', change: { op: 'delete', id: '10' } }, // key and id disagree
				{ key: 'id:x', change: { op: 'delete', id: 'x' } },
				{ key: 'id:11', change: { op: 'edit', id: '11' } }, // an edit without a record
				{ key: 'id:12', change: { op: 'wipe', id: '12' } },
				{ key: 'id:13', change: { op: 'delete', id: '13', expect: { host: 'h' } } },
				'text',
				null
			]
		});
		expect(restoreTray(text)).toEqual([
			{ key: 'new:1', change: good.change },
			// A snapshot that is not whole is left out; the delete itself stands.
			{ key: 'id:13', change: { op: 'delete', id: '13' } }
		]);
	});
});
