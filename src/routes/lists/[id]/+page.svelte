<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import ListTotals from '#lib/components/ListTotals.svelte';
	import IdeaCollection from '#lib/components/IdeaCollection.svelte';
	import type { GiftList, Product } from '#lib/catalogue-types.ts';
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
	let message = $state('');
	let busy = $state(false);
	let pendingArchived = $state<boolean | null>(null);
	const list = $derived(data.list as GiftList);
	async function archive() {
		if (busy) return;
		if (pendingArchived === null) pendingArchived = !Boolean(list.archivedAt);
		const desired = pendingArchived;
		busy = true;
		message = '';
		const controller = new AbortController();
		let timeout: ReturnType<typeof setTimeout>;
		try {
			const { response, result } = await Promise.race([
				(async () => {
					const response = await fetch(`/api/lists/${encodeURIComponent(list.id)}`, {
						method: 'PATCH',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ archived: desired }),
						signal: controller.signal
					});
					const result = await response.json();
					return { response, result };
				})(),
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => {
						controller.abort();
						reject(new Error('timeout'));
					}, 12_000);
				})
			]);
			if (!response.ok || result?.ok !== true) throw new Error('unconfirmed');
			pendingArchived = null;
			try {
				await invalidateAll();
			} catch {
				message = 'List change confirmed. Refresh the page to load it.';
			}
		} catch {
			message = `The ${desired ? 'Hide' : 'Show'} request has not been confirmed. Retry the same change to check its result, or return to All lists to review the current list.`;
		} finally {
			clearTimeout(timeout!);
			busy = false;
		}
	}
</script>

<svelte:head><title>{list.recipientName} · {list.name} · Family gifts</title></svelte:head>
<main>
	<a class="back-link" href="/lists">← All lists</a>
	<div class="page-heading">
		<div>
			<p class="eyebrow">
				{list.occasion ?? 'General ideas'}{list.archivedAt ? ' · Hidden' : ''}
			</p>
			<h1>{list.recipientName}</h1>
			<p class="muted">{list.name}</p>
		</div>
		<div class="heading-actions">
			{#if !list.archivedAt && ['administrator', 'contributor'].includes(list.role ?? '')}<a
					class="button"
					href={`/capture?list=${list.id}`}>+ Add an idea</a
				>{/if}{#if data.administrator}<button class="secondary" disabled={busy} onclick={archive}
					>{pendingArchived !== null
						? `Retry ${pendingArchived ? 'Hide' : 'Show'} request`
						: list.archivedAt
							? 'Show list'
							: 'Hide list'}</button
				>{/if}
		</div>
	</div>
	{#if list.archivedAt}<p class="notice">
			This list is hidden. Its ideas and buying history are kept here; relatives cannot browse it or
			add ideas. Show it again to restore their access.
		</p>{/if}
	{#if message}<p class="notice error" role="alert">{message}</p>{/if}
	{#if data.totals}<ListTotals totals={data.totals} />{/if}
	<div class="section-heading"><h2>Ideas on this list</h2></div>
	<IdeaCollection
		products={data.products as Product[]}
		lists={data.lists}
		kind="list"
		listId={list.id}
		administrator={data.administrator}
	>
		<section class="empty-state">
			<div class="empty-symbol" aria-hidden="true">✧</div>
			<h2>No ideas to show yet</h2>
			<p class="muted">
				{['administrator', 'contributor'].includes(list.role ?? '')
					? 'Found something they would love? Add a link, photo or a few notes.'
					: 'Ideas available to you will appear here.'}
			</p>
		</section>
	</IdeaCollection>
</main>
