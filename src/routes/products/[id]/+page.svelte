<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import CaptureEditor from '#lib/components/CaptureEditor.svelte';
	import ProductSuggestions from '#lib/components/ProductSuggestions.svelte';
	import PhotoShoppingLinks from '#lib/components/PhotoShoppingLinks.svelte';
	import {
		draftFromProduct,
		emptyDraft,
		capturePayload,
		money,
		type Product
	} from '#lib/catalogue-types.ts';
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
	const product = $derived(data.product as Product);
	const lockedListIds = $derived(
		data.administrator || data.collaborator
			? []
			: product.entries
					.filter((entry) => {
						const role = data.lists.find((item: { id: string }) => item.id === entry.listId)?.role;
						return role !== 'administrator' && role !== 'contributor';
					})
					.map((entry) => entry.listId)
	);
	let editing = $state(false);
	let draft = $state(emptyDraft());
	let busy = $state(false);
	let message = $state('');
	async function removeFromList(listId: string, entryId: string) {
		busy = true;
		message = '';
		try {
			const response = await fetch(`/api/lists/${listId}/entries/${entryId}`, {
				method: 'DELETE'
			});
			const result = await response.json();
			if (!response.ok)
				throw new Error(result.message ?? 'Could not remove this idea from the list.');
			message = 'Removed from list.';
			await invalidateAll();
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Could not remove this idea from the list.';
		} finally {
			busy = false;
		}
	}
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
		href={data.administrator || data.collaborator
			? '/catalogue'
			: product.entries[0]
				? `/lists/${product.entries[0].listId}`
				: '/inbox'}
		>← {data.administrator || data.collaborator
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
		{#if data.canEdit}<button
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
			{lockedListIds}
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
						)}{#if list}<p class="list-membership">
								<span
									><a href={`/lists/${list.id}`}>{list.recipientName} · {list.name}</a><br /><small
										>{list.occasion ?? 'General ideas'}{list.archivedAt ? ' · Hidden' : ''} · {money(
											entry.estimatePence
										)}</small
									></span
								>{#if !list.archivedAt && entry.state === 'available' && (data.administrator || data.collaborator || list.role === 'contributor')}<button
										type="button"
										class="secondary compact"
										disabled={busy}
										onclick={() => removeFromList(list.id, entry.id)}>Remove from list</button
									>{/if}
							</p>{/if}{:else}<p class="muted">
							Kept in the unlisted inbox. You or a collaborator can add this to a list later.
						</p>{/each}
				</section>
				{#key product.id}<PhotoShoppingLinks {product} administrator={data.administrator} />{/key}
				<ProductSuggestions {product} administrator={data.administrator} />
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
