<script lang="ts">
	import ListTotals from '#lib/components/ListTotals.svelte';
	import IdeaCollection from '#lib/components/IdeaCollection.svelte';
	import ListLifecycle from '#lib/components/ListLifecycle.svelte';
	import type { GiftList, Product } from '#lib/catalogue-types.ts';
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
	const list = $derived(data.list as GiftList);
</script>

<svelte:head><title>{list.recipientName} · {list.name} · Family gifts</title></svelte:head>
<main>
	<a class="back-link" href="/lists">← All lists</a>
	{#snippet heading(controls?: {
		disabled: boolean;
		hide: (list: GiftList, trigger: HTMLElement) => void;
	})}
		<div class="page-heading">
			<div>
				<p class="eyebrow">
					{list.occasion ?? 'General ideas'}{list.archivedAt ? ' · Hidden' : ''}
				</p>
				<h1>{list.recipientName}</h1>
				<p class="muted">{list.name}</p>
			</div>
			<div class="heading-actions">
				{#if !list.archivedAt && ['administrator', 'contributor', 'buyer'].includes(list.role ?? '')}<a
						class="button"
						href={`/capture?list=${list.id}`}>+ Add an idea</a
					>{/if}{#if controls}<button
						class="secondary"
						disabled={controls.disabled}
						onclick={(event) => controls.hide(list, event.currentTarget)}
						>{list.archivedAt ? 'Show list' : 'Hide list'}</button
					>{/if}
			</div>
		</div>
	{/snippet}
	{#if data.administrator && data.administratorId}
		{#key data.administratorId}
			<ListLifecycle administratorId={data.administratorId}>
				{#snippet children(controls)}{@render heading(controls)}{/snippet}
			</ListLifecycle>
		{/key}
	{:else}{@render heading()}{/if}
	{#if list.archivedAt}<p class="notice">
			This list is hidden. Its ideas and buying history are kept here; relatives cannot browse it or
			add ideas. Show it again to restore their access.
		</p>{/if}
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
				{['administrator', 'contributor', 'buyer'].includes(list.role ?? '')
					? 'Found something they would love? Add a link, photo or a few notes.'
					: 'Ideas available to you will appear here.'}
			</p>
		</section>
	</IdeaCollection>
</main>
