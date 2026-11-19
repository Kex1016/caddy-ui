import { describe, expect, it } from 'vitest';
import { DNS_RECORD_TYPES, type DnsRecord } from '$lib/api/porkbun';
import { classifyImport, countVerdicts, sendable } from './import';
import { SAMPLES } from './samples';
import {
	compareRecords,
	parseImportText,
	parseJsonRecords,
	parseTtl,
	parseZoneFile,
	quoteTxt,
	rdataOf,
	toJsonExport,
	toZoneFile
} from './zonefile';

const D = 'example.com';
const AT = Date.UTC(2026, 10, 18, 22, 15, 0);

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

/** One record of every type, plus the awkward ones: long text, quotes, other scripts, a wildcard, the apex. */
function everything(): DnsRecord[] {
	const out = DNS_RECORD_TYPES.map((type) => {
		const s = SAMPLES[type];
		return rec(s.host, type, s.content, { prio: s.prio ?? null, ttl: type === 'CAA' ? 3600 : 600 });
	});
	out.push(
		rec('', 'A', '203.0.113.10'),
		rec('*', 'A', '203.0.113.10'),
		rec('', 'MX', 'mail.example.com', { prio: 10 }),
		rec('', 'MX', 'backup.example.net', { prio: 20, ttl: 86400 }),
		rec('', 'TXT', 'v=spf1 mx -all'),
		rec('key1._domainkey', 'TXT', `v=DKIM1; k=rsa; p=${'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A'.repeat(14)}`),
		rec('odd', 'TXT', 'say "hi" \\ back; semi (paren) and ünïcödé ✓'),
		rec('_sip._tcp', 'SRV', '5 5060 sip.example.com', { prio: 0 }),
		rec('_none._tcp', 'SRV', '0 0 .', { prio: 0 }),
		rec('www', 'A', '203.0.113.10', { notes: 'served by Caddy' })
	);
	return out;
}

const data = (r: { host: string; type: string; content: string; ttl?: number; prio?: number | null }) => ({
	host: r.host,
	type: r.type,
	content: r.content,
	ttl: r.ttl,
	prio: r.prio ?? null
});

describe('toZoneFile', () => {
	it('writes each type in zone file spelling', () => {
		const text = toZoneFile(
			D,
			[
				rec('', 'A', '203.0.113.10'),
				rec('www', 'CNAME', 'example.org', { ttl: 3600, notes: 'the blog\nmoved' }),
				rec('', 'MX', 'mail.example.com', { prio: 10 }),
				rec('', 'TXT', 'v=spf1 mx -all'),
				rec('_sip._tcp', 'SRV', '5 5060 sip.example.com', { prio: 0 }),
				rec('', 'CAA', '0 issue "letsencrypt.org"'),
				rec('h3', 'HTTPS', '1 svc.example.net alpn="h3,h2"'),
				rec('', 'ALIAS', 'target.example.net')
			],
			{ at: AT }
		);
		expect(text.split('\n')).toEqual([
			'; Zone file for example.com',
			'; Records as Porkbun had them on 2026-11-18T22:15:00Z, exported by Caddy UI.',
			"; The SOA record and Porkbun's own NS records are not part of this file.",
			'; ALIAS is not a standard record type. Other DNS software may call it ANAME, or refuse it.',
			'$ORIGIN example.com.',
			'$TTL 600',
			'@\t600\tIN\tA\t203.0.113.10',
			'@\t600\tIN\tMX\t10 mail.example.com.',
			'@\t600\tIN\tALIAS\ttarget.example.net.',
			'@\t600\tIN\tTXT\t"v=spf1 mx -all"',
			'@\t600\tIN\tCAA\t0 issue "letsencrypt.org"',
			'_sip._tcp\t600\tIN\tSRV\t0 5 5060 sip.example.com.',
			'h3\t600\tIN\tHTTPS\t1 svc.example.net. alpn="h3,h2"',
			'www\t3600\tIN\tCNAME\texample.org.\t; note: the blog moved',
			''
		]);
	});

	it('says when the copy is not fresh', () => {
		expect(toZoneFile(D, [], { at: AT, stale: true })).toMatch(/could not be reached for this export/);
		expect(JSON.parse(toJsonExport(D, [], { at: AT, stale: true }))).toMatchObject({
			stale: true,
			records: []
		});
	});

	it('splits a long TXT value into strings of at most 255 bytes and escapes what needs it', () => {
		const long = quoteTxt('a'.repeat(600));
		expect(long.split(' ').map((s) => s.length - 2)).toEqual([255, 255, 90]);
		expect(quoteTxt('say "hi" \\ ü')).toBe('"say \\"hi\\" \\\\ \\195\\188"');
		expect(quoteTxt('')).toBe('""');
		expect(rdataOf({ type: 'SRV', content: 'not the usual shape', prio: 3 })).toBe('3 not the usual shape');
	});

	it('orders the apex first and a subdomain under its parent', () => {
		const hosts = ['www', 'a.www', '', '*', 'b', '_dmarc'].map((h) => rec(h, 'A', '203.0.113.1'));
		expect(hosts.sort(compareRecords).map((r) => r.host)).toEqual(['', '*', '_dmarc', 'b', 'www', 'a.www']);
	});
});

describe('parseZoneFile', () => {
	it('reads what toZoneFile wrote back as the same records', () => {
		const records = everything();
		const parsed = parseZoneFile(toZoneFile(D, records, { at: AT }), D);
		expect(parsed.unreadable).toEqual([]);
		expect(parsed.candidates.map(data)).toEqual([...records].sort(compareRecords).map(data));
		// Notes travel as comments and come back as notes of the candidate.
		expect(parsed.candidates.find((c) => c.host === 'www')?.notes).toBe('served by Caddy');
	});

	it('reads a zone file as other software writes it', () => {
		const text = [
			'$ORIGIN example.com.',
			'$TTL 1h',
			'@   IN  SOA ns1.example.net. hostmaster.example.com. (',
			'        2026111801 ; serial',
			'        7200 3600 1209600 3600 )',
			'    IN  NS  ns1.example.net.',
			'    IN  NS  ns2.example.net.',
			'@   300 IN A 203.0.113.10',
			'    IN  AAAA 2001:db8::10',
			'www IN  CNAME @',
			'mail 2h IN A 203.0.113.25',
			'@   IN  MX 10 mail',
			'@   IN  TXT ( "v=spf1 "',
			'            "mx -all" ) ; split over two lines',
			'_dmarc IN TXT "v=DMARC1\\; p=none"',
			'ftp.example.com. IN 1d A 203.0.113.30',
			'lab IN NS ns1.lab.example.net.',
			'other.example.net. IN A 203.0.113.99',
			'ptr IN PTR host.example.com.',
			'ch CH TXT "chaos"',
			'$INCLUDE more.zone',
			'bare'
		].join('\r\n');
		const parsed = parseZoneFile(text, D);
		expect(parsed.candidates.map((c) => [c.line, c.host, c.type, c.content, c.ttl, c.prio])).toEqual([
			[
				3,
				'',
				'SOA',
				'ns1.example.net. hostmaster.example.com. 2026111801 7200 3600 1209600 3600',
				3600,
				undefined
			],
			[6, '', 'NS', 'ns1.example.net', 3600, undefined],
			[7, '', 'NS', 'ns2.example.net', 3600, undefined],
			[8, '', 'A', '203.0.113.10', 300, undefined],
			[9, '', 'AAAA', '2001:db8::10', 3600, undefined],
			[10, 'www', 'CNAME', 'example.com', 3600, undefined],
			[11, 'mail', 'A', '203.0.113.25', 7200, undefined],
			[12, '', 'MX', 'mail.example.com', 3600, 10],
			[13, '', 'TXT', 'v=spf1 mx -all', 3600, undefined],
			[15, '_dmarc', 'TXT', 'v=DMARC1; p=none', 3600, undefined],
			[16, 'ftp', 'A', '203.0.113.30', 86400, undefined],
			[17, 'lab', 'NS', 'ns1.lab.example.net', 3600, undefined],
			[19, 'ptr', 'PTR', 'host.example.com.', 3600, undefined]
		]);
		expect(parsed.unreadable).toEqual([
			{ line: 18, message: 'other.example.net is not under example.com, so the record was left out' },
			{ line: 20, message: 'Class CH is not Internet DNS, so the record was left out' },
			{ line: 21, message: '$INCLUDE is not supported: paste the records it stands for instead' },
			{ line: 22, message: 'No record type on this line' }
		]);
	});

	it('says which line can not be read, and reads on', () => {
		const parsed = parseZoneFile(
			[
				'a IN A',
				'b IN MX mail.example.com.',
				'c IN TXT "never closed',
				'd IN A 203.0.113.1',
				') e IN A 203.0.113.2'
			].join('\n'),
			D
		);
		expect(parsed.unreadable.map((u) => [u.line, u.message])).toEqual([
			[1, 'A takes one address'],
			[2, 'MX takes a priority and a mail server'],
			[3, 'A quoted text is not closed on this line'],
			[5, 'A closing parenthesis without an opening one']
		]);
		expect(parsed.candidates.map((c) => c.host)).toEqual(['d']);
	});

	it('uses the last TTL when the file sets no default, and none when there is none', () => {
		const parsed = parseZoneFile('a IN A 203.0.113.1\nb 900 IN A 203.0.113.2\nc IN A 203.0.113.3\n', D);
		expect(parsed.candidates.map((c) => c.ttl)).toEqual([undefined, 900, 900]);
	});

	it('reads ANAME as ALIAS and names relative to a changed origin', () => {
		const parsed = parseZoneFile(
			'$ORIGIN dev.example.com.\n@ IN ANAME target.example.net.\napi IN A 203.0.113.5\n',
			D
		);
		expect(parsed.candidates.map((c) => [c.host, c.type, c.content])).toEqual([
			['dev', 'ALIAS', 'target.example.net'],
			['api.dev', 'A', '203.0.113.5']
		]);
	});

	it('reads TTLs with units', () => {
		expect(parseTtl('3600')).toBe(3600);
		expect(parseTtl('1h30m')).toBe(5400);
		expect(parseTtl('2D')).toBe(172800);
		expect(parseTtl('1w')).toBe(604800);
		expect(parseTtl('soon')).toBeNull();
		expect(parseTtl('1x')).toBeNull();
	});
});

describe('JSON import', () => {
	it("reads this UI's own JSON export back as the same records", () => {
		const records = everything();
		const parsed = parseImportText(toJsonExport(D, records, { at: AT }), D);
		expect(parsed.source).toBe('json');
		expect(parsed.unreadable).toEqual([]);
		expect(parsed.candidates.map(data)).toEqual([...records].sort(compareRecords).map(data));
	});

	it("reads Porkbun's own answer shape: full names and numbers as text", () => {
		const parsed = parseJsonRecords(
			{
				status: 'SUCCESS',
				records: [
					{
						id: '1',
						name: 'example.com',
						type: 'a',
						content: '203.0.113.10',
						ttl: '600',
						prio: null,
						notes: null
					},
					{
						id: '2',
						name: 'www.example.com',
						type: 'MX',
						content: 'mail.example.com',
						ttl: '600',
						prio: '10',
						notes: 'n'
					},
					'nonsense',
					{ name: 'x', type: 'A' }
				]
			},
			D
		);
		expect(parsed.candidates).toEqual([
			{ line: 1, host: '', type: 'A', content: '203.0.113.10', ttl: 600 },
			{ line: 2, host: 'www', type: 'MX', content: 'mail.example.com', ttl: 600, prio: 10, notes: 'n' }
		]);
		expect(parsed.unreadable.map((u) => u.line)).toEqual([3, 4]);
	});

	it('says when the text is not JSON after all, or not a list', () => {
		expect(parseImportText('[ not json', D).unreadable[0]?.message).toMatch(/not valid JSON/);
		expect(parseImportText('{"a": 1}', D).unreadable[0]?.message).toMatch(/list of records/);
		expect(parseImportText('www IN A 203.0.113.1', D).source).toBe('zone');
	});
});

describe('classifyImport', () => {
	const zone = () => [
		rec('', 'A', '203.0.113.10'),
		rec('blog', 'CNAME', 'example.org'),
		rec('', 'TXT', 'v=spf1 mx -all')
	];

	it('sorts every record into new, existing, conflict, ignored or invalid', () => {
		const { candidates } = parseZoneFile(
			[
				'@ IN SOA ns1.example.net. h.example.com. 1 2 3 4 5',
				'@ IN NS ns1.example.net.',
				'@ IN A 203.0.113.10',
				'www IN A 203.0.113.10',
				'www IN A 203.0.113.10',
				'blog IN A 203.0.113.10',
				'@ IN TXT "v=spf1 -all"',
				'lab IN NS ns1.example.net.',
				'ptr IN PTR host.example.com.',
				'bad IN A 300.1.1.1',
				'@ IN MX 10 Mail.Example.com.'
			].join('\n'),
			D
		);
		const entries = classifyImport(zone(), candidates, D);
		expect(entries.map((e) => [e.line, e.verdict])).toEqual([
			[1, 'ignored'],
			[2, 'ignored'],
			[3, 'existing'],
			[4, 'new'],
			[5, 'existing'],
			[6, 'conflict'],
			[7, 'conflict'],
			[8, 'new'],
			[9, 'ignored'],
			[10, 'invalid'],
			[11, 'new']
		]);
		expect(entries[2]?.reason).toBe('Already in the zone');
		expect(entries[4]?.reason).toBe('Listed more than once; the first one counts');
		expect(entries[5]?.reason).toMatch(/has a CNAME record/);
		expect(entries[6]?.reason).toMatch(/already has an SPF record/);
		expect(entries[8]?.reason).toMatch(/PTR is not a record type/);
		expect(entries[9]?.reason).toMatch(/IPv4 address/);
		expect(countVerdicts(entries)).toEqual({ new: 3, existing: 2, conflict: 2, ignored: 3, invalid: 1 });

		// Porkbun's import call skips NS records, so a delegation goes out as a create of its own.
		expect(sendable(entries)).toEqual({
			bulk: [
				{ host: 'www', type: 'A', content: '203.0.113.10' },
				{ host: '', type: 'MX', content: 'mail.example.com', prio: 10 }
			],
			delegations: [{ host: 'lab', type: 'NS', content: 'ns1.example.net' }]
		});
	});
});
