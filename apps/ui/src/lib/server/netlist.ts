import { BlockList, isIP } from 'node:net';

/**
 * Networks as `CADDY_UI_LOG_EXCLUDE_NETWORKS` writes them: addresses or CIDR ranges, IPv4 or IPv6, separated by
 * commas or spaces. A bare address is a range of one (/32 or /128).
 */
export type Network = { address: string; prefix: number; family: 'ipv4' | 'ipv6' };

/** Parses one list. Throws an Error naming the first entry that is not an address or a range. */
export function parseNetworks(text: string): Network[] {
	const out: Network[] = [];
	for (const item of text.split(/[\s,]+/).filter(Boolean)) {
		const slash = item.indexOf('/');
		const address = slash >= 0 ? item.slice(0, slash) : item;
		const v = isIP(address);
		if (v === 0) throw new Error(`"${item}" is not an IP address or a range such as 172.16.0.0/12`);
		const max = v === 4 ? 32 : 128;
		const rawPrefix = slash >= 0 ? item.slice(slash + 1) : String(max);
		if (!/^\d{1,3}$/.test(rawPrefix) || Number(rawPrefix) > max) {
			throw new Error(`"${item}" has a prefix outside 0 to ${max}`);
		}
		out.push({ address, prefix: Number(rawPrefix), family: v === 4 ? 'ipv4' : 'ipv6' });
	}
	return out;
}

/** Strips what Caddy may write around an address: brackets, an IPv6 zone, the IPv4-mapped IPv6 prefix. */
function normalise(ip: string): { ip: string; family: 'ipv4' | 'ipv6' } | undefined {
	let s = ip.trim();
	if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
	const zone = s.indexOf('%');
	if (zone >= 0) s = s.slice(0, zone);
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
	if (mapped) s = mapped[1] as string;
	const v = isIP(s);
	return v === 0 ? undefined : { ip: s, family: v === 4 ? 'ipv4' : 'ipv6' };
}

/** Answers whether an address is in one of the networks. An empty list matches nothing. */
export class NetworkMatcher {
	readonly size: number;
	readonly #list = new BlockList();

	constructor(networks: readonly Network[]) {
		for (const n of networks) this.#list.addSubnet(n.address, n.prefix, n.family);
		this.size = networks.length;
	}

	has(ip: string): boolean {
		if (this.size === 0 || !ip) return false;
		const n = normalise(ip);
		return n ? this.#list.check(n.ip, n.family) : false;
	}
}
