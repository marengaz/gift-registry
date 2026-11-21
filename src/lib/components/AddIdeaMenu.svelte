<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { containDialogFocus } from '#lib/dialog-focus.ts';
	import { registerCapturePreparation } from '#lib/client/capture-session.ts';
	import {
		ingestAmazonWishlist,
		type WishlistIngestProgress
	} from '#lib/client/wishlist-import.ts';

	let menuEl: HTMLDetailsElement | undefined = $state();
	let summaryEl: HTMLElement | undefined = $state();
	let dialogEl: HTMLDialogElement | undefined = $state();
	let urlInputEl: HTMLInputElement | undefined = $state();

	let modalOpen = $state(false);
	let wishlistUrl = $state('');
	let busy = $state(false);
	let error = $state('');
	let progress = $state<WishlistIngestProgress | null>(null);

	$effect(() => {
		if (!dialogEl) return;
		if (modalOpen && !dialogEl.open) {
			dialogEl.showModal();
			void tick().then(() => urlInputEl?.focus());
		} else if (!modalOpen && dialogEl.open) {
			dialogEl.close();
		}
	});

	onMount(() => {
		const unregisterPreparation = registerCapturePreparation(async () => {
			if (busy) {
				throw new Error('Wait for the Amazon wishlist import to finish before signing out.');
			}
			return async () => {};
		});
		const handlePointerDown = (event: MouseEvent) => {
			if (menuEl?.open && event.target instanceof Node && !menuEl.contains(event.target)) {
				menuEl.removeAttribute('open');
			}
		};
		window.addEventListener('pointerdown', handlePointerDown);
		return () => {
			unregisterPreparation();
			window.removeEventListener('pointerdown', handlePointerDown);
		};
	});

	function handleMenuKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && menuEl?.open) {
			event.preventDefault();
			event.stopPropagation();
			menuEl.removeAttribute('open');
			summaryEl?.focus();
		}
	}

	function openWishlistDialog() {
		menuEl?.removeAttribute('open');
		error = '';
		progress = null;
		modalOpen = true;
	}

	function closeWishlistDialog() {
		if (busy) return;
		modalOpen = false;
		error = '';
		progress = null;
	}

	const progressText = $derived.by(() => {
		if (!progress) return 'Reading Amazon wishlist…';
		if (progress.phase === 'fetching-list')
			return 'Reading Amazon wishlist pages and checking for duplicates…';
		if (progress.phase === 'saving-drafts')
			return `Saving draft ideas on this device (${progress.completed} of ${progress.total})…`;
		if (progress.phase === 'fetching-images')
			return `Copying product thumbnails (${progress.completed} of ${progress.total})…`;
		return 'Opening draft review…';
	});

	async function submitWishlist(event: SubmitEvent) {
		event.preventDefault();
		if (busy) return;
		const url = wishlistUrl.trim();
		if (!url) {
			error = 'Paste an Amazon wishlist or idea list link.';
			return;
		}
		if (!URL.canParse(url) || new URL(url).protocol !== 'https:') {
			error = 'Use a public HTTPS Amazon wishlist link (for example https://a.co/d/...).';
			return;
		}
		busy = true;
		error = '';
		try {
			const result = await ingestAmazonWishlist({
				url,
				onProgress: (next) => {
					progress = next;
				}
			});
			modalOpen = false;
			wishlistUrl = '';
			const params = new URLSearchParams();
			params.set('imported', String(result.importedDrafts.length));
			if (result.skippedDuplicates > 0) params.set('skipped', String(result.skippedDuplicates));
			if (result.listTitle) params.set('listTitle', result.listTitle);
			await goto(`/capture/drafts?${params.toString()}`);
		} catch (reason) {
			error =
				reason instanceof Error
					? reason.message
					: 'This Amazon wishlist could not be imported. Check that the link is public and try again.';
		} finally {
			busy = false;
			progress = null;
		}
	}
</script>

<div class="add-idea-split" role="group" aria-label="Add idea options">
	<a class="button split-primary" href="/capture">+ Add an idea</a>
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<details class="split-menu" bind:this={menuEl} onkeydown={handleMenuKeydown}>
		<summary class="button split-toggle" bind:this={summaryEl} aria-label="More ways to add ideas"
			>▾</summary
		>
		<div class="split-dropdown" role="menu">
			<a
				role="menuitem"
				href="/capture"
				onclick={() => {
					menuEl?.removeAttribute('open');
				}}>Add a single idea</a
			>
			<button type="button" role="menuitem" onclick={openWishlistDialog}
				>Import Amazon wishlist…</button
			>
		</div>
	</details>
</div>

<dialog
	bind:this={dialogEl}
	onkeydown={containDialogFocus}
	aria-labelledby="import-wishlist-heading"
	oncancel={(event) => {
		event.preventDefault();
		closeWishlistDialog();
	}}
>
	<form onsubmit={submitWishlist} novalidate>
		<h2 id="import-wishlist-heading">Import Amazon wishlist</h2>
		<p class="muted">
			Every item on the list will be saved as a local draft on this device, skipping duplicates
			already in your drafts or catalogue. You can then review and prune unwanted items in a compact
			list before adding them to the catalogue.
		</p>
		<label
			>Amazon wishlist or idea list link
			<input
				bind:this={urlInputEl}
				type="url"
				name="wishlistUrl"
				bind:value={wishlistUrl}
				disabled={busy}
				placeholder="https://a.co/d/02BqURT1"
				required
			/>
			<small>Supports Amazon wishlists, gift lists and influencer idea lists.</small>
		</label>
		{#if busy}<p role="status" class="notice">{progressText}</p>{/if}
		{#if error}<p role="alert" class="notice error">{error}</p>{/if}
		<div class="dialog-actions">
			<button type="button" class="secondary" disabled={busy} onclick={closeWishlistDialog}
				>Cancel</button
			>
			<button type="submit" disabled={busy}>{busy ? 'Importing…' : 'Import wishlist'}</button>
		</div>
	</form>
</dialog>

<style>
	.add-idea-split {
		display: inline-flex;
		align-items: stretch;
		position: relative;
		flex-shrink: 0;
	}
	.split-primary {
		border-top-right-radius: 0;
		border-bottom-right-radius: 0;
		border-right: 1px solid #ffffff38;
	}
	.split-menu {
		position: relative;
		display: flex;
	}
	.split-menu > summary {
		list-style: none;
		border-top-left-radius: 0;
		border-bottom-left-radius: 0;
		padding: 0.7rem 0.75rem;
		min-width: 2.5rem;
		margin: 0;
	}
	.split-menu > summary::-webkit-details-marker {
		display: none;
	}
	.split-menu[open] > summary {
		margin-bottom: 0;
		background: #34565e;
	}
	.split-dropdown {
		position: absolute;
		right: 0;
		top: calc(100% + 0.35rem);
		z-index: 20;
		min-width: 15.5rem;
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: 0.75rem;
		box-shadow: 0 0.4rem 1.2rem #172d3924;
		padding: 0.35rem;
		display: grid;
		gap: 0.2rem;
	}
	.split-dropdown a,
	.split-dropdown button {
		display: flex;
		align-items: center;
		justify-content: flex-start;
		width: 100%;
		text-align: left;
		background: transparent;
		color: var(--ink);
		border: 0;
		border-radius: 0.5rem;
		padding: 0.6rem 0.8rem;
		font-size: 0.9rem;
		font-weight: 550;
		text-decoration: none;
		min-height: 40px;
	}
	.split-dropdown a:hover,
	.split-dropdown button:hover {
		background: var(--sage);
		color: var(--ink);
	}
	dialog {
		max-width: 34rem;
		width: calc(100vw - 2rem);
		box-sizing: border-box;
		max-height: calc(100dvh - 2rem);
		overflow: auto;
		border: 1px solid var(--line);
		border-radius: 1rem;
		padding: 1.5rem;
		background: var(--paper);
		color: var(--ink);
	}
	dialog::backdrop {
		background: #172d3980;
	}
	.dialog-actions {
		display: flex;
		justify-content: flex-end;
		flex-wrap: wrap;
		gap: 0.6rem;
		margin-top: 1.2rem;
	}
</style>
