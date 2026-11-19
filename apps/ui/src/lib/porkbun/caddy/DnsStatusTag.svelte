<script lang="ts">
	import { DNS_STATUS_LABEL, dnsStatusKind, type SiteDnsCheck } from '$lib/api/porkbun-caddy';
	import { Tag } from '$lib/design/components';

	/** What the records at Porkbun say about one site address, as a tag. The sentence is its tooltip. */
	type Props = { check: Pick<SiteDnsCheck, 'status' | 'detail' | 'host'>; named?: boolean };
	let { check, named = false }: Props = $props();
</script>

<span title={named ? `${check.host}: ${check.detail}` : check.detail}>
	<Tag kind={dnsStatusKind(check.status)}>{DNS_STATUS_LABEL[check.status]}</Tag>
</span>
