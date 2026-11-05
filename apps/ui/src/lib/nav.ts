import { FileCode, Globe, History, Info, LayoutDashboard, Settings, SlidersHorizontal } from '@lucide/svelte';
import type { Component } from 'svelte';

/** Sidebar navigation (PLAN.md §6 pages). Workstreams fill the pages; the shell owns this list. */
export type NavItem = { href: string; label: string; icon: Component };
export type NavGroupDef = { label?: string; items: NavItem[] };

export const NAV: NavGroupDef[] = [
	{
		items: [
			{ href: '/', label: 'Overview', icon: LayoutDashboard },
			{ href: '/sites', label: 'Sites', icon: Globe }
		]
	},
	{
		label: 'Caddyfile',
		items: [
			{ href: '/editor', label: 'Editor', icon: FileCode },
			{ href: '/globals', label: 'Globals', icon: SlidersHorizontal },
			{ href: '/history', label: 'History', icon: History }
		]
	},
	{
		label: 'System',
		items: [
			{ href: '/settings', label: 'Settings', icon: Settings },
			{ href: '/about', label: 'About', icon: Info }
		]
	}
];

/** Page titles for the breadcrumb, by first path segment. */
export function pageTitle(pathname: string): string {
	const first = '/' + (pathname.split('/')[1] ?? '');
	for (const group of NAV) for (const item of group.items) if (item.href === first) return item.label;
	return 'Caddy UI';
}
