/** The tabs of a domain's pages (docs/porkbun-plan.md §6). The `[domain]` layout draws the bar from this. */
export type DomainTab = { slug: string; label: string };

export const DOMAIN_TABS: readonly DomainTab[] = [
	{ slug: '', label: 'Overview' },
	{ slug: 'dns', label: 'DNS' },
	{ slug: 'history', label: 'History' },
	{ slug: 'registry', label: 'Registry' },
	{ slug: 'forwarding', label: 'Forwarding' },
	{ slug: 'ssl', label: 'SSL' },
	{ slug: 'caddy', label: 'Caddy' }
];

/** `/domains/example.com/dns`. A domain name needs no escaping beyond what `encodeURIComponent` leaves alone. */
export function domainHref(domain: string, slug = ''): string {
	const base = `/domains/${encodeURIComponent(domain)}`;
	return slug ? `${base}/${slug}` : base;
}

/** The tab a path belongs to: `/domains/example.com/dns/import` is on 'dns'. */
export function currentTab(pathname: string): string {
	const slug = pathname.split('/')[3] ?? '';
	return DOMAIN_TABS.some((t) => t.slug === slug) ? slug : '';
}
