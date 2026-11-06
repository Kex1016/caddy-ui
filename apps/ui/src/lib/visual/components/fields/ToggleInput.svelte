<script lang="ts">
	import type { Directive } from '@caddy-ui/caddyfile';
	import type { ToggleField } from '../../forms/types';

	type Props = { field: ToggleField; node: Directive; commit: () => void };
	let { field, node, commit }: Props = $props();
	const on = $derived(field.get(node));
	const id = `fld-${Math.random().toString(36).slice(2, 8)}`;
</script>

<div class="tgl">
	<label class="tgl__row" for={id}>
		<input
			{id}
			type="checkbox"
			role="switch"
			checked={on}
			onchange={(e) => {
				field.set(node, (e.currentTarget as HTMLInputElement).checked);
				commit();
			}}
		/>
		<span class="tgl__track" aria-hidden="true"><span class="tgl__knob"></span></span>
		<span class="t-ui tgl__label">{field.label}</span>
	</label>
	{#if field.help}<p class="t-caption tgl__hint">{field.help}</p>{/if}
</div>

<style>
	.tgl {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.tgl__row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		cursor: pointer;
	}
	.tgl__row input {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
	}
	.tgl__track {
		position: relative;
		width: 36px;
		height: 20px;
		border-radius: 10px;
		background: var(--line);
		transition: background-color var(--duration-switch) var(--ease-glide);
		flex: none;
	}
	.tgl__knob {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--surface);
		box-shadow: var(--shadow-pill);
		transition: transform var(--duration-switch) var(--ease-glide);
	}
	input:checked + .tgl__track {
		background: var(--acc);
	}
	input:checked + .tgl__track .tgl__knob {
		transform: translateX(16px);
	}
	input:focus-visible + .tgl__track {
		box-shadow: var(--focus-ring);
	}
	.tgl__label {
		font-weight: 500;
	}
	.tgl__hint {
		color: var(--muted);
		padding-left: calc(36px + var(--space-3));
	}
</style>
