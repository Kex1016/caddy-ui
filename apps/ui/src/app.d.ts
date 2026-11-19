import type { Identity } from '$lib/server/auth';
import type { Theme } from '$lib/theme';
import type { Timing } from '$lib/server/timing';

declare global {
	namespace App {
		interface Locals {
			identity: Identity | null;
			theme: Theme;
			/** Step timings for the `Server-Timing` header and the slow-load log (hooks.server.ts). */
			timing: Timing;
		}
		interface Error {
			message: string;
			code?: string;
		}
	}
}

export {};
