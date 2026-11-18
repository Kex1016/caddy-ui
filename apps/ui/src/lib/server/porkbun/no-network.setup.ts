/**
 * Loaded before every unit test (vite.config.ts `setupFiles`): no test may talk to Porkbun. Tests use the
 * in-memory fake; if one reaches for the real API by mistake, it fails here instead of touching an account.
 */
const realFetch = globalThis.fetch;

globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
	const url = input instanceof Request ? input.url : String(input);
	let host = '';
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		// Not an absolute URL; let fetch report it.
	}
	if (host === 'porkbun.com' || host.endsWith('.porkbun.com')) {
		return Promise.reject(
			new Error(`A unit test tried to reach ${host}. Use the fake in $lib/server/porkbun/testing.`)
		);
	}
	return realFetch(input, init);
}) as typeof fetch;
