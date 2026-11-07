<script lang="ts">
	import GiftActions from './GiftActions.svelte';
	import { money, type Product, type GiftList } from '#lib/catalogue-types.ts';
	import { ideaPriceLabel } from '#lib/idea-collection.ts';
	let {
		product,
		lists,
		listId,
		buying = false,
		administrator = false,
		compact = false
	}: {
		product: Product;
		lists: GiftList[];
		listId?: string;
		buying?: boolean;
		administrator?: boolean;
		compact?: boolean;
	} = $props();
	const entry = $derived(product.entries.find((e) => e.listId === listId));
	const memberships = $derived(compact && entry ? [entry] : product.entries);
</script>

<article class="product-card" class:compact>
	<a class="card-photo" href={`/products/${product.id}`} aria-label={`Open ${product.title}`}>
		{#if product.media[0]}<img
				src={`/api/media/${product.media[0].id}`}
				alt={product.title}
				loading="lazy"
			/>{:else}<span class="photo-placeholder" aria-hidden="true">✧</span>{/if}
	</a>
	<div class="card-body">
		<a class="card-title" href={`/products/${product.id}`}><h2>{product.title}</h2></a>
		{#if product.variant}<p class="muted card-variant">{product.variant}</p>{/if}
		{#if entry || compact}<p class="price">
				{entry ? money(entry.estimatePence) : ideaPriceLabel({ product })}
			</p>{/if}
		{#if product.description}<p class="card-description">{product.description}</p>{/if}
		<div class="badges">
			{#each product.labels as label}<span class="badge">{label.name}</span>{/each}
		</div>
		<div class="memberships">
			{#each memberships as membership}{@const list = lists.find(
					(l) => l.id === membership.listId
				)}{#if list}<a href={`/lists/${list.id}`}>{list.recipientName} · {list.name}</a
					>{/if}{:else}<span class="muted">Unlisted idea</span>{/each}
		</div>
		{#if product.contributorName}<p class="attribution">Added by {product.contributorName}</p>{/if}
		{#if buying && entry}{#key entry.id}<GiftActions
					{entry}
					{compact}
					{administrator}
					role={lists.find((list) => list.id === listId)?.role}
					archived={!!lists.find((list) => list.id === listId)?.archivedAt}
				/>{/key}{/if}
	</div>
</article>

<style>
	.compact {
		display: grid;
		grid-template-columns: 80px minmax(0, 1fr);
		border-radius: 0.7rem;
	}
	.compact .card-photo {
		aspect-ratio: 1;
		min-height: 0;
		height: 80px;
		margin: 0.7rem 0 0.7rem 0.7rem;
		border-radius: 0.4rem;
	}
	.compact .card-photo img {
		max-height: 80px;
		border-radius: 0.4rem;
	}
	.compact .photo-placeholder {
		font-size: 2rem;
	}
	.compact .card-body {
		padding: 0.7rem 1rem;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0.2rem 1rem;
		align-content: start;
	}
	.compact .card-title {
		grid-column: 1;
		grid-row: 1;
		overflow-wrap: anywhere;
	}
	.compact .card-title h2 {
		font-size: 1rem;
		margin: 0;
	}
	.compact .price {
		grid-column: 2;
		grid-row: 1;
		margin: 0;
		font-size: 0.9rem;
	}
	.compact .card-variant {
		font-size: 0.8rem;
		margin: 0;
		grid-column: 1;
	}
	.compact .card-description,
	.compact .badges {
		display: none;
	}
	.compact .memberships,
	.compact .attribution {
		grid-column: 1;
		margin: 0;
	}
	.compact :global(.gift-actions) {
		grid-column: 2;
		grid-row: 2 / span 4;
		margin: 0;
		padding: 0;
		border: 0;
		max-width: 17rem;
	}
	@media (max-width: 600px) {
		.compact {
			grid-template-columns: 64px minmax(0, 1fr);
		}
		.compact .card-photo {
			height: 64px;
		}
		.compact .card-photo img {
			max-height: 64px;
		}
		.compact .card-body {
			display: block;
			padding: 0.65rem 0.85rem;
		}
		.compact .price,
		.compact .memberships {
			margin-top: 0.2rem;
		}
		.compact :global(.gift-actions) {
			margin-top: 0.4rem;
			max-width: none;
		}
	}
</style>
