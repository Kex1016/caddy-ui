/**
 * The DNS provider of the ACME DNS challenge, wherever it is written: `tls { dns <provider> … }` in a site,
 * and the global options `acme_dns <provider> …` and `dns <provider> …`.
 *
 * Porkbun is guided (docs/porkbun-plan.md §4): choosing it writes the plugin's block with `{env.…}`
 * placeholders, so the keys stay in the Caddy container's environment and out of the file. Syntax as read
 * from github.com/caddy-dns/porkbun v0.3.1: nothing on the `porkbun` line, `api_key` and `api_secret_key`
 * in its block, both required. Any other provider keeps the free text it had before.
 *
 * Everything here works on W1's nodes and is DOM-free, so the Sites page's server action can use it too.
 */
import { createDirective, type Directive, type SiteBlock } from '@caddy-ui/caddyfile';
import { hasPlaceholder } from '@caddy-ui/caddy-schema/grammars';
import { addSub, removeSubs, replaceArgs, setSub, sub } from '../node';
import type { FieldSpec, TextField } from '../types';
import { lineRows } from './helpers';

export const PORKBUN = 'porkbun';

/** The plugin's two options and the placeholder each one gets. The names match David's compose file. */
export const PORKBUN_KEYS = [
	{ name: 'api_key', label: 'API key', env: '{env.PORKBUN_API_KEY}' },
	{ name: 'api_secret_key', label: 'Secret API key', env: '{env.PORKBUN_API_SECRET_KEY}' }
] as const;

/**
 * - none: no provider line (`tls` only; the challenge is HTTP or TLS-ALPN).
 * - default: the line names no provider, so Caddy uses the global `dns` option (Caddy 2.10 and later).
 * - porkbun: the guided block.
 * - other: any other provider, edited as free text.
 */
export type DnsChoice = 'none' | 'default' | 'porkbun' | 'other';

/** `tls` holds its provider on a `dns` line; the two global options are that line themselves. */
const nested = (node: Directive): boolean => node.name.text === 'tls';

/** The line that names the provider, when there is one. */
export function dnsLine(node: Directive): Directive | undefined {
	return nested(node) ? sub(node, 'dns') : node;
}

export function dnsChoice(node: Directive): DnsChoice {
	const line = dnsLine(node);
	if (!line) return 'none';
	const provider = line.args[0]?.text;
	if (provider === undefined) return 'default';
	return provider === PORKBUN ? 'porkbun' : 'other';
}

function ensureLine(node: Directive): Directive {
	return dnsLine(node) ?? addSub(node, createDirective('dns', []));
}

/**
 * Make the provider Porkbun. A line that already is Porkbun keeps the values it has; a missing option gets
 * its `{env.…}` placeholder. Another provider's arguments and options are dropped: they mean nothing here.
 */
export function choosePorkbun(node: Directive): Directive {
	const line = ensureLine(node);
	if (line.args[0]?.text !== PORKBUN) delete line.body;
	if (line.args.length !== 1 || line.args[0]?.text !== PORKBUN) replaceArgs(line, [PORKBUN]);
	for (const key of PORKBUN_KEYS) {
		const existing = sub(line, key.name);
		if (!existing || existing.args.length === 0) setSub(line, key.name, [key.env]);
	}
	return line;
}

/** Make the provider `name` (free text). Porkbun's block is dropped; another provider's is kept. */
export function chooseOther(node: Directive, name: string): Directive {
	const line = ensureLine(node);
	const was = line.args[0]?.text;
	if (was === PORKBUN) delete line.body;
	replaceArgs(line, [name, ...(was === PORKBUN ? [] : line.args.slice(1).map((a) => a.text))]);
	return line;
}

/**
 * No provider: under `tls` the `dns` line goes away; a global option is left bare (`acme_dns`), which makes
 * Caddy use the global `dns` option.
 */
export function chooseNone(node: Directive): void {
	if (nested(node)) {
		removeSubs(node, 'dns');
		return;
	}
	replaceArgs(node, []);
	delete node.body;
}

/** The Porkbun options whose value is written out in the file instead of read from the environment. */
export function literalKeys(node: Directive): string[] {
	const line = dnsLine(node);
	if (!line || line.args[0]?.text !== PORKBUN) return [];
	return PORKBUN_KEYS.filter((key) => {
		const value = sub(line, key.name)?.args[0]?.text;
		return value !== undefined && value !== '' && !hasPlaceholder(value);
	}).map((key) => key.name);
}

/** The fields of the Porkbun block. They edit the provider line (`dns porkbun { … }`), not its parent. */
export const porkbunFields: readonly FieldSpec[] = PORKBUN_KEYS.map((key): TextField => ({
	kind: 'text',
	id: key.name,
	label: key.label,
	type: 'string',
	required: true,
	placeholder: key.env,
	help: `${key.env} reads it from the Caddy container's environment, so the key is never in the Caddyfile or in History.`,
	get: (line) => sub(line, key.name)?.args[0]?.text,
	// Clearing the field puts the placeholder back: the plugin refuses a block without the option.
	set: (line, value) => setSub(line, key.name, [value === undefined || value === '' ? key.env : value])
}));

/** The fields of any other provider. They edit the provider line as well. */
export const otherProviderFields: readonly FieldSpec[] = [
	{
		kind: 'list',
		id: 'credentials',
		label: 'Provider credentials',
		type: 'string',
		placeholder: '{env.CF_API_TOKEN}',
		help: 'What the provider takes on its line. Use {env.NAME} so the token stays out of the Caddyfile.',
		get: (line) => line.args.slice(1).map((a) => a.text),
		set: (line, values) => replaceArgs(line, [...line.args.slice(0, 1).map((a) => a.text), ...values])
	},
	lineRows({
		id: 'options',
		label: 'Provider options',
		help: 'For providers that take a block: one option per line, as their plugin documents it.',
		columns: [
			{ id: 'name', label: 'Option', type: 'string', placeholder: 'api_token' },
			{ id: 'value', label: 'Value', type: 'string', optional: true, placeholder: '{env.API_TOKEN}' }
		],
		addLabel: 'Add option',
		toRow: (l) => [l.name.text, l.args.map((a) => a.text).join(' ')],
		fromRow: (row) => {
			const name = (row[0] ?? '').trim();
			if (name === '') return undefined;
			const value = (row[1] ?? '').trim();
			return [name, value === '' ? [] : value.split(/\s+/)];
		}
	})
];

/** The lines of a `tls`, `acme_dns` or `dns` node that the provider picker edits. */
export function dnsClaims(node: Directive): readonly string[] {
	if (nested(node)) return ['dns'];
	// A global option is the provider line: its whole block belongs to the picker.
	return (node.body ?? []).flatMap((n) => (n.kind === 'directive' ? [n.name.text] : []));
}

/**
 * Add the Porkbun DNS challenge to a site: its `tls` line gets the block (and is created when the site has
 * none). Used for the wildcard hint. Returns false when the site already uses Porkbun, so nothing changed.
 */
export function addPorkbunChallenge(site: SiteBlock): boolean {
	let tls = site.body.find((n): n is Directive => n.kind === 'directive' && n.name.text === 'tls');
	if (tls && dnsChoice(tls) === 'porkbun') {
		const line = dnsLine(tls) as Directive;
		if (PORKBUN_KEYS.every((key) => sub(line, key.name)?.args.length)) return false;
	}
	if (!tls) {
		tls = createDirective('tls', []);
		// Named matchers stay first, the way `caddy fmt` users write them; tls goes right after.
		let at = 0;
		while (at < site.body.length && site.body[at]?.kind === 'matcher') at++;
		site.body.splice(at, 0, tls);
	}
	choosePorkbun(tls);
	return true;
}
