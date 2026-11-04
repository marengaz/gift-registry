<script lang="ts">
	import MetadataPrefill from './MetadataPrefill.svelte';
	import type { CaptureDraft, GiftList } from '#lib/catalogue-types.ts';
	let {
		draft = $bindable(),
		photos = $bindable([]),
		lists,
		busy = false,
		editing = false,
		locked = false,
		localCapture = false,
		onSave,
		onListsChanged
	}: {
		draft: CaptureDraft;
		photos?: File[];
		lists: GiftList[];
		busy?: boolean;
		editing?: boolean;
		locked?: boolean;
		localCapture?: boolean;
		onSave: () => void;
		onListsChanged?: () => void;
	} = $props();
	let photoError = $state('');
	function selected(event: Event) {
		const target = event.target as HTMLInputElement;
		const values = Array.from(target.files ?? []);
		photos = values;
		photoError = values.some((file) => file.size > 12 * 1024 * 1024)
			? 'Each photo must be 12 MB or smaller. Choose a smaller photo before saving.'
			: '';
	}
</script>

<form
	class="editor"
	onsubmit={(event) => {
		event.preventDefault();
		onSave();
	}}
>
	<fieldset class="draft-fields" disabled={locked}>
		<section class="panel">
			<h2>The idea</h2>
			<label
				>Title <input
					required
					bind:value={draft.title}
					placeholder="A name you’ll recognise later"
				/></label
			>
			{#if localCapture}<button type="button" disabled={busy || !!photoError} onclick={onSave}
					>Save on this device</button
				>{/if}
			<div class="form-grid">
				<label
					>Variant or size <input
						bind:value={draft.variant}
						placeholder="Colour, size or edition"
					/></label
				><label
					>Estimated price (£) <input
						inputmode="decimal"
						bind:value={draft.estimate}
						placeholder="Unknown"
						disabled={editing}
					/>{#if editing}<small>Edit prices beside each selected list below.</small>{/if}</label
				>
			</div>
			<label
				>Description <textarea
					rows="3"
					bind:value={draft.description}
					placeholder="Why they might like it, or anything useful to remember"></textarea></label
			>
			<label
				>Labels <input bind:value={draft.labels} placeholder="For example: age 5, outdoors" /><small
					>Separate labels with commas. Labels organise ideas; they do not change access.</small
				></label
			>
		</section>
		<section class="panel">
			<h2>Keep the source</h2>
			<label
				>Source link <input
					type="url"
					bind:value={draft.sourceUrl}
					placeholder="https://…"
				/></label
			>
			{#if !editing}<MetadataPrefill bind:draft bind:photos disabled={locked || busy} />{/if}
			<label
				>Original text or notes <textarea
					rows="3"
					bind:value={draft.sourceText}
					placeholder="Paste a post, message or your own notes"></textarea></label
			>
			{#if !editing}<label
					>Photos <input
						type="file"
						accept="image/jpeg,image/png,image/webp,image/heic,image/avif"
						multiple
						onchange={selected}
					/><small>JPEG, PNG or WebP recommended. Up to 12 MB and 30 megapixels per photo.</small
					></label
				>
				{#if photos.length}<ul class="file-list">
						{#each photos as photo}<li>
								{photo.name} <span class="muted">({(photo.size / 1024 / 1024).toFixed(1)} MB)</span>
							</li>{/each}
					</ul>{/if}
				{#if photoError}<p role="alert" class="notice error">{photoError}</p>{/if}{/if}
		</section>
		<section class="panel">
			<h2>Shopping links</h2>
			<p class="muted">
				Keep any useful retailer links. Leave a price blank when you do not know it.
			</p>
			{#each draft.offers as offer, index}<div class="shopping-row">
					<label>Retailer <input bind:value={offer.retailer} placeholder="Shop name" /></label
					><label
						>Link <input
							required
							type="url"
							bind:value={offer.url}
							placeholder="https://…"
						/></label
					>
					<div class="form-grid">
						<label
							>Price <input
								inputmode="decimal"
								bind:value={offer.price}
								placeholder="Unknown"
							/></label
						><label
							>Currency <input
								required
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
						onclick={() => (draft.offers = draft.offers.filter((_, i) => i !== index))}
						>Remove link</button
					>
				</div>{/each}
			<button
				type="button"
				class="secondary"
				onclick={() =>
					(draft.offers = [...draft.offers, { url: '', retailer: '', price: '', currency: 'GBP' }])}
				>Add shopping link</button
			>
		</section>
		<section class="panel">
			<h2>Choose lists</h2>
			<p class="muted">
				Select as many as you need. Leave all unselected to keep this in your unlisted inbox.
			</p>
			{#each lists.filter((list) => !list.archivedAt || draft.listIds.includes(list.id)) as list}<div
					class="list-choice"
				>
					<label class="check-label"
						><input
							type="checkbox"
							value={list.id}
							bind:group={draft.listIds}
							onchange={onListsChanged}
						/><span
							><strong>{list.recipientName}</strong> · {list.name}{#if list.archivedAt}<span
									class="badge">Archived</span
								>{/if}<small>{list.occasion ?? 'General ideas'}</small></span
						></label
					>
					{#if editing && draft.listIds.includes(list.id)}<label class="estimate-field"
							>Estimated price (£)<input
								inputmode="decimal"
								bind:value={draft.entryEstimates[list.id]}
								placeholder="Unknown"
							/></label
						>{/if}
				</div>{:else}<p>
					No active contributor lists are available. You can save an unlisted idea.
				</p>{/each}
		</section>
		<div class="form-actions">
			<button disabled={busy || !!photoError}
				>{busy ? 'Saving…' : editing ? 'Save changes' : 'Save idea'}</button
			><span class="muted"
				>{editing
					? 'Changes apply to the shared product.'
					: localCapture
						? 'Save on this device first, then synchronise when connected.'
						: 'Your idea stays here if saving fails.'}</span
			>
		</div>
	</fieldset>
</form>

<style>
	.draft-fields {
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	.draft-fields:disabled {
		opacity: 0.7;
	}
</style>
