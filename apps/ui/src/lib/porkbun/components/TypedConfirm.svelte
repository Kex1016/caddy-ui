<script lang="ts">
	/**
	 * "Type example.com to confirm", for actions that are destructive or hard to reverse
	 * (docs/porkbun-plan.md §3.1 rule 3). Bind `matches` and keep the action disabled until it is true.
	 */
	type Props = {
		/** What has to be typed: the domain name. Compared without regard to case or surrounding spaces. */
		expected: string;
		matches?: boolean;
		/** Says what typing it will do: "to change the nameservers". */
		purpose?: string;
	};
	let { expected, matches = $bindable(false), purpose = 'to confirm' }: Props = $props();

	let value = $state('');
	const id = `tc-${Math.random().toString(36).slice(2, 9)}`;

	$effect(() => {
		matches = expected !== '' && value.trim().toLowerCase() === expected.trim().toLowerCase();
	});
</script>

<div class="tc">
	<label class="t-ui" for={id}>Type <code>{expected}</code> {purpose}</label>
	<span class="fp-field">
		<input
			{id}
			bind:value
			class="t-mono"
			autocomplete="off"
			autocapitalize="off"
			spellcheck="false"
			aria-invalid={value !== '' && !matches ? 'true' : undefined}
		/>
	</span>
</div>

<style>
	.tc {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.tc .fp-field {
		width: 100%;
	}
</style>
