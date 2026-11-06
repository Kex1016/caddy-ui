<script lang="ts">
	import { RECIPES, type Recipe } from '../recipes';

	type Props = {
		recipes?: Recipe[];
		/** Chosen recipe id (bindable). */
		recipe: string;
		/** Field values by id (bindable); toggles hold "on". */
		values: Record<string, string>;
		kinds?: Recipe['kind'][];
		/** A field to mark as wrong, with the message. */
		error?: { field: string; message: string } | null;
		/** Input names for form posts: `f_<field>`; the recipe radio is named `recipe`. */
		namePrefix?: string;
	};
	let {
		recipes = RECIPES,
		recipe = $bindable(),
		values = $bindable(),
		kinds = ['site'],
		error = null,
		namePrefix = 'f_'
	}: Props = $props();

	const shown = $derived(recipes.filter((r) => kinds.includes(r.kind)));
	const current = $derived(shown.find((r) => r.id === recipe));
	const id = `rp-${Math.random().toString(36).slice(2, 8)}`;

	function choose(r: Recipe) {
		recipe = r.id;
		const next: Record<string, string> = {};
		for (const f of r.fields) next[f.id] = values[f.id] ?? f.default ?? '';
		values = next;
	}
</script>

<div class="rp">
	<div class="rp__grid" role="radiogroup" aria-label="Start from">
		{#each shown as r (r.id)}
			<label class="rp__card" class:rp__card--on={r.id === recipe}>
				<input
					class="visually-hidden"
					type="radio"
					name="recipe"
					value={r.id}
					checked={r.id === recipe}
					onchange={() => choose(r)}
				/>
				<span class="rp__title t-ui">{r.title}</span>
				<span class="rp__line t-caption">{r.line}</span>
			</label>
		{/each}
	</div>
	{#if current && current.fields.length}
		<div class="rp__fields">
			{#each current.fields as f (f.id)}
				{#if f.kind === 'toggle'}
					<label class="rp__toggle">
						<input
							type="checkbox"
							name="{namePrefix}{f.id}"
							value="on"
							checked={values[f.id] === 'on'}
							onchange={(e) => (values[f.id] = (e.currentTarget as HTMLInputElement).checked ? 'on' : '')}
						/>
						<span class="t-ui">{f.label}</span>
						{#if f.help}<span class="t-caption t-muted rp__help">{f.help}</span>{/if}
					</label>
				{:else}
					<div class="rp__field">
						<label class="t-ui rp__label" for="{id}-{f.id}"
							>{f.label}{#if f.required}<span class="rp__req" aria-hidden="true"> *</span>{/if}</label
						>
						{#if f.kind === 'select'}
							<span class="fp-select">
								<select id="{id}-{f.id}" name="{namePrefix}{f.id}" bind:value={values[f.id]}>
									{#each f.options ?? [] as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
								</select>
							</span>
						{:else}
							<span class="fp-field" class:rp__bad={error?.field === f.id}>
								<input
									id="{id}-{f.id}"
									name="{namePrefix}{f.id}"
									bind:value={values[f.id]}
									placeholder={f.placeholder}
									required={f.required}
									spellcheck="false"
									autocomplete="off"
								/>
							</span>
						{/if}
						{#if error?.field === f.id}
							<span class="t-caption rp__err">{error.message}</span>
						{:else if f.help}
							<span class="t-caption t-muted">{f.help}</span>
						{/if}
					</div>
				{/if}
			{/each}
		</div>
	{/if}
</div>

<style>
	.rp {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.rp__grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
		gap: var(--space-2);
	}
	.rp__card {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: var(--space-3);
		border: 1px solid var(--line);
		border-radius: var(--radius-lg);
		background: var(--surface);
		cursor: pointer;
	}
	.rp__card:hover {
		background: var(--raised);
	}
	.rp__card--on {
		border-color: var(--acc-ink);
		background: var(--acc-soft);
	}
	.rp__card:has(:focus-visible) {
		box-shadow: var(--focus-ring);
	}
	.rp__title {
		font-weight: 600;
	}
	.rp__line {
		color: var(--muted);
	}
	.rp__fields {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
	}
	.rp__field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.rp__label {
		font-weight: 500;
	}
	.rp__req {
		color: var(--faint);
	}
	.rp__field input {
		font-family: var(--font-mono);
		font-size: 13px;
	}
	.rp__toggle {
		display: grid;
		grid-template-columns: auto 1fr;
		column-gap: var(--space-2);
		align-items: center;
	}
	.rp__help {
		grid-column: 2;
	}
	.rp__bad {
		border-color: var(--error-ink);
	}
	.rp__err {
		color: var(--error-ink);
	}
</style>
