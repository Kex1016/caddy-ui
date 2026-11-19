import {
	createDirective,
	createSnippet,
	format,
	insertBlock,
	insertNode,
	parse,
	print,
	type Caddyfile,
	type Directive,
	type GlobalBlock,
	type Node,
	type SiteBlock,
	type SnippetBlock
} from '@caddy-ui/caddyfile';

/**
 * The two one-click Caddyfile edits of Settings → Caddy helpers (docs/settings-and-perf-plan.md §3, PLAN.md §7
 * "an explicit enable metrics / enable access logging helper that proposes the exact Caddyfile change"). Pure:
 * text in, text out. The page shows the change as a diff and applies it with the editor's own
 * `PUT /api/caddyfile`, so Caddy validates it first and the previous file stays in History.
 *
 * The result is formatted the way every save is (`caddy fmt` style), so the review shows what will be written.
 */

export type HelperResult = {
	/** The new text, formatted; equal to `format(text)` when nothing needs to change. */
	text: string;
	changed: boolean;
	summary: string;
	notes: string[];
};

const directives = (body: Node[], name: string): Directive[] =>
	body.filter((n): n is Directive => n.kind === 'directive' && n.name.text === name);

function globalBlock(file: Caddyfile): GlobalBlock {
	const found = file.blocks.find((b): b is GlobalBlock => b.kind === 'global');
	if (found) return found;
	const g: GlobalBlock = { kind: 'global', body: [], trivia: [] };
	insertBlock(file, g, 0);
	// The next block was first in the file; give it the usual blank line after the global options.
	const next = file.blocks[1];
	if (next && next.trivia[0]?.kind !== 'blank') next.trivia = [{ kind: 'blank', text: '' }, ...next.trivia];
	return g;
}

/** Turn on `metrics { per_host }` in the global options, adding what is missing and nothing else. */
export function enableMetricsPerHost(text: string): HelperResult {
	const { file } = parse(text);
	const existing = file.blocks.find((b): b is GlobalBlock => b.kind === 'global');
	const metrics = existing ? directives(existing.body, 'metrics')[0] : undefined;
	const notes: string[] = [];
	let summary: string;
	if (metrics && metrics.body && directives(metrics.body, 'per_host').length > 0) {
		return { text: format(text), changed: false, summary: 'Metrics are already on, per host.', notes };
	}
	if (metrics) {
		metrics.body ??= [];
		insertNode(metrics.body, createDirective('per_host'));
		if (metrics.layout?.braceStyle && metrics.layout.braceStyle !== 'block') {
			metrics.layout = { ...metrics.layout, braceStyle: 'block' };
		}
		summary = 'Adds per_host to the metrics global option, so each site gets its own traffic and latency.';
	} else {
		const g = globalBlock(file);
		insertNode(g.body, createDirective('metrics', [], { body: [createDirective('per_host')] }));
		summary = existing
			? 'Adds metrics { per_host } to the global options.'
			: 'Adds a global options block with metrics { per_host }.';
	}
	notes.push(
		'Caddy then serves request counts and latency per site on its admin API, which this UI reads every scrape interval.'
	);
	notes.push(
		'per_host adds one set of series per site name to Caddy’s metrics; with a few dozen sites that is small.'
	);
	return { text: format(print(file)), changed: true, summary, notes };
}

const SNIPPET = 'access_log';
const OUR_SNIPPET = 'caddy_ui_access_log';

/** The path a `log` directive writes to, when it writes to a file; and whether its format is JSON. */
function logTarget(log: Directive): { path: string | null; json: boolean } {
	let path: string | null = null;
	let json = true;
	for (const n of log.body ?? []) {
		if (n.kind !== 'directive') continue;
		if (n.name.text === 'output' && n.args[0]?.text === 'file') path = n.args[1]?.text ?? null;
		if (n.name.text === 'format') json = n.args[0]?.text === 'json';
	}
	return { path, json };
}

/** Logs a site writes, directly or through a snippet it imports (one level, which is how people write it). */
function siteLogs(site: SiteBlock, snippets: Map<string, SnippetBlock>): Directive[] {
	const out = [...directives(site.body, 'log')];
	for (const imp of directives(site.body, 'import')) {
		const s = snippets.get(imp.args[0]?.text ?? '');
		if (s) out.push(...directives(s.body, 'log'));
	}
	return out;
}

/**
 * Turn on the JSON access log at the path the UI tails, for every site that has none: a snippet with
 * `log { output file <path>  format json }` (an existing one that already writes there is reused) and an
 * `import` of it at the top of each site without a `log`. Sites with their own `log` are left alone and named
 * in the notes when it is not the UI's file.
 */
export function enableAccessLog(text: string, logPath: string): HelperResult {
	const { file } = parse(text);
	const snippets = new Map(
		file.blocks.filter((b): b is SnippetBlock => b.kind === 'snippet').map((s) => [s.name, s] as const)
	);
	const siteBlocks = file.blocks.filter((b): b is SiteBlock => b.kind === 'site');
	const notes: string[] = [];
	const label = (s: SiteBlock) => s.addresses.map((a) => a.text).join(', ');

	// A snippet that is only the right log, which the sites can import.
	let name: string | null = null;
	for (const s of snippets.values()) {
		const logs = directives(s.body, 'log');
		if (s.body.length === 1 && logs.length === 1) {
			const t = logTarget(logs[0] as Directive);
			if (t.path === logPath && t.json) {
				name = s.name;
				break;
			}
		}
	}

	const without = siteBlocks.filter((s) => siteLogs(s, snippets).length === 0);
	const elsewhere = siteBlocks.filter((s) => {
		const logs = siteLogs(s, snippets);
		return logs.length > 0 && !logs.some((l) => logTarget(l).path === logPath && logTarget(l).json);
	});
	if (elsewhere.length) {
		notes.push(
			`${elsewhere.length === 1 ? 'This site keeps its own log, which' : 'These sites keep their own log, which'} the UI does not read: ${elsewhere.map(label).join('; ')}.`
		);
	}
	if (without.length === 0) {
		return {
			text: format(text),
			changed: false,
			summary:
				siteBlocks.length === 0
					? 'There are no sites to log yet.'
					: 'Every site already writes an access log; nothing to add.',
			notes
		};
	}

	let created = false;
	if (name === null) {
		name = snippets.has(SNIPPET) ? OUR_SNIPPET : SNIPPET;
		for (let i = 2; snippets.has(name); i++) name = `${OUR_SNIPPET}_${i}`;
		const log = createDirective('log', [], {
			body: [createDirective('output', ['file', logPath]), createDirective('format', ['json'])]
		});
		const snippet = createSnippet(name, [log]);
		// After the global options and any other snippets, before the first site.
		const firstSite = file.blocks.findIndex((b) => b.kind === 'site');
		insertBlock(file, snippet, firstSite < 0 ? file.blocks.length : firstSite);
		created = true;
	}
	for (const s of without) insertNode(s.body, createDirective('import', [name]), 0);

	const count = `${without.length} ${without.length === 1 ? 'site' : 'sites'}`;
	const summary = created
		? `Adds a snippet (${name}) that writes Caddy’s JSON access log to ${logPath}, and imports it in ${count}.`
		: `Imports the existing ${name} snippet, which writes to ${logPath}, in ${count}.`;
	notes.push(
		`Caddy writes ${logPath} inside its own container, and this UI reads the same path in its container (CADDY_LOG_PATH). Both need the log directory mounted there; the example compose file does this.`
	);
	return { text: format(print(file)), changed: true, summary, notes };
}
