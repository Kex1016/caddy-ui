import type { View } from './types';

/** `?key=value` on the current URL, keeping every other parameter; null removes the key. Returns path + query. */
export function withParam(url: URL, key: string, value: string | null): string {
	const params = new URLSearchParams(url.searchParams);
	if (value === null) params.delete(key);
	else params.set(key, value);
	const q = params.toString();
	return `${url.pathname}${q ? `?${q}` : ''}`;
}

export function viewParam(url: URL): View {
	return url.searchParams.get('view') === 'tables' ? 'tables' : 'charts';
}
