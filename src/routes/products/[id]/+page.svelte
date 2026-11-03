<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import CaptureEditor from '#lib/components/CaptureEditor.svelte';
	import {
		draftFromProduct,
		emptyDraft,
		capturePayload,
		money,
		formatPrice,
		type Product
	} from '#lib/catalogue-types.ts';
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
	const product = $derived(data.product as Product);
	let editing = $state(false);
	let draft = $state(emptyDraft());
	let busy = $state(false);
	let message = $state('');
	async function save() {
		busy = true;
		message = '';
		try {
			const response = await fetch(`/api/products/${product.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(capturePayload(draft))
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.message);
			editing = false;
			message = 'Changes saved.';
			await invalidateAll();
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'The changes could not be saved. Your edits are still here.';
		} finally {
			busy = false;
		}
	}
	function edit() {
		draft = draftFromProduct(product);
		editing = true;
		message = '';
	}
</script>

<svelte:head><title>{product.title} · Family gifts</title></svelte:head>
<main class:narrow={editing}>
	<a
		class="back-link"
		href={data.administrator
			? '/catalogue'
			: product.entries[0]
				? `/lists/${product.entries[0].listId}`
				: '/inbox'}
		>← {data.administrator
			? 'Catalogue'
			: product.entries[0]
				? 'Back to list'
				: 'Unlisted inbox'}</a
	>
	<div class="page-heading">
		<div>
			<p class="eyebrow">{product.entries.length ? 'A little inspiration' : 'Unlisted idea'}</p>
			<h1>{product.title}</h1>
			{#if product.variant}<p class="muted">
					{product.variant}
				</p>{/if}{#if product.contributorName}<p class="muted">
					<small>Added by {product.contributorName}</small>
				</p>{/if}
		</div>
		{#if data.administrator}<button
				class="secondary"
				onclick={() => (editing ? (editing = false) : edit())}
				>{editing ? 'Cancel editing' : 'Edit idea'}</button
			>{/if}
	</div>
	{#if message}<p class:notice={true} class:error={editing} role="status">{message}</p>{/if}
	{#if editing}<CaptureEditor
			bind:draft
			lists={data.lists}
			{busy}
			editing
			onSave={save}
		/>{:else}<div class="details-grid">
			<div class="photo-gallery">
				{#each product.media as image}<a href={`/api/media/${image.id}?original=1`}
						><img src={`/api/media/${image.id}`} alt={product.title} /></a
					>{:else}<div class="empty-state">
						<div class="empty-symbol" aria-hidden="true">✧</div>
						<p class="muted">An idea is all you need.</p>
					</div>{/each}
			</div>
			<div>
				<section class="panel">
					<h2>The details</h2>
					{#if product.description}<p class="source-text">{product.description}</p>{:else}<p
							class="muted"
						>
							No description added yet.
						</p>{/if}
					<div class="badges">
						{#each product.labels as label}<span class="badge">{label.name}</span>{/each}
					</div>
				</section>
				<section class="panel">
					<h2>On these lists</h2>
					{#each product.entries as entry}{@const list = data.lists.find(
							(item: { id: string }) => item.id === entry.listId
						)}{#if list}<p>
								<a href={`/lists/${list.id}`}>{list.recipientName} · {list.name}</a><br /><small
									>{list.occasion ?? 'General ideas'}{list.archivedAt ? ' · Archived' : ''} · {money(
										entry.estimatePence
									)}</small
								>
							</p>{/if}{:else}<p class="muted">
							Kept in the unlisted inbox. The administrator can add this to a list.
						</p>{/each}
				</section>
				{#if product.offers.length}<section class="panel">
						<h2>Shopping links</h2>
						<ul class="link-list">
							{#each product.offers as offer}<li>
									<a href={offer.url} target="_blank" rel="noopener noreferrer"
										>{offer.retailer || new URL(offer.url).hostname} ↗</a
									>{#if offer.priceMinor != null}<small
											>{formatPrice(offer.priceMinor, offer.currency ?? 'GBP')} · noted {new Date(
												offer.observedAt
											).toLocaleDateString('en-GB')}</small
										>{/if}
								</li>{/each}
						</ul>
					</section>{/if}
				{#if product.sourceUrl || product.sourceText}<section class="panel">
						<h2>Original source</h2>
						{#if product.sourceUrl}<p>
								<a href={product.sourceUrl} target="_blank" rel="noopener noreferrer"
									>Open source link ↗</a
								>
							</p>{/if}{#if product.sourceText}<p class="source-text">{product.sourceText}</p>{/if}
					</section>{/if}
			</div>
		</div>{/if}
</main>
