import { fail } from '@sveltejs/kit';
import { getCollector, sitesPayload } from '$lib/server/collector';
import { getConfigService } from '$lib/server/config';
import { authorOf } from '$lib/server/config/http';
import { ApplyError } from '$lib/server/config/service';
import { AdminError, AdminUnreachableError } from '$lib/server/caddy/admin';
import { getDb } from '$lib/server/db';
import { config } from '$lib/server/env';
import {
	BlockError,
	addSite,
	deleteSite,
	duplicateSite,
	moveSite,
	parseAddresses,
	scanBlocks,
	setSiteDisabled
} from '$lib/server/sites/blocks';
import { RECIPES, RecipeError, recipeById, renderRecipe } from '$lib/visual/recipes';
import type { Actions, PageServerLoad } from './$types';

export type SiteRow = {
	id: string;
	addresses: string[];
	line: number;
	disabled: boolean;
	status: 'up' | 'down' | 'unknown' | 'disabled';
	since: number | null;
	upstreams: { total: number; down: number };
	certDays: number | null;
	uptime24h: number | null;
};

export const load: PageServerLoad = async () => {
	const collector = getCollector();
	// Cheap (compares the file's mtime): makes a site that was just added show up without waiting a probe cycle.
	collector.refreshSites();
	const [file, payload] = await Promise.all([
		getConfigService().readFile(),
		sitesPayload(collector, getDb(), config().adminUrl)
	]);
	const scan = scanBlocks(file.text);
	const views = new Map(payload.sites.map((s) => [s.id, s]));
	const rows: SiteRow[] = scan.blocks
		.filter((b) => b.kind === 'site')
		.map((b) => {
			const v = b.disabled ? undefined : views.get(b.id as string);
			return {
				id: b.id as string,
				addresses: b.addresses,
				line: b.line,
				disabled: b.disabled,
				status: b.disabled ? 'disabled' : (v?.status ?? 'unknown'),
				since: v?.since ?? null,
				upstreams: {
					total: v?.upstreams.length ?? 0,
					down: v?.upstreams.filter((u) => u.status === 'down').length ?? 0
				},
				certDays: v?.cert?.daysLeft ?? null,
				uptime24h: v?.uptime24h ?? null
			};
		});
	return {
		asOf: payload.asOf,
		hash: file.hash,
		fileExists: file.exists,
		unsupported: scan.unsupported,
		rows,
		globals: scan.blocks.some((b) => b.kind === 'global'),
		snippets: scan.blocks.filter((b) => b.kind === 'snippet').map((b) => b.addresses[0] as string),
		recipes: RECIPES.filter((r) => r.kind === 'site').map(({ id, title, line, kind, fields }) => ({
			id,
			title,
			line,
			kind,
			fields
		})),
		caddyfileError: payload.sources.caddyfile.error,
		probing: payload.sources.probes.ok
	};
};

const str = (form: FormData, key: string) => {
	const v = form.get(key);
	return typeof v === 'string' ? v : '';
};

/** Reads the file, applies one block edit, and sends the result through the config service (validate, back up, load). */
async function edit(
	request: Request,
	locals: App.Locals,
	build: (text: string, form: FormData) => { text: string; note: string; done: string }
) {
	const form = await request.formData();
	const svc = getConfigService();
	try {
		const file = await svc.readFile();
		const { text, note, done } = build(file.text, form);
		const baseHash = str(form, 'baseHash') || undefined;
		const res = await svc.apply(text, { author: authorOf(locals), note, baseHash });
		return {
			ok: true as const,
			message: res.loaded ? `${done} Caddy reloaded.` : res.changed ? `${done}` : 'Nothing to change.'
		};
	} catch (err) {
		if (err instanceof BlockError) {
			const status =
				err.code === 'not_found' ? 404 : err.code === 'duplicate' ? 409 : err.code === 'bug' ? 500 : 400;
			return fail(status, { message: err.message });
		}
		if (err instanceof RecipeError) return fail(400, { message: err.message, field: err.field });
		if (err instanceof ApplyError) {
			return fail(err.status, { message: err.body.message, conflict: err.body.code === 'conflict' });
		}
		if (err instanceof AdminUnreachableError || err instanceof AdminError)
			return fail(503, { message: err.message });
		throw err;
	}
}

const label = (addresses: string[]) => addresses.join(', ');
const siteOf = (text: string, id: string) =>
	scanBlocks(text).blocks.find((b) => b.kind === 'site' && b.id === id);

export const actions: Actions = {
	add: ({ request, locals }) =>
		edit(request, locals, (text, form) => {
			const addresses = parseAddresses(str(form, 'addresses'));
			const recipe = recipeById(str(form, 'recipe'));
			if (!recipe || recipe.kind !== 'site')
				throw new BlockError('invalid', 'Pick a starting point for the new site.');
			// Recipe fields arrive as `f_<id>`; toggles are "on" when checked.
			const values: Record<string, string> = {};
			for (const [k, v] of form.entries())
				if (k.startsWith('f_') && typeof v === 'string') values[k.slice(2)] = v;
			const block = renderRecipe(recipe, { addresses }, values, scanBlocks(text).eol);
			return {
				text: addSite(text, block, addresses),
				note: `Added site ${label(addresses)}`,
				done: `Added ${label(addresses)}.`
			};
		}),
	duplicate: ({ request, locals }) =>
		edit(request, locals, (text, form) => {
			const id = str(form, 'id');
			const addresses = parseAddresses(str(form, 'addresses'));
			const from = siteOf(text, id);
			return {
				text: duplicateSite(text, id, addresses),
				note: `Duplicated ${label(from?.addresses ?? [])} as ${label(addresses)}`,
				done: `Copied ${label(from?.addresses ?? [])} to ${label(addresses)}.`
			};
		}),
	delete: ({ request, locals }) =>
		edit(request, locals, (text, form) => {
			const id = str(form, 'id');
			const from = siteOf(text, id);
			return {
				text: deleteSite(text, id),
				note: `Deleted site ${label(from?.addresses ?? [])}`,
				done: `Deleted ${label(from?.addresses ?? [])}. It stays in History if you need it back.`
			};
		}),
	toggle: ({ request, locals }) =>
		edit(request, locals, (text, form) => {
			const id = str(form, 'id');
			const disable = str(form, 'disable') === '1';
			const from = siteOf(text, id);
			return {
				text: setSiteDisabled(text, id, disable),
				note: `${disable ? 'Disabled' : 'Enabled'} site ${label(from?.addresses ?? [])}`,
				done: `${disable ? 'Disabled' : 'Enabled'} ${label(from?.addresses ?? [])}.`
			};
		}),
	move: ({ request, locals }) =>
		edit(request, locals, (text, form) => {
			const id = str(form, 'id');
			const direction = str(form, 'direction') === 'up' ? 'up' : 'down';
			const from = siteOf(text, id);
			return {
				text: moveSite(text, id, direction),
				note: `Moved site ${label(from?.addresses ?? [])} ${direction}`,
				done: `Moved ${label(from?.addresses ?? [])} ${direction}.`
			};
		})
};
