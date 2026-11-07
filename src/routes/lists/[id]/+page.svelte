<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import ListTotals from '#lib/components/ListTotals.svelte';
	import IdeaCollection from '#lib/components/IdeaCollection.svelte';
	import type { GiftList, Product } from '#lib/catalogue-types.ts';
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
	let message = $state('');
	let busy = $state(false);
	const list = $derived(data.list as GiftList);
	async function archive() {
		busy = true;
		try {
			const response = await fetch(`/api/lists/${list.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ archived: !list.archivedAt })
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.message);
			await invalidateAll();
		} catch (error) {
			message = error instanceof Error ? error.message : 'The list could not be updated.';
		} finally {
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
				{list.occasion ?? 'General ideas'}{list.archivedAt ? ' · Archived' : ''}
			</p>
			<h1>{list.recipientName}</h1>
			<p class="muted">{list.name}</p>
		</div>
		<div class="heading-actions">
			{#if !list.archivedAt && ['administrator', 'contributor'].includes(list.role ?? '')}<a
					class="button"
					href={`/capture?list=${list.id}`}>+ Add an idea</a
				>{/if}{#if data.administrator}<button class="secondary" disabled={busy} onclick={archive}
					>{list.archivedAt ? 'Restore list' : 'Archive list'}</button
				>{/if}
		</div>
	</div>
	{#if list.archivedAt}<p class="notice">
			This list is archived. Its history is kept here; relatives cannot browse it or add ideas.
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
