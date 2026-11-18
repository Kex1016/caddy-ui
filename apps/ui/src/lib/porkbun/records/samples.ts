import type { DnsRecordType } from '$lib/api/porkbun';

/**
 * Tests only: for each of the 14 record types a valid record, a second valid value to edit it to, and a
 * value that must be refused before anything is sent. Names and addresses are from the documentation ranges.
 */
export type Sample = {
	host: string;
	content: string;
	prio?: number;
	/** Another valid value for the same record. */
	edited: string;
	/** A value the type does not allow. */
	invalid: string;
};

const hex = (pair: string, bytes: number) => pair.repeat(bytes);

export const SAMPLES: Record<DnsRecordType, Sample> = {
	A: { host: 'app', content: '198.51.100.20', edited: '198.51.100.21', invalid: '300.1.1.1' },
	AAAA: { host: 'app', content: '2001:db8::20', edited: '2001:db8::21', invalid: '2001:db8:::1' },
	MX: {
		host: 'lists',
		content: 'mx1.example.net',
		prio: 10,
		edited: 'mx2.example.net',
		invalid: '192.0.2.1'
	},
	CNAME: { host: 'shop', content: 'shops.example.net', edited: 'store.example.net', invalid: 'not a host' },
	ALIAS: { host: 'alias', content: 'target.example.net', edited: 'other.example.net', invalid: 'target' },
	TXT: {
		host: '_dmarc',
		content: 'v=DMARC1; p=none; rua=mailto:postmaster@example.com',
		edited: 'v=DMARC1; p=reject',
		invalid: 'line one\nline two'
	},
	NS: { host: 'lab', content: 'ns1.example.net', edited: 'ns2.example.net', invalid: '203.0.113.1' },
	SRV: {
		host: '_imaps._tcp',
		content: '1 993 mail.example.com',
		prio: 0,
		edited: '5 993 mail.example.com',
		invalid: '993 mail.example.com'
	},
	TLSA: {
		host: '_443._tcp',
		content: `3 1 1 ${hex('ab', 32)}`,
		edited: `3 1 1 ${hex('cd', 32)}`,
		invalid: '3 1 1 abc'
	},
	CAA: { host: 'caa', content: '0 issue "letsencrypt.org"', edited: '0 issuewild ";"', invalid: '0 issue' },
	SSHFP: { host: 'ssh', content: `4 2 ${hex('ef', 32)}`, edited: `4 2 ${hex('12', 32)}`, invalid: '4 2 xyz' },
	HTTPS: { host: 'h3', content: '1 . alpn="h3,h2"', edited: '1 . alpn="h2"', invalid: 'one . alpn=h2' },
	SVCB: {
		host: '_dns',
		content: '1 dns.example.net alpn=dot port=853',
		edited: '2 dns.example.net alpn=dot',
		invalid: '1'
	},
	DS: {
		host: 'lab2',
		content: `2371 13 2 ${hex('aa', 32)}`,
		edited: `2371 13 2 ${hex('bb', 32)}`,
		invalid: '2371 13 2 zz'
	}
};
