<script lang="ts">
	import { onMount } from 'svelte';
	import MetadataPrefill from './MetadataPrefill.svelte';
	import ImageCaptureTools from './ImageCaptureTools.svelte';
	import { reviewFingerprint } from '#lib/shared/photo-shopping-links.ts';
	import { markEdited } from '#lib/client/capture-autofill.ts';
	import type { CaptureDraft, GiftList } from '#lib/catalogue-types.ts';
	let {
		draft = $bindable(),
		photos = $bindable([]),
		lists,
		busy = false,
		editing = false,
		locked = false,
		lockedListIds = [],
		localCapture = false,
		canSynchronise = true,
		addingAs = '',
		onKeep,
		onEnsureLocal,
		onSave,
		onListsChanged
	}: {
		draft: CaptureDraft;
		photos?: File[];
		lists: GiftList[];
		busy?: boolean;
		editing?: boolean;
		locked?: boolean;
		lockedListIds?: string[];
		localCapture?: boolean;
		canSynchronise?: boolean;
		addingAs?: string;
		onKeep?: () => void;
		onEnsureLocal?: () => Promise<void>;
		onSave: () => void;
		onListsChanged?: () => void;
	} = $props();
	let online = $state(true);
	let validation = $state('');
	let showText = $state(false);
	let listSearch = $state('');
	const localOnly = $derived(localCapture && (!online || !canSynchronise));
	const saveLabel = $derived.by(() => {
		if (busy) return 'Saving…';
		if (editing) return 'Save changes';
		return localOnly ? 'Save on this device' : 'Save idea';
	});
	const photoError = $derived(
		photos.some((file) => file.size > 12 * 1024 * 1024)
			? 'Each photo must be 12 MB or smaller. Remove the large photo or choose a smaller copy.'
			: ''
	);
	onMount(() => {
		const update = () => {
			online = navigator.onLine;
		};
		update();
		window.addEventListener('online', update);
		window.addEventListener('offline', update);
		return () => {
			window.removeEventListener('online', update);
			window.removeEventListener('offline', update);
		};
	});
	function stillChecked(offer: CaptureDraft['offers'][number]) {
		try {
			return (
				offer.checked &&
				offer.reviewFingerprint ===
					reviewFingerprint({ title: draft.title, variant: draft.variant || null }, offer.url)
			);
		} catch {
			return false;
		}
	}
	function submit() {
		if (
			!draft.title.trim() &&
			!draft.sourceUrl.trim() &&
			!draft.description.trim() &&
			!draft.sourceText.trim() &&
			!photos.length &&
			!draft.offers.some((offer) => offer.url.trim())
		) {
			validation = 'Add a link, a photo or a few words before saving your idea.';
			return;
		}
		validation = '';
		onSave();
	}
</script>

<form
	class="editor panel"
	class:capturing={localCapture}
	aria-label={editing ? 'Edit idea' : 'One gift idea'}
	novalidate={localCapture}
	onsubmit={(event) => {
		event.preventDefault();
		submit();
	}}
>
	<fieldset class="draft-fields" disabled={locked}>
		<p class="muted">
			{editing
				? 'Update this idea’s details and the lists it belongs to.'
				: 'This is one idea. Start with a link, a photo or a name, and fill in as much as you know.'}
		</p>
		<label
			>Product link <input
				type="url"
				bind:value={draft.sourceUrl}
				placeholder="Paste a shop or social media link"
			/></label
		>
		{#if !editing}<MetadataPrefill
				bind:draft
				bind:photos
				disabled={locked || busy}
				ensureLocal={onEnsureLocal}
			/>{/if}
		{#if !editing}<button
				type="button"
				class="quiet"
				onclick={() => {
					showText = !showText;
				}}>Paste text</button
			>{/if}
		{#if showText}<label
				>Text to read<textarea
					rows="3"
					bind:value={draft.sourceText}
					placeholder="Paste a caption, product description or message"></textarea></label
			>{/if}
		<label
			>Title <input
				bind:value={draft.title}
				oninput={() => markEdited(draft, 'title')}
				placeholder="Optional — we’ll try to find this from your link"
			/></label
		>
		{#if !editing}
			<label
				>Photos <input
					type="file"
					accept="image/jpeg,image/png,image/webp,image/heic,image/avif"
					multiple
					onchange={(event) => {
						const input = event.target as HTMLInputElement;
						const added = Array.from(input.files ?? []);
						photos = [
							...photos.filter((file) => !added.some((next) => next.name === file.name)),
							...added
						];
						markEdited(draft, 'photos');
						if (draft.browserCapture) draft.browserCapture.imageUrl = '';
						input.value = '';
					}}
				/>
				<small>JPEG, PNG or WebP recommended. Up to 12 MB and 30 megapixels per photo.</small>
			</label>
			{#if photos.length}<ul class="photo-previews">
					{#each photos as picture, index}<li>
							<ImageCaptureTools
								file={picture}
								disabled={locked || busy}
								onReplace={(replacement) => {
									photos = photos.map((file, position) =>
										position === index ? replacement : file
									);
									markEdited(draft, 'photos');
									if (draft.browserCapture) draft.browserCapture.imageUrl = '';
								}}
							/>
							<span>{picture.name}</span>
							<button
								type="button"
								class="quiet"
								aria-label={`Remove ${picture.name}`}
								onclick={() => {
									markEdited(draft, 'photos');
									if (draft.browserCapture) draft.browserCapture.imageUrl = '';
									photos = photos.filter((_, position) => position !== index);
								}}>Remove photo</button
							>
						</li>{/each}
				</ul>{/if}
			{#if photoError}<p role="alert" class="notice error">{photoError}</p>{/if}
		{/if}
		<label
			>Description <textarea
				rows="2"
				bind:value={draft.description}
				oninput={() => markEdited(draft, 'description')}
				placeholder="Anything you want to remember about this idea"></textarea></label
		>
		<label
			>Estimated price (£) <input
				inputmode="decimal"
				bind:value={draft.estimate}
				oninput={() => markEdited(draft, 'estimate')}
				placeholder="Unknown"
				disabled={editing}
			/>
			{#if editing}<small>Edit prices beside each selected list below.</small>{/if}
		</label>
		<fieldset class="list-selection">
			<legend>Choose lists</legend>
			{#if lists.length > 6}<label
					>Find a list<input
						type="search"
						bind:value={listSearch}
						placeholder="Child, occasion or list name"
					/></label
				>{/if}
			<p class="muted">
				An idea can be on several lists. Leave these unselected to keep it in your inbox.
			</p>
			{#each lists.filter((list) => (!list.archivedAt || draft.listIds.includes(list.id)) && (['administrator', 'contributor', 'buyer'].includes(list.role ?? '') || draft.listIds.includes(list.id)) && (!listSearch || (list.recipientName + ' ' + list.name + ' ' + (list.occasion ?? ''))
							.toLowerCase()
							.includes(listSearch.toLowerCase()))) as list}<div class="list-choice">
					<label class="check-label"
						><input
							type="checkbox"
							value={list.id}
							disabled={locked || lockedListIds.includes(list.id)}
							bind:group={draft.listIds}
							onchange={onListsChanged}
						/>
						<span
							><strong>{list.recipientName}</strong> · {list.name}{#if list.archivedAt}<span
									class="badge">Archived</span
								>{/if}<small>{list.occasion ?? 'General ideas'}</small></span
						>
					</label>
					{#if editing && draft.listIds.includes(list.id) && !lockedListIds.includes(list.id) && ['administrator', 'contributor', 'buyer'].includes(list.role ?? '')}<label
							class="estimate-field"
							>Estimated price (£)<input
								inputmode="decimal"
								bind:value={draft.entryEstimates[list.id]}
								placeholder="Unknown"
							/></label
						>{/if}
				</div>{:else}<p>
					No active contributor lists are available. You can save an unlisted idea.
				</p>{/each}
		</fieldset>
		<details class="idea-details">
			<summary>More details</summary>
			<label
				>Variant or size <input
					bind:value={draft.variant}
					oninput={() => markEdited(draft, 'variant')}
					placeholder="Colour, size or edition"
				/></label
			>
			<label
				>Labels <input bind:value={draft.labels} placeholder="For example: age 5, outdoors" /><small
					>Separate labels with commas. Labels organise ideas; they do not change access.</small
				></label
			>
			<label
				>Original text or notes <textarea
					rows="2"
					bind:value={draft.sourceText}
					placeholder="Paste a post, message or your own notes"></textarea></label
			>
			<p class="muted">
				Optional shopping links for this same idea. Keep foreign prices in their original currency.
			</p>
			{#each draft.offers as offer, index}<div
					class="shopping-row"
					oninput={() => markEdited(draft, 'offers')}
				>
					{#if offer.reverseFound}{#if stillChecked(offer)}<p>
								Checked by a person on {new Date(offer.checkedAt!).toLocaleDateString('en-GB')}.
								Changing the link, title or variant will require another check.
							</p>{:else}<p class="notice">
								This link may be incorrect. Check the product and variant before buying.
							</p>{/if}{/if}
					<label>Retailer <input bind:value={offer.retailer} placeholder="Shop name" /></label>
					<label>Link <input type="url" bind:value={offer.url} placeholder="https://…" /></label>
					<div class="form-grid">
						<label
							>Price <input
								inputmode="decimal"
								bind:value={offer.price}
								placeholder="Unknown"
							/></label
						>
						<label
							>Currency <input
								pattern={'[A-Z]{3}'}
								maxlength="3"
								bind:value={offer.currency}
								placeholder="GBP"
							/></label
						>
					</div>
					<button
						type="button"
						class="quiet"
						onclick={() => {
							markEdited(draft, 'offers');
							draft.offers = draft.offers.filter((_, position) => position !== index);
						}}>Remove link</button
					>
				</div>{/each}
			<button
				type="button"
				class="secondary"
				onclick={() => {
					markEdited(draft, 'offers');
					draft.offers = [...draft.offers, { url: '', retailer: '', price: '', currency: 'GBP' }];
				}}>Add shopping link</button
			>
		</details>
		{#if validation}<p class="notice error" role="alert">{validation}</p>{/if}
		<div class="form-actions">
			{#if onKeep && !editing}<button
					type="button"
					class="secondary"
					disabled={busy || !!photoError}
					onclick={onKeep}>Keep for later</button
				>{/if}
			<button disabled={busy || !!photoError}>{saveLabel}</button>
			{#if addingAs && !editing}<span class="muted">Adding as {addingAs}</span>{/if}
			<span class="muted"
				>{editing
					? 'Changes apply to the shared product.'
					: localOnly
						? 'Saved locally until you’re online and signed in.'
						: 'Saves this one idea and its selected lists. A local copy is kept until the server confirms it.'}</span
			>
		</div>
	</fieldset>
</form>

<style>
	@media (min-width: 601px) and (hover: hover) {
		.capturing .form-actions {
			position: sticky;
			bottom: max(0.5rem, env(safe-area-inset-bottom));
			z-index: 3;
			background: var(--paper, #fff);
			padding: 0.8rem;
			border: 1px solid var(--line);
			border-radius: 0.65rem;
			box-shadow: 0 2px 12px #213b4310;
		}
		.capturing input,
		.capturing textarea {
			scroll-margin-bottom: 10rem;
		}
	}
	.draft-fields,
	.list-selection {
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	.draft-fields:disabled {
		opacity: 0.7;
	}
	.list-selection {
		margin: 1.4rem 0;
	}
	legend,
	summary {
		font-weight: 650;
	}
	.idea-details {
		border-top: 1px solid var(--line);
		padding: 1rem 0;
		margin-bottom: 0.5rem;
	}
	summary {
		cursor: pointer;
		margin-bottom: 1rem;
	}
	.photo-previews {
		list-style: none;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
	}
	.photo-previews li {
		width: min(100%, 22rem);
		overflow-wrap: anywhere;
		font-size: 0.85rem;
	}
</style>
