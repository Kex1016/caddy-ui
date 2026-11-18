import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ReviewDialog from './ReviewDialog.svelte';

const html = (props: Record<string, unknown>) =>
	render(ReviewDialog, {
		props: { open: true, title: 'Review', onapply: () => {}, ...props }
	}).body;

const ACCEPT = 'would accept it';
const BLOCKED = 'This can not be applied';

describe('ReviewDialog', () => {
	it('says Porkbun would accept a change that passed its dry run', () => {
		const out = html({ dryRun: { wouldSucceed: true, warnings: [] } });
		expect(out).toContain(ACCEPT);
		expect(out).not.toContain(BLOCKED);
	});

	it('does not say so beside a blocker, even when the dry run passed', () => {
		const out = html({ dryRun: { wouldSucceed: true, warnings: [] }, blocked: 'DNSSEC is active.' });
		expect(out).toContain(BLOCKED);
		expect(out).not.toContain(ACCEPT);
	});

	it('still shows a refusal of the dry run beside a blocker', () => {
		const out = html({
			dryRun: { wouldSucceed: false, warnings: [], error: { code: 'X', message: 'no', retryable: false } },
			blocked: 'Nothing to restore.'
		});
		expect(out).toContain(BLOCKED);
		expect(out).toContain('Porkbun would refuse this change');
	});
});
