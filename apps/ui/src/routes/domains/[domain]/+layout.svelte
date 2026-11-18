<script lang="ts">
	import { page } from '$app/state';
	import { Notice, Tag } from '$lib/design/components';
	import { PorkbunNotice } from '$lib/porkbun/components';
	import { DOMAIN_TABS, currentTab, domainHref } from '$lib/porkbun/tabs';

	let { data, children } = $props();
	const name = $derived(data.domain?.domain ?? page.params.domain ?? '');
	const tab = $derived(currentTab(page.url.pathname));
</script>

<svelte:head>
	<title>{name} · Domains · Caddy UI</title>
</svelte:head>

<header class="fp-hero">
	<span class="t-kicker">Domain</span>
	<h1 class="t-title-1 t-mono name">{name}</h1>
	{#if data.domain}
		<p class="tags">
			<Tag kind={data.domain.status === 'ACTIVE' ? 'success' : 'warning'}
				>{data.domain.status || 'unknown'}</Tag
			>
			{#if !data.domain.apiAccess}<Tag kind="error">API access off</Tag>{/if}
			{#if data.domain.notLocal}<Tag kind="warning">managed elsewhere</Tag>{/if}
			{#each data.domain.labels as label (label.id)}<Tag>{label.title}</Tag>{/each}
		</p>
	{/if}
</header>

{#if data.domain}
	<nav class="fp-seg tabs" aria-label="Sections of {name}">
		{#each DOMAIN_TABS as t (t.slug)}
			<a href={domainHref(data.domain.domain, t.slug)} aria-current={tab === t.slug ? 'page' : undefined}
				>{t.label}</a
			>
		{/each}
	</nav>
	{#if !data.domain.apiAccess}
		<Notice kind="warning">
			<b>API access is off for this domain.</b> Porkbun refuses to read or change anything on it through the
			API until "API access" is turned on in the domain's details at
			<a href="https://porkbun.com/account/domainsSpeedy" target="_blank" rel="noopener noreferrer"
				>porkbun.com</a
			>.
		</Notice>
	{/if}
	{@render children()}
{:else}
	<section class="fp-section">
		<PorkbunNotice error={data.domainError} />
		<p><a class="fp-btn" href="/domains">Back to all domains</a></p>
	</section>
{/if}

<style>
	.name {
		overflow-wrap: anywhere;
	}
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
	.tabs {
		align-self: flex-start;
		max-width: 100%;
		overflow-x: auto;
		height: auto;
		min-height: var(--size-control);
	}
</style>
