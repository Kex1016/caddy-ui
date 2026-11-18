<script lang="ts">
	import { page } from '$app/state';
	import { Notice, PageHero, Tag } from '$lib/design/components';
	import { PorkbunNotice } from '$lib/porkbun/components';

	let { data, children } = $props();
	const status = $derived(data.porkbun);
	const unset = $derived(status.state === 'off' || status.state === 'misconfigured');
	const onActivity = $derived(page.url.pathname.startsWith('/domains/activity'));
	const COMPOSE =
		'environment:\n  PORKBUN_API_KEY: ${PORKBUN_API_KEY}\n  PORKBUN_API_SECRET_KEY: ${PORKBUN_API_SECRET_KEY}';
</script>

{#if unset}
	<PageHero
		kicker="Porkbun"
		title="Domains"
		lede="Manage the domains in your Porkbun account from here: DNS records with undo, nameservers, DNSSEC, URL forwarding and more."
	/>
	<section class="fp-section">
		{#if status.state === 'misconfigured'}
			<Notice kind="error">
				<b>Only one of the two Porkbun keys is set.</b>
				<code>{status.missing}</code> is missing on the <code>caddy-ui</code> service, so this area stays off. Set
				it and restart the container.
			</Notice>
		{:else}
			<Notice>
				<b>This area is off.</b> It turns on when the <code>caddy-ui</code> service is given a Porkbun API key.
				Nothing is sent to Porkbun until then.
			</Notice>
		{/if}
		<div class="fp-panel setup">
			<h2 class="t-title-2">Set it up</h2>
			<ol class="setup__steps t-body">
				<li>
					At <a href="https://porkbun.com/account/api" target="_blank" rel="noopener noreferrer"
						>porkbun.com/account/api</a
					>, create an API key, or reuse the one Caddy's Porkbun plugin already has. The "Manage, but no
					purchases" permission preset is enough. Use a sandbox key (it starts with <code>pk1_sb_</code>) to
					try things without touching anything real.
				</li>
				<li>
					Turn on "API access" for each domain you want to manage here, in the domain's details at Porkbun.
				</li>
				<li>
					Give both halves of the key to the <code>caddy-ui</code> service in your compose file, the same two
					lines the <code>caddy</code> service has, and restart it:
					<pre class="setup__code"><code>{COMPOSE}</code></pre>
				</li>
			</ol>
			<p class="t-ui t-muted">
				The keys stay on the server. They are read from the environment only and are never stored, logged or
				sent to the browser.
			</p>
		</div>
	</section>
{:else}
	<div class="bar">
		<nav class="fp-seg" aria-label="Domains area">
			<a href="/domains" aria-current={onActivity ? undefined : 'page'}>Domains</a>
			<a href="/domains/activity" aria-current={onActivity ? 'page' : undefined}>Activity</a>
		</nav>
		<div class="bar__tags">
			{#if status.sandbox}<Tag kind="acc">Sandbox</Tag>{/if}
			{#if status.readonly}
				<span title="Read-only mode is on (CADDY_UI_PORKBUN_READONLY), so nothing can be changed from here"
					><Tag kind="warning">Read-only</Tag></span
				>
			{/if}
			{#if status.account}<span class="t-caption">Porkbun account {status.account}</span>{/if}
		</div>
	</div>
	{#if status.sandbox}
		<Notice>
			<b>Sandbox key.</b> Porkbun simulates everything for this key: no real DNS, registry setting or certificate
			is touched.
		</Notice>
	{/if}
	{#if status.readonly && page.url.pathname === '/domains'}
		<Notice>
			<b>Read-only mode is on,</b> so nothing can be changed from here. It is the default when Caddy UI runs
			without its own sign-in. Set <code>CADDY_UI_PORKBUN_READONLY=false</code> on the <code>caddy-ui</code> service
			to allow changes.
		</Notice>
	{/if}
	{#if status.state === 'error'}
		<section class="fp-section">
			<PorkbunNotice error={status.error} />
			{#if status.error?.retryable}
				<p class="t-ui t-muted">Pages below show the last data that was read, where there is any.</p>
			{/if}
		</section>
	{/if}
	{@render children()}
{/if}

<style>
	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}
	.bar__tags {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
	}
	.setup {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		max-width: 720px;
	}
	.setup__steps {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		margin: 0;
		padding-left: var(--space-5);
		list-style: decimal;
	}
	.setup__code {
		margin-top: var(--space-2);
		padding: var(--space-3);
		border-radius: var(--radius-md);
		background: var(--sunk);
		overflow-x: auto;
	}
	.setup__code code {
		padding: 0;
		background: transparent;
	}
</style>
