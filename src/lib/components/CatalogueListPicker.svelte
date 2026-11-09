<script lang="ts">
	import { tick } from 'svelte';
	import { containDialogFocus } from '#lib/dialog-focus.ts';
	import type { GiftList, Product } from '#lib/catalogue-types.ts';
	let {
		open,
		products,
		lists,
		busy,
		online,
		pending,
		message,
		signInRequired,
		onclose,
		onsubmit,
		onretry
	}: {
		open: boolean;
		products: Product[];
		lists: GiftList[];
		busy: boolean;
		online: boolean;
		pending: boolean;
		message: string;
		signInRequired: boolean;
		onclose: () => void;
		onsubmit: (ids: string[]) => void;
		onretry: () => void;
	} = $props();
	let dialog: HTMLDialogElement;
	let search: HTMLInputElement;
	let query = $state('');
	let selected = $state<string[]>([]);
	const active = $derived(
		lists
			.filter((list) => list.archivedAt === null)
			.sort((a, b) =>
				`${a.recipientName} ${a.name}`.localeCompare(`${b.recipientName} ${b.name}`, 'en-GB')
			)
	);
	const matching = $derived(
		active.filter((list) =>
			`${list.recipientName} ${list.name} ${list.occasion ?? ''}`
				.toLocaleLowerCase('en-GB')
				.includes(query.trim().toLocaleLowerCase('en-GB'))
		)
	);
	function count(listId: string) {
		return products.filter((product) => product.entries.some((entry) => entry.listId === listId))
			.length;
	}
	function toggle(id: string) {
		selected = selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id];
	}
	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) {
			query = '';
			selected = [];
			dialog.showModal();
			void tick().then(() => search?.focus());
		} else if (!open && dialog.open) dialog.close();
	});
</script>

<dialog
	bind:this={dialog}
	onkeydown={containDialogFocus}
	aria-labelledby="catalogue-picker-heading"
	oncancel={(event) => {
		event.preventDefault();
		if (!busy && !pending) onclose();
	}}
>
	<div class="picker-body">
		<p class="eyebrow">{products.length} {products.length === 1 ? 'idea' : 'ideas'}</p>
		<h2 id="catalogue-picker-heading">Add to lists</h2>
		<p class="muted">
			Choose one or more destinations. Existing gifts and buying details stay as they are.
		</p>
		<label
			>Search lists <input
				bind:this={search}
				bind:value={query}
				disabled={busy || pending}
				placeholder="Recipient, list name or occasion"
			/></label
		>
		<div class="choices">
			{#each matching as list (list.id)}{@const existing = count(list.id)}
				<label class="choice" class:complete={existing === products.length}>
					<input
						type="checkbox"
						checked={selected.includes(list.id)}
						disabled={busy || pending || existing === products.length}
						onchange={() => toggle(list.id)}
					/>
					<span
						>{list.recipientName} · {list.name}{#if list.occasion && list.occasion !== list.name}<small
								>{list.occasion}</small
							>{/if}<small
							>{existing === products.length
								? 'Already on this list'
								: existing
									? `${existing} of ${products.length} already listed`
									: 'Not yet listed'}</small
						></span
					>
				</label>
			{:else}<p class="muted">
					{active.length
						? 'No lists match this search.'
						: 'Create a list before adding ideas to it.'}
				</p>{/each}
		</div>
		<p class="selected-count">
			{selected.length}
			{selected.length === 1 ? 'list' : 'lists'} selected
		</p>
		{#if selected.length}<div class="selected-lists" aria-label="Selected lists">
				{#each selected as id}{@const list = active.find(
						(value) => value.id === id
					)}{#if list}<button
							type="button"
							class="secondary"
							disabled={busy || pending}
							onclick={() => toggle(id)}
							aria-label={`Remove ${list.recipientName} · ${list.name}`}
							>{list.recipientName} · {list.name} <span aria-hidden="true">×</span></button
						>{/if}{/each}
			</div>{/if}
		{#if message}<p role="alert">{message}</p>{/if}
		{#if signInRequired}<a href="/login">Sign in again</a>{/if}
		{#if !online}<p class="muted">
				Connect to the internet before adding ideas to lists or retrying a request.
			</p>{/if}
		{#if pending}<p class="muted">
				This request is awaiting confirmation. Retrying checks the same action without adding it
				twice.
			</p>{/if}
	</div>
	<div class="dialog-actions">
		<button type="button" class="secondary" disabled={busy || pending} onclick={onclose}
			>Cancel</button
		>
		{#if pending}<button type="button" disabled={busy || !online} onclick={onretry}
				>{busy ? 'Checking…' : 'Retry last request'}</button
			>{:else}<button
				type="button"
				disabled={busy || !online || !selected.length}
				onclick={() => onsubmit([...selected])}
				>{busy
					? 'Adding…'
					: selected.length
						? `Add to ${selected.length} ${selected.length === 1 ? 'list' : 'lists'}`
						: 'Add to lists'}</button
			>{/if}
	</div>
</dialog>

<style>
	dialog {
		width: min(38rem, calc(100vw - 2rem));
		max-height: calc(100dvh - 2rem);
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 1rem;
		color: var(--ink);
		background: var(--paper);
		box-shadow: 0 1rem 4rem #142d3940;
		overflow: auto;
	}
	dialog::backdrop {
		background: #172d3980;
	}
	.picker-body {
		padding: 1.4rem;
	}
	h2 {
		margin: 0.25rem 0;
	}
	.eyebrow {
		margin: 0;
	}
	.choices {
		max-height: 34dvh;
		overflow-y: auto;
		border-block: 1px solid var(--line);
		padding: 0.3rem 0;
	}
	.choice {
		display: flex;
		align-items: center;
		gap: 0.8rem;
		padding: 0.65rem 0.4rem;
		margin: 0;
		border-radius: 0.4rem;
		cursor: pointer;
	}
	.choice:has(input:checked) {
		background: #e5eee5;
	}
	.choice input {
		margin: 0;
	}
	.complete {
		color: var(--muted);
	}
	.selected-count {
		font-weight: 650;
		margin: 0.8rem 0 0.4rem;
	}
	.selected-lists {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.selected-lists button {
		font-size: 0.8rem;
		min-height: 36px;
		padding: 0.35rem 0.6rem;
		max-width: 100%;
		overflow-wrap: anywhere;
	}
	.dialog-actions {
		position: sticky;
		bottom: 0;
		display: flex;
		justify-content: flex-end;
		gap: 0.6rem;
		padding: 1rem 1.4rem;
		background: var(--paper);
		border-top: 1px solid var(--line);
	}
	@media (max-width: 600px) {
		.picker-body {
			padding: 1rem;
		}
		.dialog-actions {
			padding: 1rem;
			flex-wrap: wrap;
		}
		.choice {
			font-size: 0.9rem;
		}
	}
</style>
