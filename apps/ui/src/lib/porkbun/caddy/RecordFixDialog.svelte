<script lang="ts">
	import type { ApiError, DryRun } from '$lib/api/porkbun';
	import { fixTitle, type RecordFix, type SiteDnsCheck } from '$lib/api/porkbun-caddy';
	import { ReviewDialog } from '$lib/porkbun/components';
	import type { ReviewChange } from '$lib/porkbun/types';
	import { applyFix, previewFix } from './api';

	/**
	 * The review step for the one record a site needs (docs/porkbun-plan.md §4): create it, or point the one
	 * that is wrong at this server. Opening it only rehearses the change at Porkbun; the write happens on Apply.
	 * The server works the change out again each time, so what is applied is what was reviewed or nothing.
	 */
	type Props = {
		/** The site address to fix. The dialog is open while this is set and has a fix. */
		check: SiteDnsCheck | null;
		title?: string;
		/** Said above the change, for example that the site was just added. */
		lead?: string;
		/** After Porkbun accepted the write. */
		ondone: (host: string) => void;
		/** Whenever the dialog closes, applied or not. */
		onclose: () => void;
	};
	let { check, title, lead, ondone, onclose }: Props = $props();

	let open = $state(false);
	let host = $state('');
	let fix = $state<RecordFix | null>(null);
	let dryRun = $state<DryRun | 'running' | null>(null);
	let blocked = $state<string | null>(null);
	let error = $state<ApiError | null>(null);
	let changed = $state(false);
	let busy = $state(false);
	let run = 0;

	$effect(() => {
		if (check?.fix) {
			host = check.host;
			fix = check.fix;
			blocked = null;
			error = null;
			changed = false;
			open = true;
			void rehearse(check.host, check.fix);
		}
	});

	async function rehearse(name: string, expected: RecordFix) {
		const mine = ++run;
		dryRun = 'running';
		const res = await previewFix(name, expected);
		if (mine !== run) return;
		if (res.ok) {
			fix = res.data.fix;
			dryRun = res.data.dryRun;
		} else if (res.fix) {
			// The records changed since the page read them: review the change as it is now.
			fix = res.fix;
			changed = true;
			await rehearse(name, res.fix);
		} else {
			dryRun = null;
			blocked = res.error.message;
		}
	}

	async function apply() {
		if (!fix) return;
		busy = true;
		error = null;
		const res = await applyFix(host, fix);
		busy = false;
		if (res.ok && res.data.result.ok) {
			ondone(host);
			open = false;
		} else if (res.ok) {
			if (!res.data.result.ok) error = res.data.result.error;
		} else if (res.fix) {
			fix = res.fix;
			changed = true;
			await rehearse(host, res.fix);
		} else {
			error = res.error;
		}
	}

	const changes = $derived<ReviewChange[]>(
		fix
			? [
					{
						kind: fix.kind,
						title: fixTitle(fix),
						before: fix.before ?? null,
						after: fix.content,
						note: `${fix.content} is the address Porkbun sees this server call from. If visitors reach Caddy through another address, set the record on the DNS tab instead.`
					}
				]
			: []
	);
	const intro = $derived(
		[
			lead,
			fix?.kind === 'edit'
				? `The record for ${host} points somewhere else. This changes it to point at this server.`
				: `Nothing at Porkbun answers for ${host}, so visitors can not reach the site. This creates the record that points it at this server.`
		]
			.filter(Boolean)
			.join(' ')
	);
</script>

<ReviewDialog
	bind:open
	title={title ?? (fix?.kind === 'edit' ? 'Point the record at this server' : 'Create the DNS record')}
	{intro}
	{changes}
	{dryRun}
	{blocked}
	{busy}
	{error}
	warnings={changed
		? ['The records changed since this page read them. The change above is the current one.']
		: []}
	applyLabel={fix?.kind === 'edit' ? 'Change the record' : 'Create the record'}
	onapply={apply}
	oncancel={() => {
		run++;
		onclose();
	}}
/>
