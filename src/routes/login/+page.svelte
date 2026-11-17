<script lang="ts">
	import { authClient } from '#lib/client/auth.ts';
	import { page } from '$app/state';
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
	let message = $state('');
	let busy = $state(false);
	async function signIn() {
		busy = true;
		message = '';
		const requested = page.url.searchParams.get('next');
		const next =
			requested?.startsWith('/invite/') && /^\/invite\/[A-Za-z0-9_-]+$/.test(requested)
				? requested
				: '/';
		const result = await authClient.signIn.social({
			provider: 'google',
			callbackURL: next,
			errorCallbackURL: '/login?error=sign-in'
		});
		if (result.error) {
			message = 'Google sign-in could not be started. Please try again.';
			busy = false;
		}
	}
</script>

<svelte:head><title>Sign in · Family gifts</title></svelte:head>
<main>
	<h1>Family gifts</h1>
	{#if !data.setup.ready}
		<h2>Sign-in setup needed</h2>
		<p>The household administrator needs to configure Google sign-in before you can continue.</p>
		<p>Missing settings: {data.setup.missing.join(', ')}.</p>
	{:else if data.person}
		<p>Signed in as {data.person.email}.</p>
		{#if data.person.member}<a href="/">Open family gifts</a>{:else}<p>
				You are signed in as a guest. Ask an administrator to grant your permissions or open an
				invitation link sent to this Google email.
			</p>{/if}
	{:else}
		<p>A family invitation is needed. Use the Google account named in your invitation.</p>
		<button onclick={signIn} disabled={busy}
			>{busy ? 'Opening Google…' : 'Continue with Google'}</button
		>
	{/if}
	{#if page.url.searchParams.has('error')}<p role="alert">
			Sign-in was cancelled or could not be completed. Please try again.
		</p>{/if}
	{#if message}<p role="alert">{message}</p>{/if}
</main>

<style>
	main {
		max-width: 40rem;
		margin: 3rem auto;
		padding: 1rem;
	}
	button {
		font: inherit;
		padding: 0.8rem 1rem;
	}
	p {
		line-height: 1.5;
		overflow-wrap: anywhere;
	}
</style>
