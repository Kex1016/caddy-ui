import { describe, expect, it } from 'vitest';
import { DNS_RECORD_TYPES, type DnsRecordType } from '$lib/api/porkbun';
import { RECORD_KINDS } from './kinds';
import { hostProblem, isIPv4, isIPv6, normaliseHost, targetProblem } from './names';
import { SAMPLES } from './samples';
import { formatOf, sameSnapshot, validateParts, validateRecord } from './validate';

const D = 'example.com';

function ok(raw: unknown) {
	const res = validateRecord(raw, D);
	if (!res.ok) throw new Error(`expected a valid record: ${JSON.stringify(res.errors)}`);
	return res;
}

function errors(raw: unknown) {
	const res = validateRecord(raw, D);
	if (res.ok) throw new Error(`expected a refusal, got ${JSON.stringify(res.record)}`);
	return res.errors;
}

describe('addresses', () => {
	it.each(['203.0.113.10', '0.0.0.0', '255.255.255.255'])('takes %s as IPv4', (a) => {
		expect(isIPv4(a)).toBe(true);
	});
	it.each(['256.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', '1.2.3.4 ', 'a.b.c.d', ''])(
		'refuses %j as IPv4',
		(a) => {
			expect(isIPv4(a)).toBe(false);
		}
	);
	it.each([
		'2001:db8::10',
		'::',
		'::1',
		'fe80::1',
		'2001:db8:0:0:0:0:0:1',
		'::ffff:192.0.2.1',
		'1:2:3:4:5:6:7::'
	])('takes %s as IPv6', (a) => {
		expect(isIPv6(a)).toBe(true);
	});
	it.each([
		'2001:db8:::1',
		'1:2:3:4:5:6:7',
		'1:2:3:4:5:6:7:8:9',
		'12345::1',
		'g::1',
		'1::2::3',
		'192.0.2.1',
		'1.2.3.4::'
	])('refuses %j as IPv6', (a) => {
		expect(isIPv6(a)).toBe(false);
	});
});

describe('record names', () => {
	it('reads the apex however it is written', () => {
		for (const raw of ['', '@', 'example.com', 'EXAMPLE.com.', '  @ '])
			expect(normaliseHost(raw, D)).toBe('');
	});

	it('takes a full name down to the part before the domain', () => {
		expect(normaliseHost('WWW.Example.com.', D)).toBe('www');
		expect(normaliseHost('a.b.example.com', D)).toBe('a.b');
		expect(normaliseHost('www', D)).toBe('www');
		// Another domain's name is not cut: it is a name under this one.
		expect(normaliseHost('www.example.net', D)).toBe('www.example.net');
	});

	it.each(['www', '*', '*.dev', '_dmarc', '_sip._tcp', 'a-b.c', 'xn--bcher-kva', '1'])(
		'accepts %s',
		(host) => {
			expect(hostProblem(host, D)).toBeNull();
		}
	);

	it.each([
		['dev.*', /wildcard/],
		['*dev', /wildcard/],
		['a..b', /empty part/],
		['-a', /not usable/],
		['a-', /not usable/],
		['a b', /spaces/],
		['bücher', /ASCII form/],
		['a'.repeat(64), /63 characters/],
		[Array(60).fill('abcd').join('.'), /253 characters/]
	])('refuses %s', (host, why) => {
		expect(hostProblem(host, D)).toMatch(why);
	});

	it('wants a full hostname as a target', () => {
		expect(targetProblem('mail.example.com')).toBeNull();
		expect(targetProblem('_abc.acm-validations.example')).toBeNull();
		expect(targetProblem('mail')).toMatch(/full hostname/);
		expect(targetProblem('203.0.113.1')).toMatch(/not an IP address/);
		expect(targetProblem('.')).toMatch(/hostname/);
		expect(targetProblem('.', { allowRoot: true })).toBeNull();
		expect(targetProblem('a b.example.com')).toMatch(/spaces/);
	});
});

describe('the 14 record types', () => {
	it('has a definition for every type Porkbun takes', () => {
		expect(Object.keys(RECORD_KINDS).sort()).toEqual([...DNS_RECORD_TYPES].sort());
		for (const type of DNS_RECORD_TYPES) {
			const kind = RECORD_KINDS[type];
			expect(kind.type).toBe(type);
			expect(kind.fields.length).toBeGreaterThan(0);
			// Every field has a default, so a new form starts complete.
			expect(Object.keys(kind.defaults).sort()).toEqual(kind.fields.map((f) => f.key).sort());
			expect(kind.usesPrio).toBe(type === 'MX' || type === 'SRV');
			expect(formatOf(kind)).not.toBe('');
		}
	});

	describe.each(DNS_RECORD_TYPES)('%s', (type: DnsRecordType) => {
		const sample = SAMPLES[type];
		const kind = RECORD_KINDS[type];

		it('accepts a valid record and keeps its value', () => {
			for (const content of [sample.content, sample.edited]) {
				const res = ok({ host: sample.host, type, content, prio: sample.prio, ttl: 3600, notes: 'a note' });
				expect(res.record).toEqual({
					host: sample.host,
					type,
					content,
					ttl: 3600,
					notes: 'a note',
					...(kind.usesPrio ? { prio: sample.prio ?? 0 } : {})
				});
			}
		});

		it('splits a stored value into its form fields and joins it back unchanged', () => {
			for (const content of [sample.content, sample.edited]) {
				const parts = kind.split(content, sample.prio ?? null);
				expect(parts).not.toBeNull();
				expect(kind.check(parts as never, { host: sample.host, domain: D })).toEqual([]);
				const joined = kind.join(parts as never);
				expect(joined.content).toBe(content);
				if (kind.usesPrio) expect(joined.prio).toBe(sample.prio ?? 0);
				else expect(joined.prio).toBeUndefined();
			}
		});

		it('refuses a value the type does not allow, and says which field', () => {
			const list = errors({ host: sample.host, type, content: sample.invalid, prio: sample.prio });
			expect(list.length).toBeGreaterThan(0);
			expect(list.every((e) => e.field === 'content' || e.field === 'prio')).toBe(true);
			expect(list[0]?.message.length).toBeGreaterThan(10);
		});

		it('refuses an empty value', () => {
			expect(errors({ host: sample.host, type, content: '   ' }).length).toBeGreaterThan(0);
		});
	});
});

describe('validateRecord', () => {
	it('puts a record in one spelling', () => {
		expect(ok({ name: 'WWW.example.com.', type: 'cname', content: 'Target.Example.NET.' }).record).toEqual({
			host: 'www',
			type: 'CNAME',
			content: 'target.example.net'
		});
		expect(ok({ host: '@', type: 'AAAA', content: '2001:DB8::A' }).record).toEqual({
			host: '',
			type: 'AAAA',
			content: '2001:db8::a'
		});
		expect(ok({ host: '', type: 'CAA', content: '0 ISSUE letsencrypt.org' }).record.content).toBe(
			'0 issue "letsencrypt.org"'
		);
		expect(ok({ host: 't', type: 'TLSA', content: `3 1 1 ${'AB '.repeat(32)}` }).record.content).toBe(
			`3 1 1 ${'ab'.repeat(32)}`
		);
	});

	it("reads numbers given as text, as in Porkbun's own JSON", () => {
		expect(ok({ host: '', type: 'MX', content: 'mail.example.com', prio: '20', ttl: '900' }).record).toEqual({
			host: '',
			type: 'MX',
			content: 'mail.example.com',
			prio: 20,
			ttl: 900
		});
	});

	it('keeps the priority only where the type has one', () => {
		expect(ok({ host: 'a', type: 'A', content: '203.0.113.1', prio: 10 }).record).not.toHaveProperty('prio');
		expect(ok({ host: '', type: 'MX', content: 'mail.example.com' }).record.prio).toBe(0);
		expect(errors({ host: '', type: 'MX', content: 'mail.example.com', prio: 70000 })[0]).toMatchObject({
			field: 'prio'
		});
		expect(errors({ host: '', type: 'MX', content: 'mail.example.com', prio: -1 })[0]?.field).toBe('prio');
	});

	it('leaves the TTL out when none or 0 is given, so Porkbun uses its minimum', () => {
		expect(ok({ host: 'a', type: 'A', content: '203.0.113.1' }).record).not.toHaveProperty('ttl');
		expect(ok({ host: 'a', type: 'A', content: '203.0.113.1', ttl: 0 }).record).not.toHaveProperty('ttl');
		expect(ok({ host: 'a', type: 'A', content: '203.0.113.1', ttl: null }).record).not.toHaveProperty('ttl');
		expect(errors({ host: 'a', type: 'A', content: '203.0.113.1', ttl: 1.5 })[0]?.field).toBe('ttl');
		expect(errors({ host: 'a', type: 'A', content: '203.0.113.1', ttl: 'soon' })[0]?.field).toBe('ttl');
		expect(errors({ host: 'a', type: 'A', content: '203.0.113.1', ttl: 3_000_000_000 })[0]?.field).toBe(
			'ttl'
		);
	});

	it('says so when a TTL is below what Porkbun stores', () => {
		expect(ok({ host: 'a', type: 'A', content: '203.0.113.1', ttl: 60 }).advice.join(' ')).toMatch(
			/raises a TTL/
		);
		expect(ok({ host: 'a', type: 'A', content: '203.0.113.1', ttl: 600 }).advice).toEqual([]);
	});

	it('keeps empty notes, which clear the notes on an edit, apart from no notes', () => {
		expect(ok({ host: 'a', type: 'A', content: '203.0.113.1', notes: '' }).record.notes).toBe('');
		expect(ok({ host: 'a', type: 'A', content: '203.0.113.1', notes: null }).record).not.toHaveProperty(
			'notes'
		);
		expect(errors({ host: 'a', type: 'A', content: '203.0.113.1', notes: 'two\nlines' })[0]?.field).toBe(
			'notes'
		);
		expect(errors({ host: 'a', type: 'A', content: '203.0.113.1', notes: 'x'.repeat(1001) })[0]?.field).toBe(
			'notes'
		);
	});

	it('refuses what is not a record at all', () => {
		expect(errors(null)[0]?.field).toBe('content');
		expect(errors([])[0]?.field).toBe('content');
		expect(errors({ host: 'a', type: 'PTR', content: 'x.example.com' })[0]).toMatchObject({ field: 'type' });
		expect(errors({ host: 'a', content: '203.0.113.1' })[0]?.field).toBe('type');
		expect(errors({ host: 7, type: 'A', content: '203.0.113.1' })[0]?.field).toBe('host');
		expect(errors({ host: 'a', type: 'A', content: 7 })[0]?.field).toBe('content');
		expect(errors({ host: 'a b', type: 'A', content: '203.0.113.1' })[0]?.field).toBe('host');
	});

	it('names the expected form when a stored value has another shape', () => {
		expect(errors({ host: '_sip._tcp', type: 'SRV', content: 'sip.example.com' })[0]?.message).toMatch(
			/weight, then port, then target host/
		);
	});

	it('refuses a CNAME that points at itself', () => {
		expect(errors({ host: 'www', type: 'CNAME', content: 'www.example.com' })[0]?.message).toMatch(
			/its own name/
		);
	});

	it('checks the length of a fingerprint against its type', () => {
		expect(errors({ host: 'ssh', type: 'SSHFP', content: `4 2 ${'ab'.repeat(20)}` })[0]?.message).toMatch(
			/64 hexadecimal characters/
		);
		expect(ok({ host: 'ssh', type: 'SSHFP', content: `4 1 ${'ab'.repeat(20)}` }).record.content).toBe(
			`4 1 ${'ab'.repeat(20)}`
		);
		expect(errors({ host: 'lab', type: 'DS', content: `1 13 4 ${'ab'.repeat(32)}` })[0]?.message).toMatch(
			/96/
		);
	});

	it('gives advice without refusing', () => {
		expect(ok({ host: '', type: 'CNAME', content: 'target.example.net' }).advice.join(' ')).toMatch(/ALIAS/);
		expect(ok({ host: '', type: 'NS', content: 'ns1.example.net' }).advice.join(' ')).toMatch(/Registry tab/);
		expect(ok({ host: '', type: 'TXT', content: '"v=spf1 -all"' }).advice.join(' ')).toMatch(/quote/);
		expect(ok({ host: 'sip', type: 'SRV', content: '1 5060 sip.example.com' }).advice.join(' ')).toMatch(
			/_sip._tcp/
		);
		expect(
			ok({ host: 'h', type: 'HTTPS', content: '0 target.example.net alpn=h2' }).advice.join(' ')
		).toMatch(/alias/);
	});
});

describe('validateParts', () => {
	it('maps the priority to its own field and the rest to the value', () => {
		const res = validateParts({ host: '', type: 'MX', parts: { prio: 'x', server: 'mail' } }, D);
		if (res.ok) throw new Error('expected a refusal');
		expect(res.errors).toEqual([
			{ field: 'prio', part: 'prio', message: 'Priority must be a whole number from 0 to 65535' },
			expect.objectContaining({ field: 'content', part: 'server' })
		]);
	});

	it('reports every wrong field at once', () => {
		const res = validateParts(
			{ host: 'a b', type: 'SRV', parts: { prio: '0', weight: '-1', port: '99999', target: '' }, ttl: 'x' },
			D
		);
		if (res.ok) throw new Error('expected a refusal');
		expect(res.errors.map((e) => e.part ?? e.field)).toEqual(['host', 'weight', 'port', 'target', 'ttl']);
	});
});

describe('sameSnapshot', () => {
	const base = { host: 'a', type: 'A', content: '203.0.113.1', ttl: 600, prio: null, notes: null };
	it('treats a missing priority as 0 and missing notes as empty', () => {
		expect(sameSnapshot(base, { ...base, prio: 0, notes: '' })).toBe(true);
		expect(sameSnapshot(base, { ...base, ttl: 601 })).toBe(false);
		expect(sameSnapshot(base, { ...base, content: '203.0.113.2' })).toBe(false);
		expect(sameSnapshot(base, { ...base, notes: 'x' })).toBe(false);
	});
});
