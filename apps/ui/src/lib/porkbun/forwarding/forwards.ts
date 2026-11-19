import type { RedirectType, UrlForward, UrlForwardInput } from '$lib/api/porkbun';

/**
 * Validation and wording for URL forwards (docs/porkbun-plan.md §2). Client-safe: the form and the API route
 * run the same check, so a bad value is refused before any call to Porkbun.
 */

export const REDIRECT_TYPES: readonly { value: RedirectType; label: string; hint: string }[] = [
	{ value: '301', label: '301 permanent', hint: 'Browsers and search engines remember the move.' },
	{ value: '302', label: '302 temporary', hint: 'The address stays the one people should use.' },
	{ value: '307', label: '307 temporary', hint: 'Like 302, and the request method is kept.' },
	{
		value: 'masked',
		label: 'Masked',
		hint: 'The target is shown inside a frame and the address bar stays. Many sites refuse to be framed.'
	}
];

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export const isForwardId = (id: string): boolean => ID.test(id);

export type ForwardCheck = { ok: true; value: UrlForwardInput } | { ok: false; message: string };

/** Check what a person typed. `host` is the part before the domain, '' for the apex; case is folded. */
export function checkForward(raw: unknown): ForwardCheck {
	if (!raw || typeof raw !== 'object') return { ok: false, message: 'Send the forward as a JSON object.' };
	const r = raw as Record<string, unknown>;

	const subdomain = (typeof r.subdomain === 'string' ? r.subdomain : '').trim().toLowerCase();
	if (subdomain !== '') {
		if (subdomain.length > 200 || !subdomain.split('.').every((l) => LABEL.test(l))) {
			return {
				ok: false,
				message:
					'The subdomain may hold letters, digits and hyphens, in labels of up to 63 characters. Leave it empty for the domain itself. Use the wildcard option to cover every subdomain.'
			};
		}
	}

	const location = typeof r.location === 'string' ? r.location.trim() : '';
	let target: URL | null = null;
	try {
		target = new URL(location);
	} catch {
		target = null;
	}
	if (!target || (target.protocol !== 'http:' && target.protocol !== 'https:') || !target.hostname) {
		return {
			ok: false,
			message: 'The destination must be a full web address starting with http:// or https://.'
		};
	}
	if (location.length > 2000) return { ok: false, message: 'The destination is too long.' };
	if (target.username || target.password) {
		return { ok: false, message: 'The destination must not contain a user name or password.' };
	}

	const redirectType = r.redirectType;
	if (!REDIRECT_TYPES.some((t) => t.value === redirectType)) {
		return { ok: false, message: 'The type must be 301, 302, 307 or masked.' };
	}
	if (typeof r.includePath !== 'boolean' || typeof r.wildcard !== 'boolean') {
		return { ok: false, message: '"includePath" and "wildcard" must be true or false.' };
	}

	return {
		ok: true,
		value: {
			subdomain,
			location,
			redirectType: redirectType as RedirectType,
			includePath: r.includePath,
			wildcard: r.wildcard
		}
	};
}

/** The address a forward answers on: `www.example.com`, `example.com`, `*.example.com`. */
export function forwardSource(forward: Pick<UrlForward, 'subdomain'>, domain: string): string {
	return forward.subdomain ? `${forward.subdomain}.${domain}` : domain;
}

/** One line for the review step: `www.example.com → https://example.org (301)`. */
export function describeForward(forward: UrlForwardInput, domain: string): string {
	const from = forwardSource(forward, domain) + (forward.wildcard ? ' and every subdomain' : '');
	const how = forward.redirectType === 'masked' ? 'masked' : forward.redirectType;
	return `${from} → ${forward.location} (${how}${forward.includePath ? ', keeps the path' : ''})`;
}

export function redirectLabel(type: RedirectType): string {
	return REDIRECT_TYPES.find((t) => t.value === type)?.label ?? type;
}
