<script lang="ts">
	import type { EditableSetting } from '$lib/api/settings';
	import { Tag } from '$lib/design/components';
	import { FIELDS, fallback, sourceLabel } from '../meta';

	/**
	 * One editable setting (docs/settings-and-perf-plan.md §2.2): the input, where the value in force comes from,
	 * the environment's value when a saved one overrides it, and "Use the environment's value" to remove the
	 * saved one. The section around it saves; the reset applies on its own.
	 */
	type Props = {
		row: EditableSetting;
		value: string;
		error?: string;
		/** Saving is refused (CADDY_UI_SETTINGS_IGNORE); the reset still works. */
		locked?: boolean;
		/** The UI has a sign-in, which allowing Porkbun changes needs. */
		signIn?: boolean;
		busy?: boolean;
		timeZones?: string[];
		onreset: () => void;
	};
	let {
		row,
		value = $bindable(),
		error,
		locked = false,
		signIn = true,
		busy = false,
		timeZones = [],
		onreset
	}: Props = $props();

	const meta = $derived(FIELDS[row.key] ?? { label: row.key, hint: '', kind: 'duration' as const });
	const id = $derived(`set-${row.key.toLowerCase()}`);
	const back = $derived(fallback(row));
	const hasSaved = $derived(row.saved !== null);
	const differsFromEnv = $derived(hasSaved && row.env !== null && row.saved !== row.env);
	const describedBy = $derived(
		[`${id}-hint`, `${id}-src`, error ? `${id}-err` : ''].filter(Boolean).join(' ')
	);
	const backText = $derived(back.value === null || back.value === '' ? 'none' : back.value);
</script>

<div class="setting" class:setting--error={!!error}>
	<div class="setting__head">
		{#if meta.kind === 'readonly'}
			<span class="t-ui setting__label" id="{id}-label">{meta.label}</span>
		{:else}
			<label class="t-ui setting__label" for={id}>{meta.label}</label>
		{/if}
		<span class="t-mono t-caption setting__key">{row.key}</span>
	</div>

	{#if meta.kind === 'readonly'}
		<div class="fp-seg" role="group" aria-labelledby="{id}-label" aria-describedby={describedBy}>
			<button
				type="button"
				aria-pressed={value === 'false'}
				disabled={locked || (!signIn && value !== 'false')}
				onclick={() => (value = 'false')}>Changes allowed</button
			>
			<button type="button" aria-pressed={value === 'true'} disabled={locked} onclick={() => (value = 'true')}
				>Read-only</button
			>
		</div>
	{:else}
		<span class="fp-field setting__input">
			<input
				{id}
				class="t-mono"
				bind:value
				placeholder={meta.placeholder}
				autocomplete="off"
				autocapitalize="off"
				spellcheck="false"
				disabled={locked}
				inputmode={meta.kind === 'days' ? 'numeric' : meta.kind === 'url' ? 'url' : undefined}
				list={meta.kind === 'timezone' && timeZones.length ? `${id}-zones` : undefined}
				aria-invalid={error ? 'true' : undefined}
				aria-describedby={describedBy}
			/>
			{#if meta.kind === 'days'}<span class="t-caption">days</span>{/if}
		</span>
		{#if meta.kind === 'timezone' && timeZones.length}
			<datalist id="{id}-zones">
				{#each timeZones as z (z)}<option value={z}></option>{/each}
			</datalist>
		{/if}
	{/if}

	<p class="t-caption" id="{id}-hint">
		{meta.hint}
		{#if meta.kind === 'readonly' && !signIn}
			Allowing changes needs a sign-in (forward auth, or a local user and password), which this UI does not
			have.
		{/if}
	</p>
	{#if error}<p class="t-ui setting__err" id="{id}-err">{error}</p>{/if}

	<div class="setting__src" id="{id}-src">
		{#if row.ignoredReason}
			<Tag kind="warning">Saved value not used</Tag>
			<span class="t-caption">{row.ignoredReason}</span>
		{:else}
			<Tag kind={row.source === 'saved' ? 'acc' : 'neutral'}>{sourceLabel(row)}</Tag>
			{#if differsFromEnv}
				<span class="t-caption">The environment has <code>{row.env}</code>.</span>
			{:else if hasSaved && row.env === null}
				<span class="t-caption">The default is <code>{backText}</code>.</span>
			{/if}
		{/if}
		{#if hasSaved}
			<button type="button" class="fp-btn fp-btn--quiet setting__reset" disabled={busy} onclick={onreset}>
				{back.from === 'env' ? 'Use the environment’s value' : 'Use the default'}
				<span class="visually-hidden">for {meta.label} ({backText})</span>
			</button>
		{/if}
	</div>
</div>

<style>
	.setting {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		min-width: 0;
	}
	.setting__head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.setting__label {
		font-weight: 600;
	}
	.setting__key {
		overflow-wrap: anywhere;
	}
	.setting__input {
		width: 100%;
		max-width: 28rem;
	}
	.setting--error .fp-field {
		border-color: var(--error-ink);
	}
	.setting__err {
		color: var(--error-ink);
	}
	.setting__src {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
		min-height: var(--size-control);
	}
	.fp-seg {
		align-self: flex-start;
	}
	.fp-seg > button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
