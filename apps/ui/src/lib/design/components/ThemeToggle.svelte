<script lang="ts">
	import { Monitor, Moon, Sun } from '@lucide/svelte';
	import { PREF_MAX_AGE, THEME_COOKIE, nextTheme, type Theme } from '$lib/theme';

	/** Cycles dark → light → system and remembers the choice in a cookie so the server renders it. */
	type Props = { theme?: Theme };
	let { theme = 'system' }: Props = $props();
	let chosen = $state<Theme | null>(null);
	const shown = $derived(chosen ?? theme);

	const names: Record<Theme, string> = { dark: 'dark', light: 'light', system: 'system' };

	function cycle() {
		const next = nextTheme(shown);
		chosen = next;
		const root = document.documentElement;
		if (next === 'system') {
			root.removeAttribute('data-theme');
			document.cookie = `${THEME_COOKIE}=; path=/; max-age=0; samesite=lax`;
		} else {
			root.setAttribute('data-theme', next);
			document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=${PREF_MAX_AGE}; samesite=lax`;
		}
	}
</script>

<button
	type="button"
	class="fp-ibtn"
	aria-label="Theme: {names[shown]}. Switch to {names[nextTheme(shown)]}"
	title="Theme: {names[shown]}"
	onclick={cycle}
>
	{#if shown === 'dark'}
		<Moon class="fp-ico" strokeWidth={1.4} aria-hidden="true" />
	{:else if shown === 'light'}
		<Sun class="fp-ico" strokeWidth={1.4} aria-hidden="true" />
	{:else}
		<Monitor class="fp-ico" strokeWidth={1.4} aria-hidden="true" />
	{/if}
</button>
