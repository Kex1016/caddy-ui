<script lang="ts">
	import { ExternalLink, Image } from '@lucide/svelte';
	import { formatDateTime, formatElapsed } from '$lib/format';
	import { parse, type Inline, type Line } from '../markdown';
	import { C, intToHex, type Component, type EmbedPayload } from '../templates';

	/**
	 * A close likeness of how Discord shows the message, from the same payload the sender posts: Components v2,
	 * or the classic embed a webhook gets after refusing v2. Built from a tree, never from HTML.
	 */
	type Props = {
		components?: Component[];
		embed?: EmbedPayload;
		timeZone: string;
		now: number;
	};
	let { components, embed, timeZone, now }: Props = $props();

	const kids = (c: Component) => (Array.isArray(c.components) ? (c.components as Component[]) : []);
	const accent = (c: Component) => (typeof c.accent_color === 'number' ? intToHex(c.accent_color) : null);
	const lines = (c: Component): Line[] => (typeof c.content === 'string' ? parse(c.content) : []);
	const timeText = (n: Extract<Inline, { k: 'time' }>) =>
		n.style === 'R'
			? n.ts >= now
				? `in ${formatElapsed(n.ts - now)}`
				: `${formatElapsed(now - n.ts)} ago`
			: formatDateTime(n.ts, timeZone);
</script>

{#snippet inl(
	nodes: Inline[]
)}{#each nodes as n, i (i)}{#if n.k === 'text'}{n.v}{:else if n.k === 'code'}<code>{n.v}</code
			>{:else if n.k === 'b'}<strong>{@render inl(n.c)}</strong>{:else if n.k === 'i'}<em
				>{@render inl(n.c)}</em
			>{:else if n.k === 'u'}<u>{@render inl(n.c)}</u>{:else if n.k === 's'}<s>{@render inl(n.c)}</s
			>{:else if n.k === 'link'}<a href={n.href} target="_blank" rel="noopener noreferrer"
				>{@render inl(n.c)}</a
			>{:else if n.k === 'time'}<span class="time">{timeText(n)}</span>{:else if n.k === 'mention'}<span
				class="mention">{n.v}</span
			>{/if}{/each}{/snippet}

{#snippet text(list: Line[])}
	{#each list as l, i (i)}
		{#if l.k === 'h1'}<p class="h1">{@render inl(l.c)}</p>
		{:else if l.k === 'h2'}<p class="h2">{@render inl(l.c)}</p>
		{:else if l.k === 'h3'}<p class="h3">{@render inl(l.c)}</p>
		{:else if l.k === 'sub'}<p class="sub">{@render inl(l.c)}</p>
		{:else if l.k === 'quote'}<p class="quote">{@render inl(l.c)}</p>
		{:else}<p class="p">{@render inl(l.c)}</p>
		{/if}
	{/each}
{/snippet}

{#snippet button(c: Component)}
	<a
		class="btn"
		href={typeof c.url === 'string' ? c.url : undefined}
		target="_blank"
		rel="noopener noreferrer"
	>
		{typeof c.label === 'string' ? c.label : ''}
		<ExternalLink size={14} strokeWidth={1.6} aria-hidden="true" />
	</a>
{/snippet}

{#snippet comp(c: Component)}
	{#if c.type === C.Container}
		<div class="box" style:border-left-color={accent(c) ?? 'transparent'}>
			{#each kids(c) as k, i (i)}{@render comp(k)}{/each}
		</div>
	{:else if c.type === C.TextDisplay}
		<div class="td">{@render text(lines(c))}</div>
	{:else if c.type === C.Section}
		<div class="section">
			<div class="section__text">
				{#each kids(c) as k, i (i)}{@render comp(k)}{/each}
			</div>
			{#if c.accessory}{@render comp(c.accessory as Component)}{/if}
		</div>
	{:else if c.type === C.ActionRow}
		<div class="row">
			{#each kids(c) as k, i (i)}{@render comp(k)}{/each}
		</div>
	{:else if c.type === C.Button}
		{@render button(c)}
	{:else if c.type === C.Separator}
		<div class="sep" class:sep--line={c.divider !== false} class:sep--large={c.spacing === 2}></div>
	{:else if c.type === C.Thumbnail || c.type === C.MediaGallery}
		<div class="media" class:media--thumb={c.type === C.Thumbnail}>
			<Image size={18} strokeWidth={1.4} aria-hidden="true" />
		</div>
	{/if}
{/snippet}

<div class="msg" aria-label="Preview of the Discord message">
	<div class="msg__head">
		<span class="msg__avatar" aria-hidden="true"></span>
		<span class="t-ui msg__name">Webhook</span>
		<span class="t-caption msg__when">{formatDateTime(now, timeZone)}</span>
	</div>
	<div class="msg__body">
		{#if embed}
			{#if embed.content}<div class="td">{@render text(parse(embed.content))}</div>{/if}
			{#each embed.embeds as e, i (i)}
				<div class="box embed" style:border-left-color={intToHex(e.color)}>
					{#if e.title}
						<p class="embed__title">
							{#if e.url}<a href={e.url} target="_blank" rel="noopener noreferrer">{e.title}</a
								>{:else}{e.title}{/if}
						</p>
					{/if}
					{#if e.description}<div class="td">{@render text(parse(e.description))}</div>{/if}
					<p class="sub">{e.footer.text} · {formatDateTime(Date.parse(e.timestamp), timeZone)}</p>
				</div>
			{/each}
		{:else if components}
			{#each components as c, i (i)}{@render comp(c)}{/each}
		{/if}
		<p class="t-caption msg__note">
			Times show in {timeZone} here; Discord shows each reader their own time zone.
		</p>
	</div>
</div>

<style>
	.msg {
		border: 1px solid var(--line-soft);
		border-radius: var(--radius-md);
		background: var(--sunk);
		padding: var(--space-3) var(--space-4) var(--space-4);
		min-width: 0;
	}
	.msg__head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		margin-bottom: var(--space-2);
	}
	.msg__avatar {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: var(--acc);
		flex: none;
	}
	.msg__name {
		font-weight: 600;
		white-space: nowrap;
	}
	.msg__when,
	.msg__note {
		color: var(--muted);
	}
	.msg__note {
		margin: var(--space-3) 0 0;
	}
	.msg__body {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		min-width: 0;
	}
	.box {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		border: 1px solid var(--line-soft);
		border-left: 4px solid transparent;
		border-radius: var(--radius-sm);
		background: var(--surface);
		padding: var(--space-3) var(--space-4);
		min-width: 0;
		max-width: 36rem;
	}
	.td p {
		margin: 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font: 400 14px/20px var(--font-text);
	}
	.td .h1 {
		font: 700 20px/26px var(--font-text);
	}
	.td .h2 {
		font: 700 17px/24px var(--font-text);
	}
	.td .h3 {
		font: 700 15px/22px var(--font-text);
	}
	.sub {
		margin: 0;
		color: var(--muted);
		font: 400 12px/16px var(--font-text);
	}
	.td .quote {
		border-left: 3px solid var(--line);
		padding-left: var(--space-2);
	}
	code {
		font-family: var(--font-mono);
		font-size: 13px;
		background: var(--sunk);
		border-radius: 3px;
		padding: 0 3px;
	}
	.time,
	.mention {
		border-radius: 3px;
		padding: 0 2px;
		background: var(--sunk);
	}
	.mention {
		color: var(--acc-ink);
		font-weight: 500;
	}
	.section {
		display: flex;
		gap: var(--space-3);
		align-items: flex-start;
		justify-content: space-between;
	}
	.section__text {
		min-width: 0;
		flex: 1;
	}
	.row {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.btn {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		height: 32px;
		padding: 0 var(--space-3);
		border-radius: var(--radius-sm);
		background: var(--sunk);
		border: 1px solid var(--line-soft);
		color: var(--text);
		font: 500 14px/20px var(--font-text);
		text-decoration: none;
	}
	.btn:hover {
		text-decoration: none;
		border-color: var(--line);
	}
	.sep {
		height: var(--space-1);
	}
	.sep--large {
		height: var(--space-3);
	}
	.sep--line {
		height: 0;
		border-top: 1px solid var(--line-soft);
		margin: var(--space-1) 0;
	}
	.media {
		display: grid;
		place-items: center;
		height: 96px;
		border-radius: var(--radius-sm);
		background: var(--sunk);
		color: var(--muted);
	}
	.media--thumb {
		width: 64px;
		height: 64px;
		flex: none;
	}
	.embed__title {
		margin: 0;
		font: 700 15px/22px var(--font-text);
	}
</style>
