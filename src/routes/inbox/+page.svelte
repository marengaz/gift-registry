<script lang="ts">
	import IdeaCollection from '#lib/components/IdeaCollection.svelte';
	import type { Product } from '#lib/catalogue-types.ts';
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
</script>

<svelte:head><title>Unlisted inbox · Family gifts</title></svelte:head>
<main>
	<div class="page-heading">
		<div>
			<p class="eyebrow">Keep it for later</p>
			<h1>Unlisted inbox</h1>
			<p class="muted">
				Ideas without a list. They are visible to their author, collaborators and administrators.
			</p>
		</div>
		<a class="button" href="/capture">+ Add an idea</a>
	</div>
	<IdeaCollection products={data.products as Product[]} lists={data.lists} kind="inbox">
		<section class="empty-state">
			<div class="empty-symbol" aria-hidden="true">✧</div>
			<h2>A place for sparks of inspiration</h2>
			<p class="muted">
				Save an idea without choosing a list. You or a collaborator can organise it later.
			</p>
			<a class="button secondary" href="/capture">Add an unlisted idea</a>
		</section>
	</IdeaCollection>
</main>
