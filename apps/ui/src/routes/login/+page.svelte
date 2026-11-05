<script lang="ts">
	import { Brand, Notice } from '$lib/design/components';

	let { data, form } = $props();
</script>

<div class="login">
	<div class="fp-panel login__panel">
		<Brand />
		<h1 class="t-title-2">Sign in</h1>
		{#if data.mode === 'local'}
			{#if form?.message}<Notice kind="error">{form.message}</Notice>{/if}
			<form method="POST" class="login__form">
				<label class="login__label">
					<span class="t-ui">Username</span>
					<span class="fp-field">
						<input
							name="user"
							autocomplete="username"
							required
							value={form && 'user' in form ? form.user : ''}
						/>
					</span>
				</label>
				<label class="login__label">
					<span class="t-ui">Password</span>
					<span class="fp-field">
						<input name="password" type="password" autocomplete="current-password" required />
					</span>
				</label>
				<button type="submit" class="fp-btn fp-btn--primary">Sign in</button>
			</form>
		{:else if data.mode === 'forward'}
			<Notice kind="warning">
				<b>Sign in through your proxy.</b> This UI expects the proxy in front of it to sign you in and pass your
				name in the Remote-User header, and that header was missing. Open the UI through Caddy, not on its own port.
			</Notice>
		{:else if data.mode === 'local-misconfigured'}
			<Notice kind="error">
				<b>Sign-in is not set up.</b>
				{data.missing} is unset. Set both CADDY_UI_USER and CADDY_UI_PASSWORD, or unset both, and restart the container.
			</Notice>
		{:else}
			<p class="t-body t-muted">Sign-in is not required. <a href="/">Go to the overview</a>.</p>
		{/if}
	</div>
</div>

<style>
	.login {
		min-height: 100dvh;
		display: grid;
		place-items: center;
		padding: var(--space-6) var(--space-4);
	}
	.login__panel {
		width: min(360px, 100%);
		display: flex;
		flex-direction: column;
		gap: var(--space-5);
	}
	.login__form {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}
	.login__label {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.login__label .fp-field {
		width: 100%;
	}
</style>
