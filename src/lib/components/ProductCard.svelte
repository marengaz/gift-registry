<script lang="ts">
	import { money, type Product, type GiftList } from '#lib/catalogue-types.ts';
	let { product, lists, listId }: { product: Product; lists: GiftList[]; listId?: string } =
		$props();
	const entry = $derived(product.entries.find((e) => e.listId === listId));
</script>

<article class="product-card">
	<a class="card-photo" href={`/products/${product.id}`} aria-label={`Open ${product.title}`}>
		{#if product.media[0]}<img
				src={`/api/media/${product.media[0].id}`}
				alt={product.title}
				loading="lazy"
			/>{:else}<span class="photo-placeholder" aria-hidden="true">✧</span>{/if}
	</a>
	<div class="card-body">
		<a class="card-title" href={`/products/${product.id}`}><h2>{product.title}</h2></a>
		{#if product.variant}<p class="muted">{product.variant}</p>{/if}
		{#if entry}<p class="price">{money(entry.estimatePence)}</p>{/if}
		{#if product.description}<p class="card-description">{product.description}</p>{/if}
		<div class="badges">
			{#each product.labels as label}<span class="badge">{label.name}</span>{/each}
		</div>
		<div class="memberships">
			{#each product.entries as membership}{@const list = lists.find(
					(l) => l.id === membership.listId
				)}{#if list}<a href={`/lists/${list.id}`}>{list.recipientName} · {list.name}</a
					>{/if}{:else}<span class="muted">Unlisted idea</span>{/each}
		</div>
		{#if product.contributorName}<p class="attribution">Added by {product.contributorName}</p>{/if}
	</div>
</article>
