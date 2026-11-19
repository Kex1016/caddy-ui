<script lang="ts">
	import { EmptyState, Notice, Tag } from '$lib/design/components';
	import { PorkbunNotice } from '$lib/porkbun/components';
	import { formatDateTime } from '$lib/format';

	let { data } = $props();

	const domain = $derived(data.domain?.domain ?? '');
	const download = $derived(`/api/porkbun/domains/${encodeURIComponent(domain)}/ssl/download`);
	const leaf = $derived(data.info?.certificates[0] ?? null);

	const DAY = 86_400_000;
	const left = $derived(leaf?.validTo ? Math.floor((Date.parse(leaf.validTo) - data.checkedAt) / DAY) : null);
	const when = (iso: string) => (iso ? formatDateTime(Date.parse(iso), data.timeZone) : 'unknown');
</script>

<section class="fp-section">
	<div class="fp-section__head"><h2 class="t-title-2">SSL certificate</h2></div>
	<p class="t-body t-muted">
		The free certificate Porkbun issues for this domain. It is asked of Porkbun each time this page opens and
		is not stored by Caddy UI. This is separate from the certificates Caddy gets for your sites.
	</p>

	<PorkbunNotice error={data.error} />

	{#if data.info}
		{#if leaf}
			<div class="fp-panel">
				<dl class="facts">
					<dt>Issued to</dt>
					<dd class="t-mono">{leaf.subject}</dd>
					<dt>Issued by</dt>
					<dd class="t-mono">{leaf.issuer}</dd>
					<dt>Valid from</dt>
					<dd>{when(leaf.validFrom)}</dd>
					<dt>Expires</dt>
					<dd>
						{when(leaf.validTo)}
						{#if left !== null}
							{#if left < 0}<Tag kind="error">expired</Tag>
							{:else if left <= 14}<Tag kind="warning">{left} days left</Tag>
							{:else}<Tag kind="success">{left} days left</Tag>{/if}
						{/if}
					</dd>
					{#if leaf.altNames.length > 0}
						<dt>Names</dt>
						<dd class="t-mono names">{leaf.altNames.join(', ')}</dd>
					{/if}
					<dt>Serial</dt>
					<dd class="t-mono">{leaf.serial}</dd>
					<dt>SHA-256</dt>
					<dd class="t-mono">{leaf.fingerprint256}</dd>
					<dt>Chain</dt>
					<dd>{data.info.chainLength} certificate{data.info.chainLength === 1 ? '' : 's'}</dd>
				</dl>
			</div>
		{:else}
			<Notice kind="warning">
				Porkbun sent a certificate chain this UI could not read, so its details are not shown. The files can
				still be downloaded.
			</Notice>
		{/if}

		<div class="fp-panel downloads">
			<h3 class="t-title-2">Download</h3>
			<p>
				<a class="fp-btn" href="{download}?part=chain" download>Certificate chain (.pem)</a>
			</p>
			{#if data.info.keyDownloadEnabled}
				<Notice kind="warning">
					<b>The private key lets anyone who has it impersonate this domain.</b> Each download is written to the
					activity log.
				</Notice>
				<p><a class="fp-btn" href="{download}?part=key" download>Private key (.pem)</a></p>
			{:else}
				<p>
					<button type="button" class="fp-btn" disabled>Private key (.pem)</button>
				</p>
				<p class="t-caption">
					Downloading the private key is off. To allow it, set
					<code>CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD=true</code> on the caddy-ui service and restart it.
				</p>
			{/if}
		</div>
	{:else if !data.error}
		<EmptyState title="No certificate" line="Porkbun has not issued a certificate for this domain." />
	{/if}
</section>

<style>
	.facts {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: var(--space-2) var(--space-5);
		margin: 0;
	}
	.facts dt {
		color: var(--muted);
	}
	.facts dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.downloads {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		align-items: flex-start;
	}
	@media (max-width: 560px) {
		.facts {
			grid-template-columns: 1fr;
			gap: 0;
		}
		.facts dd {
			margin-bottom: var(--space-3);
		}
	}
</style>
