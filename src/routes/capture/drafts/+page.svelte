<script lang="ts">
	import { onMount } from 'svelte';
	import { liveQuery } from 'dexie';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import DraftPreview from '#lib/components/DraftPreview.svelte';
	import { captureTitle, formatPrice, parsePriceMinor } from '#lib/catalogue-types.ts';
	import {
		canPersonCapture,
		draftStore,
		type CaptureContext,
		type LocalDraft
	} from '#lib/client/drafts.ts';
	import { refreshCaptureIdentity, syncDrafts } from '#lib/client/sync.ts';

	let context = $state<CaptureContext | undefined>();
	let records = $state<LocalDraft[]>([]);
	let imports = $state<LocalDraft[]>([]);
	let loading = $state(true);
	let busy = $state(false);
	let message = $state('');
	let error = $state('');
	let searchQuery = $state('');
	let selectedIds = $state<string[]>([]);
	let targetListIds = $state<string[]>([]);

	const importedCountParam = $derived(page.url.searchParams.get('imported'));
	const skippedCountParam = $derived(page.url.searchParams.get('skipped'));
	const importedListTitle = $derived(page.url.searchParams.get('listTitle'));

	const activeDrafts = $derived(
		[...records, ...imports].filter((record) => record.status !== 'saved')
	);

	const visibleDrafts = $derived.by(() => {
		const q = searchQuery.trim().toLocaleLowerCase('en-GB');
		if (!q) return activeDrafts;
		return activeDrafts.filter((record) => {
			const hay = [
				captureTitle(record.draft),
				record.draft.description,
				record.draft.variant,
				record.draft.sourceUrl,
				record.draft.sourceText,
				...record.draft.offers.map((offer) => offer.retailer)
			]
				.filter(Boolean)
				.join(' ')
				.toLocaleLowerCase('en-GB');
			return hay.includes(q);
		});
	});

	const selectableDrafts = $derived(
		visibleDrafts.filter((record) => (record.leaseUntil ?? 0) <= Date.now())
	);

	const allSelected = $derived(
		selectableDrafts.length > 0 &&
			selectableDrafts.every((record) => selectedIds.includes(record.id))
	);

	const availableLists = $derived(
		(context?.lists ?? []).filter(
			(list) =>
				!list.archivedAt && ['administrator', 'contributor', 'buyer'].includes(list.role ?? '')
		)
	);

	function draftPriceLabel(record: LocalDraft): string {
		if (record.draft.estimate.trim()) {
			try {
				const minor = parsePriceMinor(record.draft.estimate, 'GBP');
				if (minor !== null) return formatPrice(minor, 'GBP');
			} catch {}
		}
		for (const offer of record.draft.offers) {
			if (offer.price.trim() && offer.currency.trim()) {
				try {
					const minor = parsePriceMinor(offer.price, offer.currency);
					if (minor !== null) return formatPrice(minor, offer.currency);
				} catch {}
			}
		}
		return 'Price unknown';
	}

	function statusLabel(record: LocalDraft): string {
		if (record.readyToSync === false && !record.attemptedAt) return 'Local draft';
		return {
			local: 'Waiting to send',
			queued: 'Waiting to send',
			syncing: 'Sending…',
			saved: 'Saved to catalogue',
			needsattention: 'Needs attention'
		}[record.status];
	}

	function toggleSelection(id: string) {
		if (busy) return;
		selectedIds = selectedIds.includes(id)
			? selectedIds.filter((item) => item !== id)
			: [...selectedIds, id];
	}

	function toggleSelectAll() {
		if (busy) return;
		if (allSelected) {
			const visibleSet = new Set(selectableDrafts.map((record) => record.id));
			selectedIds = selectedIds.filter((id) => !visibleSet.has(id));
		} else {
			const next = new Set(selectedIds);
			for (const record of selectableDrafts) next.add(record.id);
			selectedIds = [...next];
		}
	}

	async function pruneDraft(record: LocalDraft) {
		if (busy) return;
		error = '';
		message = '';
		try {
			await draftStore.discard(record.ownerId, record.id);
			selectedIds = selectedIds.filter((id) => id !== record.id);
			message = `Pruned “${captureTitle(record.draft)}” from local drafts.`;
		} catch (reason) {
			error =
				reason instanceof Error
					? reason.message
					: 'This draft could not be pruned while synchronisation is running.';
		}
	}

	async function pruneSelected() {
		if (busy || !selectedIds.length) return;
		busy = true;
		error = '';
		message = '';
		try {
			const targets = activeDrafts.filter((record) => selectedIds.includes(record.id));
			for (const record of targets) {
				await draftStore.discard(record.ownerId, record.id);
			}
			const count = targets.length;
			selectedIds = [];
			message = `Pruned ${count} ${count === 1 ? 'draft idea' : 'draft ideas'} from local storage.`;
		} catch (reason) {
			error =
				reason instanceof Error ? reason.message : 'Some selected drafts could not be removed.';
		} finally {
			busy = false;
		}
	}

	async function commitDrafts(targets: LocalDraft[]) {
		if (busy || !targets.length) return;
		busy = true;
		error = '';
		message = '';
		try {
			let person = null;
			if (navigator.onLine) {
				person = await refreshCaptureIdentity();
				if (!person || !canPersonCapture(person)) {
					throw new Error(
						'Sign in with contributor permission to add these ideas to the catalogue.'
					);
				}
			}
			const ownerId = person?.id ?? context?.ownerId ?? null;
			if (!ownerId) {
				throw new Error(
					'Sign in with contributor permission before adding ideas to the catalogue.'
				);
			}

			for (const record of targets) {
				let currentRecord = record;
				if (!currentRecord.ownerId && person) {
					currentRecord = await draftStore.adopt(currentRecord.id, person);
				}
				if (currentRecord.ownerId !== ownerId) continue;
				if (currentRecord.attemptedAt || currentRecord.status === 'saved') continue;

				const files = await draftStore.files(currentRecord.id, currentRecord.ownerId);
				const updatedDraft = JSON.parse(JSON.stringify(currentRecord.draft));
				if (updatedDraft.browserCapture) updatedDraft.browserCapture.pendingReview = false;
				if (targetListIds.length > 0) {
					updatedDraft.listIds = [...new Set([...(updatedDraft.listIds ?? []), ...targetListIds])];
				}
				await draftStore.save({
					id: currentRecord.id,
					ownerId,
					draft: updatedDraft,
					photos: files,
					submit: true,
					incomingShare: false
				});
			}

			if (navigator.onLine) {
				message = `Adding ${targets.length} ${targets.length === 1 ? 'idea' : 'ideas'} to the catalogue…`;
				await syncDrafts(draftStore, fetch, ownerId);
			}

			try {
				localStorage.setItem('family-gifts-idea-view', 'compact');
			} catch {}

			const remaining = (await draftStore.list(ownerId)).filter(
				(record) => record.status !== 'saved'
			);
			const failed = remaining.filter((record) => record.status === 'needsattention');
			if (failed.length > 0) {
				error = `${failed.length} ${failed.length === 1 ? 'idea needs' : 'ideas need'} attention before saving.`;
				selectedIds = [];
			} else if (remaining.length === 0) {
				await goto('/catalogue');
			} else {
				selectedIds = [];
				message = `Added ${targets.length} ${targets.length === 1 ? 'idea' : 'ideas'} to the catalogue.`;
			}
		} catch (reason) {
			error =
				reason instanceof Error
					? reason.message
					: 'The ideas could not be added to the catalogue. Your local drafts are safe.';
		} finally {
			busy = false;
		}
	}

	onMount(() => {
		const subscription = liveQuery(async () => {
			const active = await draftStore.current();
			return {
				active,
				own: active ? await draftStore.list(active.ownerId) : [],
				unbound: await draftStore.list(null)
			};
		}).subscribe({
			next(value) {
				context = value.active;
				records = value.own;
				imports = value.unbound;
				const activeSet = new Set(
					[...value.own, ...value.unbound]
						.filter((record) => record.status !== 'saved')
						.map((record) => record.id)
				);
				selectedIds = selectedIds.filter((id) => activeSet.has(id));
				loading = false;
			},
			error() {
				error = 'Local storage could not be opened on this device.';
				loading = false;
			}
		});
		if (navigator.onLine) {
			void refreshCaptureIdentity().catch(() => {});
		}
		return () => {
			subscription.unsubscribe();
		};
	});
</script>

<svelte:head><title>Review local drafts · Family gifts</title></svelte:head>
<main>
	<div class="page-heading">
		<div>
			<p class="eyebrow">Local storage drafts</p>
			<h1>Review &amp; prune draft ideas</h1>
			<p class="muted">
				Prune away any items you do not want in the family catalogue, then add the remaining ideas.
			</p>
		</div>
		<div class="heading-actions">
			<a class="button secondary" href="/catalogue">Back to catalogue</a>
			<a class="button secondary" href="/capture">+ Add a single idea</a>
		</div>
	</div>

	{#if importedCountParam !== null}
		<div class="notice import-summary" role="status">
			<p>
				{#if Number(importedCountParam) > 0}
					Imported <strong>{importedCountParam}</strong>
					{Number(importedCountParam) === 1
						? 'new draft idea'
						: 'new draft ideas'}{#if importedListTitle}{' '}from
						<strong>{importedListTitle}</strong>{/if} into local storage.
				{:else}
					No new items were imported{#if importedListTitle}{' '}from
						<strong>{importedListTitle}</strong>{/if}.
				{/if}
				{#if Number(skippedCountParam) > 0}
					Skipped <strong>{skippedCountParam}</strong>
					{Number(skippedCountParam) === 1 ? 'duplicate item' : 'duplicate items'} already in your local
					drafts or catalogue.
				{/if}
			</p>
		</div>
	{/if}

	{#if message}<p class="notice" role="status">{message}</p>{/if}
	{#if error}<p class="notice error" role="alert">{error}</p>{/if}

	{#if loading}
		<p role="status">Loading local storage drafts…</p>
	{:else if activeDrafts.length === 0}
		<section class="empty-state">
			<div class="empty-symbol" aria-hidden="true">✧</div>
			<h2>No local draft ideas to review</h2>
			<p class="muted">
				All draft ideas on this device have been pruned or added to the catalogue.
			</p>
			<div class="empty-actions">
				<a class="button" href="/catalogue">Go to catalogue</a>
				<a class="button secondary" href="/capture">Add an idea</a>
			</div>
		</section>
	{:else}
		<section class="panel commit-panel" aria-label="Save kept drafts to catalogue">
			<div class="commit-header">
				<div>
					<h2>
						Ready to add to catalogue ({activeDrafts.length}
						{activeDrafts.length === 1 ? 'draft' : 'drafts'} kept)
					</h2>
					<p class="muted">
						Remove any unwanted items below first, or select specific items to prune or add.
					</p>
				</div>
				<div class="commit-buttons">
					{#if selectedIds.length > 0}
						<button
							type="button"
							disabled={busy}
							onclick={() =>
								commitDrafts(activeDrafts.filter((record) => selectedIds.includes(record.id)))}
						>
							{busy
								? 'Adding…'
								: `Add ${selectedIds.length} selected ${selectedIds.length === 1 ? 'idea' : 'ideas'} to catalogue`}
						</button>
					{/if}
					<button
						type="button"
						class:secondary={selectedIds.length > 0}
						disabled={busy}
						onclick={() => commitDrafts(activeDrafts)}
					>
						{busy
							? 'Adding…'
							: `Add all ${activeDrafts.length} kept ${activeDrafts.length === 1 ? 'idea' : 'ideas'} to catalogue`}
					</button>
				</div>
			</div>
			{#if availableLists.length > 0}
				<details class="list-assign-details">
					<summary>
						Optional: assign to gift lists when adding ({targetListIds.length
							? `${targetListIds.length} selected`
							: 'Unlisted / Catalogue'})
					</summary>
					<div class="list-choices">
						{#each availableLists as list (list.id)}
							<label class="check-label">
								<input type="checkbox" value={list.id} disabled={busy} bind:group={targetListIds} />
								<span>
									<strong>{list.recipientName}</strong> · {list.name}
									{#if list.occasion}<small>{list.occasion}</small>{/if}
								</span>
							</label>
						{/each}
					</div>
				</details>
			{/if}
		</section>

		<div class="collection-toolbar">
			<p class="muted" aria-live="polite">
				Showing {visibleDrafts.length} of {activeDrafts.length} local {activeDrafts.length === 1
					? 'draft'
					: 'drafts'} · Compact list view
			</p>
			<div class="search-box">
				<label>
					<span class="visually-hidden">Filter local drafts</span>
					<input
						type="search"
						bind:value={searchQuery}
						placeholder="Filter drafts by title, brand or link…"
						aria-label="Filter local drafts"
					/>
				</label>
			</div>
		</div>

		<div class="selection-bar" class:has-selection={selectedIds.length > 0}>
			<label>
				<input
					type="checkbox"
					checked={allSelected}
					indeterminate={selectedIds.length > 0 && !allSelected}
					disabled={busy || selectableDrafts.length === 0}
					onchange={toggleSelectAll}
				/>
				Select all visible drafts
			</label>
			<strong>{selectedIds.length} {selectedIds.length === 1 ? 'draft' : 'drafts'} selected</strong>
			{#if selectedIds.length > 0}
				<div class="selection-buttons">
					<button type="button" class="secondary" disabled={busy} onclick={pruneSelected}>
						Prune selected ({selectedIds.length})
					</button>
					<button
						type="button"
						class="quiet"
						disabled={busy}
						onclick={() => {
							selectedIds = [];
						}}
					>
						Clear selection
					</button>
				</div>
			{/if}
		</div>

		<div class="product-rows" role="list" aria-label="Compact list of local draft ideas">
			{#each visibleDrafts as record (record.id)}
				{@const title = captureTitle(record.draft)}
				{@const price = draftPriceLabel(record)}
				{@const selected = selectedIds.includes(record.id)}
				<article class="product-card compact draft-compact-row" role="listitem">
					<div class="draft-select-cell">
						<input
							type="checkbox"
							aria-label={`Select ${title}`}
							checked={selected}
							disabled={busy}
							onchange={() => toggleSelection(record.id)}
						/>
					</div>
					<div class="draft-thumb-cell">
						<DraftPreview {record} />
					</div>
					<div class="card-body">
						<div class="draft-main-info">
							<a class="card-title" href={`/capture?draft=${encodeURIComponent(record.id)}`}>
								<h2>{title}</h2>
							</a>
							<div class="draft-meta">
								<span class="badge">{statusLabel(record)}</span>
								{#if record.draft.sourceUrl}
									<a
										class="source-link"
										href={record.draft.sourceUrl}
										target="_blank"
										rel="noopener noreferrer"
									>
										{new URL(record.draft.sourceUrl).hostname.replace(/^www\./, '')} ↗
									</a>
								{/if}
								{#if record.message}
									<span class="error-note">{record.message}</span>
								{/if}
							</div>
						</div>
						<p class="price">{price}</p>
						<div class="draft-row-actions">
							<a class="button quiet" href={`/capture?draft=${encodeURIComponent(record.id)}`}>
								Edit
							</a>
							<button
								type="button"
								class="secondary prune-button"
								disabled={busy}
								aria-label={`Prune ${title}`}
								onclick={() => pruneDraft(record)}
							>
								Prune
							</button>
						</div>
					</div>
				</article>
			{/each}
		</div>
	{/if}
</main>

<style>
	.import-summary {
		margin-bottom: 1.2rem;
	}
	.import-summary p {
		margin: 0;
	}
	.empty-actions {
		display: flex;
		justify-content: center;
		gap: 0.75rem;
		flex-wrap: wrap;
	}
	.commit-panel {
		margin-bottom: 1.25rem;
	}
	.commit-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		flex-wrap: wrap;
	}
	.commit-header h2 {
		margin-bottom: 0.25rem;
	}
	.commit-header p {
		margin-bottom: 0;
		font-size: 0.9rem;
	}
	.commit-buttons {
		display: flex;
		gap: 0.6rem;
		flex-wrap: wrap;
	}
	.list-assign-details {
		margin-top: 1rem;
		border-top: 1px solid var(--line);
		padding-top: 0.75rem;
	}
	.list-assign-details summary {
		font-size: 0.9rem;
		padding: 0.25rem 0;
	}
	.list-choices {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
		gap: 0.5rem 1rem;
		margin-top: 0.5rem;
	}
	.list-choices .check-label {
		margin: 0;
	}
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
	.search-box {
		min-width: min(100%, 20rem);
	}
	.search-box label {
		margin: 0;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
	.selection-bar {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.75rem 1rem;
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: 0.7rem;
		padding: 0.6rem 1rem;
		margin: 1rem 0;
	}
	.selection-bar label {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin: 0;
		font-size: 0.85rem;
	}
	.selection-bar strong {
		font-size: 0.9rem;
	}
	.selection-buttons {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin-left: auto;
	}
	.has-selection {
		position: sticky;
		top: 0.5rem;
		z-index: 4;
		box-shadow: 0 0.3rem 1rem #172d391a;
	}
	.product-rows {
		display: grid;
		gap: 0.6rem;
	}
	.draft-compact-row {
		display: grid;
		grid-template-columns: auto auto minmax(0, 1fr);
		align-items: center;
		padding: 0.65rem 1rem;
		gap: 0.85rem;
		border-radius: 0.75rem;
	}
	.draft-select-cell {
		display: flex;
		align-items: center;
	}
	.draft-thumb-cell {
		display: flex;
		align-items: center;
	}
	.draft-compact-row .card-body {
		padding: 0;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto auto;
		align-items: center;
		gap: 0.5rem 1rem;
	}
	.draft-main-info {
		min-width: 0;
	}
	.draft-compact-row .card-title h2 {
		font-size: 1rem;
		margin: 0 0 0.25rem;
		overflow-wrap: anywhere;
	}
	.draft-meta {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
		font-size: 0.8rem;
	}
	.source-link {
		color: var(--muted);
	}
	.error-note {
		color: #7a3821;
		font-weight: 600;
	}
	.draft-compact-row .price {
		margin: 0;
		font-size: 0.95rem;
		white-space: nowrap;
	}
	.draft-row-actions {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}
	.prune-button {
		padding: 0.45rem 0.8rem;
		font-size: 0.85rem;
		min-height: 38px;
	}
	@media (max-width: 600px) {
		.draft-compact-row {
			grid-template-columns: auto auto minmax(0, 1fr);
			align-items: start;
			padding: 0.65rem 0.75rem;
			gap: 0.6rem;
		}
		.draft-compact-row .card-body {
			grid-template-columns: 1fr;
			gap: 0.4rem;
		}
		.draft-row-actions {
			justify-content: flex-start;
		}
	}
</style>
