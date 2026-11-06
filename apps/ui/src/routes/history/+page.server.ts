import { fail } from '@sveltejs/kit';
import { getConfigService } from '$lib/server/config';
import { authorOf } from '$lib/server/config/http';
import { ApplyError } from '$lib/server/config/service';
import { AdminError, AdminUnreachableError } from '$lib/server/caddy/admin';
import type { Actions, PageServerLoad } from './$types';

/** Revisions, newest first; with `?rev=N`, that revision's text and the text it is compared against. */
export const load: PageServerLoad = async ({ url }) => {
	const svc = getConfigService();
	const revisions = svc.listRevisions();
	const file = await svc.readFile();
	const selectedId = Number(url.searchParams.get('rev') ?? revisions[0]?.id ?? NaN);
	const selected = Number.isSafeInteger(selectedId) ? svc.getRevision(selectedId) : undefined;
	const against = url.searchParams.get('against') === 'current' ? 'current' : 'previous';
	let base: { label: string; text: string } | null = null;
	if (selected) {
		if (against === 'current') {
			base = { label: 'the file on disk now', text: file.text };
		} else {
			const idx = revisions.findIndex((r) => r.id === selected.id);
			const prev = revisions[idx + 1];
			const prevRev = prev ? svc.getRevision(prev.id) : undefined;
			base = prevRev ? { label: `revision #${prevRev.id}`, text: prevRev.text } : null;
		}
	}
	return {
		revisions,
		selected: selected ?? null,
		against,
		base,
		currentHash: file.hash,
		externalChange: svc.externalChange,
		drift: await svc.drift()
	};
};

export const actions: Actions = {
	restore: async ({ request, locals }) => {
		const id = Number((await request.formData()).get('id'));
		if (!Number.isSafeInteger(id)) return fail(400, { message: 'Pick a revision to restore' });
		try {
			const res = await getConfigService().restore(id, authorOf(locals));
			if (!res) return fail(404, { message: `Revision #${id} no longer exists` });
			return {
				restored: id,
				message: res.changed
					? `Restored revision #${id}${res.loaded ? ' and reloaded Caddy' : ''}.`
					: `Revision #${id} is already what is on disk and what Caddy runs; nothing changed.`
			};
		} catch (err) {
			if (err instanceof ApplyError) return fail(err.status, { message: err.body.message });
			if (err instanceof AdminUnreachableError || err instanceof AdminError) {
				return fail(503, { message: err.message });
			}
			throw err;
		}
	}
};
