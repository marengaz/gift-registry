<script lang="ts">
	import ProductCard from '#lib/components/ProductCard.svelte';
	import type { Product } from '#lib/catalogue-types.ts';
	import { page } from '$app/state';
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
</script>

<svelte:head><title>Catalogue · Family gifts</title></svelte:head>
<main>
	<div class="page-heading">
		<div>
			<p class="eyebrow">The complete collection</p>
			<h1>Catalogue</h1>
			<p class="muted">Find an idea, check its lists and keep the details useful.</p>
		</div>
		<a class="button" href="/capture">+ Add an idea</a>
	</div>
	<form class="filters" method="GET">
		<label
			>Search <input
				name="q"
				value={page.url.searchParams.get('q') ?? ''}
				placeholder="Search a name or label"
			/></label
		><label
			>Label <select name="label" value={page.url.searchParams.get('label') ?? ''}
				><option value="">All labels</option>{#each data.labels as label}<option value={label.id}
						>{label.name}</option
					>{/each}</select
			></label
		><label class="check-label"
			><input
				type="checkbox"
				name="unlisted"
				value="1"
				checked={page.url.searchParams.get('unlisted') === '1'}
			/> Unlisted only</label
		><button>Find ideas</button>
	</form>
	{#if data.products.length}<p class="muted">
			<small>{data.products.length} {data.products.length === 1 ? 'idea' : 'ideas'}</small>
		</p>
		<div class="product-grid">
			{#each data.products as product}<ProductCard
					product={product as Product}
					lists={data.lists}
				/>{/each}
		</div>{:else}<section class="empty-state">
			<div class="empty-symbol" aria-hidden="true">✧</div>
			<h2>{page.url.search ? 'No matching ideas' : 'Your collection starts here'}</h2>
			<p class="muted">
				{page.url.search
					? 'Try another name, label or filter.'
					: 'Save a photo, shopping link or a quick note. You can organise it into lists whenever you are ready.'}
			</p>
			<a class="button secondary" href={page.url.search ? '/catalogue' : '/capture'}
				>{page.url.search ? 'Clear filters' : 'Add the first idea'}</a
			>
		</section>{/if}
</main>
