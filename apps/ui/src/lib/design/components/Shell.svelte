<script lang="ts">
	import { PanelLeft } from '@lucide/svelte';
	import { afterNavigate } from '$app/navigation';
	import { PREF_MAX_AGE, SIDEBAR_COOKIE, nextSidebar, type SidebarState } from '$lib/theme';
	import type { Snippet } from 'svelte';

	/**
	 * Fishnet's Shell: sidebar (full, rail or hidden, remembered per device) beside the top bar and the
	 * scrolling page. Under 640px the sidebar is a fixed rail and the full sidebar floats over a scrim.
	 */
	type Props = {
		sidebar?: SidebarState;
		side: Snippet;
		top: Snippet;
		topEnd?: Snippet;
		children: Snippet;
	};
	let { sidebar = 'full', side, top, topEnd, children }: Props = $props();

	let chosen = $state<SidebarState | null>(null);
	let phoneOpen = $state(false);
	let phone = $state(false);
	const desktopState = $derived(chosen ?? sidebar);
	const sideState = $derived(
		phone ? (phoneOpen ? 'full' : desktopState === 'hidden' ? 'hidden' : 'auto') : desktopState
	);

	$effect(() => {
		const mq = window.matchMedia('(max-width: 640px)');
		phone = mq.matches;
		const onChange = (e: MediaQueryListEvent) => {
			phone = e.matches;
			phoneOpen = false;
		};
		mq.addEventListener('change', onChange);
		return () => mq.removeEventListener('change', onChange);
	});

	afterNavigate(() => {
		phoneOpen = false;
	});

	function toggle() {
		if (phone) {
			phoneOpen = !phoneOpen;
			return;
		}
		const next = nextSidebar(desktopState);
		chosen = next;
		document.cookie = `${SIDEBAR_COOKIE}=${next}; path=/; max-age=${PREF_MAX_AGE}; samesite=lax`;
	}

	const label = $derived(
		phone
			? phoneOpen
				? 'Close sidebar'
				: 'Open sidebar'
			: desktopState === 'full'
				? 'Collapse sidebar to icons'
				: desktopState === 'rail'
					? 'Hide sidebar'
					: 'Show sidebar'
	);
</script>

<div class="fp-shell">
	<aside class="fp-side" data-state={sideState} aria-label="Sidebar">
		<div class="fp-side__in">{@render side()}</div>
	</aside>
	<!-- The scrim is a pointer target only; the toggle button is the keyboard route to close the sidebar. -->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class="fp-shell__scrim" onclick={() => (phoneOpen = false)}></div>
	<div class="fp-shell__col">
		<header class="fp-top">
			<button
				type="button"
				class="fp-ibtn"
				aria-label={label}
				title={label}
				aria-expanded={phone ? phoneOpen : desktopState !== 'hidden'}
				onclick={toggle}
			>
				<PanelLeft class="fp-ico" strokeWidth={1.4} aria-hidden="true" />
			</button>
			{@render top()}
			{#if topEnd}<div class="fp-top__end">{@render topEnd()}</div>{/if}
		</header>
		<main class="fp-shell__scroll" id="main">{@render children()}</main>
	</div>
</div>
