<script lang="ts">
	import IdeaCollection from '#lib/components/IdeaCollection.svelte';
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
	<IdeaCollection products={data.products as Product[]} lists={data.lists} kind="catalogue">
		<section class="empty-state">
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
		</section>
	</IdeaCollection>
</main>
