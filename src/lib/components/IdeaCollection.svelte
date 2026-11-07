<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { page } from '$app/state';
	import ProductCard from './ProductCard.svelte';
	import { ideaRows, filterIdeas, type CollectionKind } from '#lib/idea-collection.ts';
	import type { GiftList, Product } from '#lib/catalogue-types.ts';
	let {
		products,
		lists,
		kind,
		listId,
		administrator = false,
		children
	}: {
		products: Product[];
		lists: GiftList[];
		kind: CollectionKind;
		listId?: string;
		administrator?: boolean;
		children?: Snippet;
	} = $props();
	let compact = $state(false);
	const preference = 'family-gifts-idea-view';
	onMount(() => {
		try {
			compact = localStorage.getItem(preference) === 'compact';
		} catch {}
	});
	function changeView(value: boolean) {
		compact = value;
		try {
			localStorage.setItem(preference, value ? 'compact' : 'cards');
		} catch {}
	}
	const query = $derived(page.url.searchParams);
	const rows = $derived(ideaRows(products, kind, listId));
	const visible = $derived(filterIdeas(rows, query, lists));
	const labels = $derived(
		[
			...new Map(
				products.flatMap((product) => product.labels).map((label) => [label.id, label])
			).values()
		].sort((a, b) => a.name.localeCompare(b.name, 'en-GB'))
	);
	const contributors = $derived([
		...new Map(
			products
				.filter((product) => product.contributorId && product.contributorName)
				.map((product) => [product.contributorId!, product.contributorName!])
		).entries()
	]);
	const selectableLists = $derived(
		lists.filter(
			(list) =>
				kind === 'catalogue' ||
				rows.some((row) =>
					row.entry
						? row.entry.listId === list.id
						: row.product.entries.some((entry) => entry.listId === list.id)
				)
		)
	);
	const moreActive = $derived(
		['list', 'label', 'max', 'detail', 'allocation', 'contributor', 'unlisted'].some((key) =>
			query.get(key)
		)
	);
	const filtered = $derived(moreActive || !!query.get('q') || !!query.get('status'));
</script>

<div class="collection-toolbar">
	<p class="muted" aria-live="polite">
		Showing {visible.length} of {rows.length}
	</p>
	<div class="view-toggle" role="group" aria-label="Idea display">
		<button type="button" aria-pressed={!compact} onclick={() => changeView(false)}>Cards</button>
		<button type="button" aria-pressed={compact} onclick={() => changeView(true)}
			>Compact list</button
		>
	</div>
</div>
<form class="collection-filters" method="GET">
	<div class="filters">
		<label
			>Search <input
				name="q"
				value={query.get('q') ?? ''}
				placeholder="Name, description, label or recipient"
			/></label
		>
		{#if kind !== 'inbox'}<label
				>Buying status <select
					aria-label="Buying status"
					name="status"
					value={query.get('status') ?? ''}
				>
					<option value="">All statuses</option>
					{#if kind !== 'mine'}<option value="available">Available to buy</option>{/if}
					<option value="allocated"
						>{kind === 'mine' ? 'Still to buy' : 'Reserved or assigned'}</option
					>
					<option value="purchased">Purchased</option>
				</select></label
			>{/if}
		<label
			>Sort by <select aria-label="Sort by" name="sort" value={query.get('sort') ?? ''}>
				<option value="">Recently added</option><option value="name">Name</option>
				<option value="price-low">Price: low to high</option><option value="price-high"
					>Price: high to low</option
				>
			</select></label
		>
	</div>
	<details open={moreActive} class="more-filters">
		<summary>More filters</summary>
		<div class="filters">
			{#if kind === 'catalogue' || kind === 'mine'}<label
					>Gift list <select
						aria-label="Gift list"
						name="list"
						value={query.get('unlisted') === '1' ? 'unlisted' : (query.get('list') ?? '')}
					>
						<option value="">All lists</option>{#if kind === 'catalogue'}<option value="unlisted"
								>Unlisted ideas</option
							>{/if}
						{#each selectableLists as list}<option value={list.id}
								>{list.recipientName} · {list.name}{list.occasion && list.occasion !== list.name
									? ` (${list.occasion})`
									: ''}{list.archivedAt ? ' (archived)' : ''}</option
							>{/each}
					</select></label
				>{/if}
			<label
				>Label <select aria-label="Label" name="label" value={query.get('label') ?? ''}>
					<option value="">All labels</option>{#each labels as label}<option value={label.id}
							>{label.name}</option
						>{/each}
				</select></label
			>
			{#if contributors.length}<label
					>Added by <select
						aria-label="Added by"
						name="contributor"
						value={query.get('contributor') ?? ''}
					>
						<option value="">Anyone</option>{#each contributors as [id, name]}<option value={id}
								>{name}</option
							>{/each}
					</select></label
				>{/if}
			{#if kind !== 'inbox'}<label
					>Maximum price (£) <input
						name="max"
						type="number"
						min="0"
						step="0.01"
						value={query.get('max') ?? ''}
						placeholder="Any price"
					/></label
				>{/if}
			{#if kind === 'mine'}<label
					>Allocation <select
						aria-label="Allocation"
						name="allocation"
						value={query.get('allocation') ?? ''}
					>
						<option value="">All gifts</option><option value="self">Reserved by me</option><option
							value="administrator">Assigned to me</option
						>
					</select></label
				>{:else}<label
					>Needs details <select
						aria-label="Needs details"
						name="detail"
						value={query.get('detail') ?? ''}
					>
						<option value="">All ideas</option><option value="photo">Missing a photo</option><option
							value="link">Missing a shopping link</option
						><option value="price">Price unknown</option>
					</select></label
				>{/if}
		</div>
		{#if kind !== 'inbox'}<p class="filter-hint">
				Budgets use GBP estimates. Ideas with unknown prices are excluded when a maximum is set.
			</p>{/if}
	</details>
	<div class="filter-actions">
		<button>Find ideas</button>{#if filtered}<a href={page.url.pathname}>Clear filters</a>{/if}
	</div>
</form>

{#if visible.length}
	<div class={compact ? 'product-rows' : 'product-grid'}>
		{#each visible as row (row.entry?.id ?? row.product.id)}<ProductCard
				product={row.product}
				{lists}
				listId={row.entry?.listId}
				buying={kind === 'list' || kind === 'mine'}
				{administrator}
				{compact}
			/>{/each}
	</div>
{:else if filtered}<section class="empty-state">
		<h2>No matching ideas</h2>
		<p class="muted">Try another search or loosen a filter.</p>
	</section>
{:else}{@render children?.()}{/if}

<style>
	.collection-toolbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
		margin: 1rem 0;
	}
	.collection-toolbar p {
		margin: 0;
		font-size: 0.85rem;
	}
	.view-toggle {
		display: flex;
		gap: 0.2rem;
		padding: 0.2rem;
		border: 1px solid var(--line);
		border-radius: 0.7rem;
		background: var(--paper);
	}
	.view-toggle button {
		background: transparent;
		color: var(--ink);
		border-color: transparent;
		padding: 0.4rem 0.7rem;
		font-size: 0.85rem;
	}
	.view-toggle button[aria-pressed='true'] {
		background: var(--ink);
		color: white;
	}
	.collection-filters {
		border-bottom: 1px solid var(--line);
		margin-bottom: 1.25rem;
		padding-bottom: 1.25rem;
	}
	.filters {
		margin-bottom: 0.7rem;
	}
	.more-filters {
		margin-bottom: 0.7rem;
	}
	summary {
		font-size: 0.85rem;
	}
	.filter-hint {
		color: var(--muted);
		font-size: 0.8rem;
		margin: 0.5rem 0;
	}
	.filter-actions {
		display: flex;
		align-items: center;
		gap: 1rem;
		font-size: 0.9rem;
	}
	.product-rows {
		display: grid;
		gap: 0.6rem;
	}
	@media (max-width: 600px) {
		.collection-filters > .filters {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.collection-filters > .filters > label {
			min-width: 0;
		}
		.collection-filters > .filters > label:first-child {
			grid-column: 1 / -1;
		}
	}
</style>
