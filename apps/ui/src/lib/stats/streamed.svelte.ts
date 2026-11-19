/**
 * A page part that is either in the page data already or still streaming in (a promise from a server `load`,
 * docs/settings-and-perf-plan.md §1.3 F). `current` is the latest value, kept while a refresh streams the
 * next one, so the 30-second refresh swaps numbers in place instead of flashing placeholders. It goes back to
 * undefined (placeholders) only when `key` changes, such as a different range, where the old value would be
 * the wrong data. Create it during component setup.
 */
export class Streamed<T> {
	current = $state<T | undefined>(undefined);
	error = $state<string | null>(null);
	private key: unknown;

	constructor(get: () => T | Promise<T>, key: () => unknown = () => undefined) {
		const first = get();
		this.key = key();
		if (!isPromise(first)) this.current = first;
		$effect(() => {
			const v = get();
			const k = key();
			if (k !== this.key) {
				this.key = k;
				this.current = undefined;
			}
			if (!isPromise(v)) {
				this.current = v;
				this.error = null;
				return;
			}
			let live = true;
			v.then(
				(r) => {
					if (!live) return;
					this.current = r;
					this.error = null;
				},
				(err: unknown) => {
					if (!live) return;
					this.error = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
				}
			);
			return () => {
				live = false;
			};
		});
	}
}

export function isPromise<T>(v: T | Promise<T>): v is Promise<T> {
	return typeof (v as { then?: unknown } | null)?.then === 'function';
}
