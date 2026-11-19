<script lang="ts">
	import { onMount } from 'svelte';
	import { ChevronDown } from '@lucide/svelte';
	import type { PluginCheck } from '$lib/api/porkbun-caddy';
	import { Notice } from '$lib/design/components';
	import FormRenderer from '../components/FormRenderer.svelte';
	import {
		PORKBUN,
		chooseNone,
		chooseOther,
		choosePorkbun,
		dnsChoice,
		dnsLine,
		literalKeys,
		otherProviderFields,
		porkbunFields,
		type DnsChoice
	} from './directives/dns-provider';
	import { porkbunPlugin } from './plugin-state';
	import type { CustomFieldProps } from './types';

	/**
	 * The DNS provider picker of `tls`, `acme_dns` and the global `dns` option (docs/porkbun-plan.md §4):
	 * Porkbun, guided, or any other provider as free text. Porkbun is listed first when the running Caddy has
	 * the plugin, and comes with a warning when it does not.
	 */
	let { node, ctx, commit }: CustomFieldProps = $props();

	const id = `dns-${Math.random().toString(36).slice(2, 8)}`;
	const underTls = $derived(node.name.text === 'tls');
	let plugin = $state<PluginCheck | null>(null);
	onMount(() => {
		void porkbunPlugin().then((p) => (plugin = p));
	});

	// "Another provider" with no name typed yet has no text to stand for it, so it lives here until a name is.
	let pendingOther = $state(false);
	const written = $derived(dnsChoice(node));
	const choice = $derived<DnsChoice>(
		pendingOther && (written === 'none' || written === 'default') ? 'other' : written
	);
	const line = $derived(dnsLine(node));
	const otherName = $derived(written === 'other' ? (line?.args[0]?.text ?? '') : '');
	const literal = $derived(literalKeys(node));

	type Opt = { value: DnsChoice; label: string };
	const options = $derived.by((): Opt[] => {
		const porkbun: Opt = {
			value: 'porkbun',
			label: plugin?.state === 'missing' ? 'Porkbun (plugin not in this Caddy)' : 'Porkbun'
		};
		const other: Opt = { value: 'other', label: 'Another provider' };
		const off: Opt = underTls
			? { value: 'none', label: 'None (HTTP or TLS-ALPN challenge)' }
			: { value: 'default', label: 'The default provider (global dns option)' };
		const bare: Opt[] =
			underTls && written === 'default'
				? [{ value: 'default', label: 'The default provider (global dns option)' }]
				: [];
		const providers = plugin?.state === 'missing' ? [other, porkbun] : [porkbun, other];
		return underTls ? [off, ...bare, ...providers] : [...providers, off];
	});

	function pick(value: DnsChoice) {
		pendingOther = false;
		if (value === 'porkbun') choosePorkbun(node);
		else if (value === 'other') {
			// Leaving Porkbun drops its block now; the new provider's name is typed next.
			if (written === 'porkbun') chooseNone(node);
			pendingOther = true;
		} else if (value === 'none' || value === 'default') {
			if (written !== value) chooseNone(node);
		}
		commit();
	}

	function rename(value: string) {
		const name = value.trim();
		if (name === '') {
			if (written === 'other') chooseNone(node);
			pendingOther = true;
		} else if (name === PORKBUN) {
			pendingOther = false;
			choosePorkbun(node);
		} else {
			chooseOther(node, name);
		}
		commit();
	}
</script>

<div class="fld">
	<label class="fld__label t-ui" for={id}>DNS provider</label>
	<span class="fp-select fld__select">
		<select {id} value={choice} onchange={(e) => pick(e.currentTarget.value as DnsChoice)}>
			{#each options as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
		</select>
		<ChevronDown class="fp-ico fp-ico--sm" strokeWidth={1.4} aria-hidden="true" />
	</span>
	<p class="fld__hint t-caption">
		{#if choice === 'porkbun'}
			Caddy proves it controls the name by creating a TXT record at Porkbun. Needed for wildcard certificates.
		{:else if choice === 'none'}
			Needed for wildcard certificates and for sites that can not be reached from the internet.
		{:else if choice === 'default'}
			Caddy uses the provider of the global <code>dns</code> option (Caddy 2.10 and later).
		{:else}
			The provider is a Caddy plugin that must be built into the image.
		{/if}
	</p>
</div>

{#if choice === 'porkbun' && line}
	{#if plugin?.state === 'missing'}
		<Notice kind="warning">
			<b>The running Caddy does not have the Porkbun plugin.</b> It will refuse this block until it is built
			with <code>github.com/caddy-dns/porkbun</code>; <code>deploy/caddy/Dockerfile</code> in the Caddy UI repository
			does that.
		</Notice>
	{/if}
	<FormRenderer fields={porkbunFields} node={line} {ctx} {commit} />
	{#if literal.length > 0}
		<Notice kind="warning">
			<b>{literal.length === 1 ? 'A key is' : 'Both keys are'} written out here.</b> That puts
			{literal.length === 1 ? 'it' : 'them'} in the Caddyfile and in every version kept in History. Use the
			<code>{'{env.…}'}</code> placeholder and pass the value to the Caddy container instead.
		</Notice>
	{/if}
{:else if choice === 'other'}
	<div class="fld">
		<label class="fld__label t-ui" for="{id}-name">Provider name</label>
		<span class="fp-field">
			<input
				id="{id}-name"
				class="t-mono"
				value={otherName}
				placeholder="cloudflare"
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				onchange={(e) => rename(e.currentTarget.value)}
			/>
		</span>
		<p class="fld__hint t-caption">The name of the caddy-dns plugin, as its documentation writes it.</p>
	</div>
	{#if written === 'other' && line}
		<FormRenderer fields={otherProviderFields} node={line} {ctx} {commit} />
	{/if}
{/if}

<style>
	.fld {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}
	.fld__label {
		font-weight: 500;
	}
	.fld__select,
	.fld__select select,
	.fld .fp-field {
		width: 100%;
	}
	.fld__hint {
		color: var(--muted);
	}
</style>
