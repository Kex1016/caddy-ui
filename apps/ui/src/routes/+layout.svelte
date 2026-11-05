<script lang="ts">
	import '$lib/design/index.css';
	import { LogOut } from '@lucide/svelte';
	import { page } from '$app/state';
	import { Brand, Crumbs, Footer, NavGroup, Notice, Shell, ThemeToggle } from '$lib/design/components';
	import { NAV, pageTitle } from '$lib/nav';

	let { data, children } = $props();
	const bare = $derived(page.url.pathname === '/login' || !data.identity);
	const title = $derived(pageTitle(page.url.pathname));
</script>

<svelte:head>
	<title>{bare ? 'Sign in' : title} · Caddy UI</title>
</svelte:head>

{#if bare}
	{@render children()}
{:else}
	<Shell sidebar={data.sidebar}>
		{#snippet side()}
			<Brand />
			{#each NAV as group, i (i)}
				<NavGroup label={group.label} items={group.items} current={page.url.pathname} />
			{/each}
			<div class="fp-side__foot"><span class="t-caption t-faint">{data.version}</span></div>
		{/snippet}
		{#snippet top()}
			<Crumbs
				items={[{ label: 'Caddy UI', href: '/' }, ...(title === 'Caddy UI' ? [] : [{ label: title }])]}
			/>
		{/snippet}
		{#snippet topEnd()}
			<ThemeToggle theme={data.theme} />
			{#if data.identity?.via === 'session'}
				<form method="POST" action="/logout">
					<button type="submit" class="fp-ibtn" aria-label="Sign out {data.identity.user}" title="Sign out">
						<LogOut class="fp-ico" strokeWidth={1.4} aria-hidden="true" />
					</button>
				</form>
			{/if}
		{/snippet}
		<div class="fp-page">
			{#if data.authOff}
				<Notice kind="warning">
					<b>Sign-in is off.</b> CADDY_UI_USER and CADDY_UI_PASSWORD are unset, so anyone who can reach this page
					can change your Caddyfile. Set both, or set CADDY_UI_AUTH_MODE to forward or none to make the choice explicit.
				</Notice>
			{/if}
			{@render children()}
			<Footer version={data.version} timeZone={data.timeZone} />
		</div>
	</Shell>
{/if}
