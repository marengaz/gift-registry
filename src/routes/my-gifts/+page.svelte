<script lang="ts">
	import IdeaCollection from '#lib/components/IdeaCollection.svelte';
	import type { Product } from '#lib/catalogue-types.ts';
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
</script>

<svelte:head><title>My gifts · Family gifts</title></svelte:head>
<main>
	<div class="page-heading">
		<div>
			<p class="eyebrow">Buying progress</p>
			<h1>My gifts</h1>
			<p class="muted">Your reservations, assignments and purchases on active lists.</p>
		</div>
		<a class="button secondary" href="/lists">Browse lists</a>
	</div>
	<IdeaCollection
		products={data.products as Product[]}
		lists={data.lists}
		kind="mine"
		administrator={data.administrator}
	>
		<section class="empty-state">
			<h2>No gifts allocated to you yet</h2>
			<p class="muted">
				Reserve an available idea from a list, or ask the administrator about an assignment.
			</p>
			<a class="button" href="/lists">Browse lists</a>
		</section>
	</IdeaCollection>
</main>
