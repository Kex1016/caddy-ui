import type { Identity } from '$lib/server/auth';
import type { Theme } from '$lib/theme';

declare global {
	namespace App {
		interface Locals {
			identity: Identity | null;
			theme: Theme;
		}
		interface Error {
			message: string;
			code?: string;
		}
	}
}

export {};
