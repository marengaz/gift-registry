<script lang="ts">
	import { onMount } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import type { Identity } from '#lib/catalogue-types.ts';
	import SignOut from './SignOut.svelte';
	let person = $state<Identity | null>(null);
	async function refreshIdentity() {
		try {
			const response = await fetch('/api/me', { cache: 'no-store' });
			person = response.ok ? await response.json() : null;
		} catch {
			person = null;
		}
	}
	afterNavigate(refreshIdentity);
	onMount(() => {
		const online = () => {
			void refreshIdentity();
		};
		window.addEventListener('online', online);
		return () => window.removeEventListener('online', online);
	});
	const canSeeCatalogue = $derived(person?.administrator || person?.collaborator);
	const contributes = $derived(
		person?.administrator ||
			person?.collaborator ||
			person?.buyer ||
			person?.canCapture ||
			person?.lists.some(
				(list) => !list.archivedAt && (list.role === 'contributor' || list.role === 'buyer')
			)
	);
</script>

<header class="site-header">
	<div class="header-inner">
		<a class="brand" href="/lists"><span aria-hidden="true">✦</span> Family gifts</a>
		{#if person?.member}<nav aria-label="Main navigation">
				<a class:active={page.url.pathname.startsWith('/lists')} href="/lists">Lists</a>
				<a class:active={page.url.pathname === '/my-gifts'} href="/my-gifts">My gifts</a>
				{#if canSeeCatalogue}<a class:active={page.url.pathname === '/catalogue'} href="/catalogue"
						>Catalogue</a
					>{/if}
				{#if contributes}<a class:active={page.url.pathname === '/inbox'} href="/inbox">Inbox</a><a
						class:active={page.url.pathname === '/capture'}
						href="/capture">Add idea</a
					>{/if}
				{#if person.administrator}<a
						class:active={page.url.pathname === '/settings/people'}
						href="/settings/people">People</a
					><a
						class:active={page.url.pathname === '/settings/identification'}
						href="/settings/identification">Identification</a
					><a
						class:active={page.url.pathname === '/settings/diagnostics'}
						href="/settings/diagnostics">Server checks</a
					>{/if}
			</nav>
			<div class="account"><span>{person.name}</span><SignOut /></div>
		{:else if person}<div class="account"><span>{person.name}</span><SignOut /></div>
		{:else}<a class="quiet" href="/login">Sign in</a>{/if}
	</div>
</header>
