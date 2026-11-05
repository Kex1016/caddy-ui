/** Stable JSON: object keys keep insertion order except record maps, which are sorted; tabs; trailing newline. */
export function serialize(value: unknown): string {
	return JSON.stringify(sortRecords(value), null, '\t') + '\n';
}

const RECORD_KEYS = new Set([
	'directives',
	'matchers',
	'responseMatchers',
	'globalOptions',
	'subdirectives',
	'variants'
]);

function sortRecords(v: unknown, key?: string): unknown {
	if (Array.isArray(v)) return v.map((x) => sortRecords(x));
	if (v && typeof v === 'object') {
		const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
		if (key && RECORD_KEYS.has(key)) entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return Object.fromEntries(entries.map(([k, x]) => [k, sortRecords(x, k)]));
	}
	return v;
}
