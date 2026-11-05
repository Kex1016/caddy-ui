const UNITS: Record<string, number> = {
	ms: 1,
	s: 1000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000
};

/**
 * Parses a Go-style duration such as `30s`, `1h`, `1h30m` or `500ms` into milliseconds.
 * A bare number is read as seconds. Returns `null` for anything else.
 */
export function parseDuration(input: string): number | null {
	const text = input.trim();
	if (text === '') return null;
	if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
	const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gy;
	let total = 0;
	let consumed = 0;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		total += Number(match[1]) * (UNITS[match[2] as string] as number);
		consumed = re.lastIndex;
	}
	if (consumed !== text.length) return null;
	return Math.round(total);
}
