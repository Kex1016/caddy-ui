import { fail } from '@sveltejs/kit';
import { getCollector, getSnapshot, type Part, type SitesPayload } from '$lib/server/collector';
import { getConfigService } from '$lib/server/config';
import { authorOf } from '$lib/server/config/http';
import { ApplyError } from '$lib/server/config/service';
import { AdminError, AdminUnreachableError } from '$lib/server/caddy/admin';
import { siteHost } from '$lib/server/caddy/porkbun/caddyfile';
import { SiteEditError, addPorkbunToSite } from '$lib/server/caddy/porkbun/site-edit';
import { isConfigured } from '$lib/server/porkbun';
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

type Scan = ReturnType<typeof scanBlocks>;

/** The list in Caddyfile order, with each site's status from the collector's snapshot. */
function siteRows(scan: Scan, payload: SitesPayload) {
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
		rows,
		caddyfileError: payload.sources.caddyfile.error,
		probing: payload.sources.probes.ok
	};
}

export type SiteList = ReturnType<typeof siteRows>;

export const load: PageServerLoad = async ({ depends, locals }) => {
	depends('app:stats');
	const t = locals.timing;
	const collector = getCollector();
	const snap = getSnapshot();
	// Cheap (compares the file's mtime): makes a site that was just added show up without waiting a probe cycle.
	t.measure('caddyfile', () => collector.refreshSites());
	const start = performance.now();
	const file = await getConfigService().readFile();
	t.add('read', performance.now() - start);
	const scan = scanBlocks(file.text);
	// The list comes with the page when the snapshot is ready (always, after the first probe cycle); otherwise
	// the page is sent first and the list streams in (docs/settings-and-perf-plan.md §1.3 F).
	const list: Part<SiteList> = snap.sitesReady
		? siteRows(scan, snap.sitesPayload(t))
		: t.defer('sites', () => siteRows(scan, snap.sitesPayload(t)));
	return {
		hash: file.hash,
		fileExists: file.exists,
		unsupported: scan.unsupported,
		list,
		// Counted from the file, so the page can size its placeholder while the list is on its way.
		siteCount: scan.blocks.filter((b) => b.kind === 'site').length,
		globals: scan.blocks.some((b) => b.kind === 'global'),
		snippets: scan.blocks.filter((b) => b.kind === 'snippet').map((b) => b.addresses[0] as string),
		recipes: RECIPES.filter((r) => r.kind === 'site').map(({ id, title, line, kind, fields }) => ({
			id,
			title,
			line,
			kind,
			fields
		})),
		// With Porkbun keys the page asks `/api/porkbun/caddy` for its DNS column, after it has rendered.
		porkbunOn: isConfigured()
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
	build: (
		text: string,
		form: FormData
	) => { text: string; note: string; done: string; added?: string[]; dns01?: string }
) {
	const form = await request.formData();
	const svc = getConfigService();
	try {
		const file = await svc.readFile();
		const { text, note, done, added, dns01 } = build(file.text, form);
		const baseHash = str(form, 'baseHash') || undefined;
		const res = await svc.apply(text, { author: authorOf(locals), note, baseHash });
		return {
			ok: true as const,
			message: res.loaded ? `${done} Caddy reloaded.` : res.changed ? `${done}` : 'Nothing to change.',
			// The host names of a site that was just added: the page offers their DNS records next.
			...(added ? { added } : {}),
			...(dns01 ? { dns01 } : {})
		};
	} catch (err) {
		if (err instanceof SiteEditError) {
			return fail(err.code === 'not_found' ? 404 : 409, { message: err.message });
		}
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
				done: `Added ${label(addresses)}.`,
				added: addresses.flatMap((a) => siteHost(a)?.host ?? [])
			};
		}),
	/** Give a site the Porkbun DNS challenge (the wildcard hint). The keys are written as placeholders. */
	dns01: ({ request, locals }) =>
		edit(request, locals, (text, form) => {
			const id = str(form, 'id');
			const next = addPorkbunToSite(text, id);
			return {
				text: next.text,
				note: `Added the Porkbun DNS challenge to ${label(next.addresses)}`,
				done: `${label(next.addresses)} now gets its certificate through the Porkbun DNS challenge.`,
				dns01: id
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
