<script lang="ts">
	import { enhance } from '$app/forms';
	import { Dialog, Notice } from '$lib/design/components';
	import { PORKBUN_KEYS } from '$lib/visual/forms/directives/dns-provider';

	/**
	 * Confirms the one Caddyfile edit of the wildcard hint (docs/porkbun-plan.md §4): give a site the Porkbun
	 * DNS challenge. Shows the block as it will be written, then posts the page's `dns01` action, which sends
	 * the file through the config service: Caddy validates it, and the previous file stays in History.
	 */
	type Props = {
		/** The site to change. The dialog is open while this is set. */
		site: { id: string; addresses: string[] } | null;
		/** The page's form action: `?/dns01`. */
		action: string;
		/** Hash of the Caddyfile the page was drawn from, where the page has one. */
		baseHash?: string;
		/** The plugin is not known to be in the running Caddy. */
		pluginUnknown?: boolean;
		/** The failure of the last attempt. */
		error?: string | null;
		onclose: () => void;
		/** After the action answered, successfully or not. */
		onresult?: (ok: boolean) => void;
	};
	let { site, action, baseHash, pluginUnknown = false, error = null, onclose, onresult }: Props = $props();

	let busy = $state(false);
	const BLOCK = [
		'tls {',
		'\tdns porkbun {',
		...PORKBUN_KEYS.map((key) => `\t\t${key.name} ${key.env}`),
		'\t}',
		'}'
	].join('\n');
</script>

<Dialog open={site !== null} title="Use the Porkbun DNS challenge" {onclose}>
	{#if site}
		<form
			method="POST"
			{action}
			class="stack"
			use:enhance={() => {
				busy = true;
				return async ({ result, update }) => {
					await update();
					busy = false;
					onresult?.(result.type === 'success');
					if (result.type === 'success') onclose();
				};
			}}
		>
			{#if baseHash}<input type="hidden" name="baseHash" value={baseHash} />{/if}
			<input type="hidden" name="id" value={site.id} />
			<p class="t-body">
				A wildcard certificate can only be issued through the DNS challenge. This adds it to
				<b>{site.addresses.join(', ')}</b>:
			</p>
			<pre class="fp-well t-mono block">{BLOCK}</pre>
			<p class="t-ui t-muted">
				The keys are not written to the Caddyfile. Caddy reads them from its own environment, so the
				<code>caddy</code> service needs <code>PORKBUN_API_KEY</code> and
				<code>PORKBUN_API_SECRET_KEY</code>. Caddy checks the file before it is saved, and the previous
				version stays in <a href="/history">History</a>.
			</p>
			{#if pluginUnknown}
				<Notice kind="warning">
					It could not be checked whether the running Caddy has the Porkbun plugin. Without it Caddy refuses
					the file and nothing is changed.
				</Notice>
			{/if}
			{#if error}<Notice kind="error">{error}</Notice>{/if}
			<div class="foot">
				<button class="fp-btn" type="button" onclick={onclose}>Cancel</button>
				<button class="fp-btn fp-btn--primary" disabled={busy}
					>{busy ? 'Applying…' : 'Add to the site'}</button
				>
			</div>
		</form>
	{/if}
</Dialog>

<style>
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.block {
		margin: 0;
		font-size: 13px;
		line-height: 20px;
		tab-size: 4;
		overflow-x: auto;
	}
	.foot {
		display: flex;
		justify-content: flex-end;
		gap: var(--space-2);
	}
</style>
