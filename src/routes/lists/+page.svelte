<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { GiftList } from '#lib/catalogue-types.ts';
	import ListLifecycle from '#lib/components/ListLifecycle.svelte';
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
	let recipientName = $state('');
	let recipientId = $state('');
	let listName = $state('');
	let occasion = $state('');
	let message = $state('');
	let busy = $state(false);
	let showHidden = $state(false);
	let lifecycleDisabled = $state(false);
	const allLists = $derived(data.lists as GiftList[]);
	const displayedLists = $derived(allLists.filter((list) => showHidden || !list.archivedAt));
	async function post(path: string, body: unknown) {
		const response = await fetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		const value = await response.json();
		if (!response.ok) throw new Error(value.message);
		return value;
	}
	async function create() {
		if (lifecycleDisabled) return;
		busy = true;
		message = '';
		try {
			let selected = recipientId;
			if (recipientName.trim()) {
				const value = await post('/api/recipients', { name: recipientName });
				selected = value.id;
				recipientId = selected;
				recipientName = '';
				await invalidateAll();
			}
			if (!selected) throw new Error('Choose a recipient or add a name.');
			await post('/api/lists', {
				recipientId: selected,
				name: listName,
				occasion: occasion || null
			});
			listName = '';
			occasion = '';
			message = 'List created. You can add ideas or invite someone to this list.';
			await invalidateAll();
		} catch (error) {
			message = error instanceof Error ? error.message : 'The list could not be saved. Try again.';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Gift lists · Family gifts</title></svelte:head>
<main>
	<div class="page-heading">
		<div>
			<p class="eyebrow">Room for a little inspiration</p>
			<h1>Gift lists</h1>
			<p class="muted">Ideas for your favourite people, for every occasion.</p>
		</div>
		{#if data.canCapture}<a class="button" href="/capture">+ Add an idea</a>{/if}
	</div>
	{#snippet cards(controls?: {
		disabled: boolean;
		hide: (list: GiftList, trigger: HTMLElement) => void;
		remove: (list: GiftList, trigger: HTMLElement) => void;
	})}
		{#if data.administrator && allLists.some((list) => list.archivedAt)}<label class="check-label"
				><input type="checkbox" bind:checked={showHidden} /> Show hidden lists</label
			>{/if}
		<div class="list-grid">
			{#each displayedLists as list (list.id)}<article class="list-card">
					<a class="list-open" href={`/lists/${list.id}`}>
						<span class="badge"
							>{list.archivedAt ? 'Hidden' : (list.occasion ?? 'General ideas')}</span
						>
						<h2>{list.recipientName}</h2>
						<p>{list.name}</p>
						<p class="muted">
							<small
								>{list.role === 'administrator'
									? 'Open and manage this list'
									: `${list.role} access`} <span aria-hidden="true">↗</span></small
							>
						</p>
					</a>
					{#if controls}<div class="list-actions">
							<button
								class="secondary"
								disabled={controls.disabled || busy}
								aria-label={`${list.archivedAt ? 'Show' : 'Hide'} ${list.name} for ${list.recipientName}`}
								onclick={(event) => controls.hide(list, event.currentTarget)}
								>{list.archivedAt ? 'Show' : 'Hide'}</button
							>
							<button
								class="quiet"
								disabled={controls.disabled || busy}
								aria-label={`Delete ${list.name} for ${list.recipientName}`}
								onclick={(event) => controls.remove(list, event.currentTarget)}>Delete</button
							>
						</div>{/if}
				</article>{/each}
		</div>
		{#if !displayedLists.length}<section class="empty-state">
				<div class="empty-symbol" aria-hidden="true">✧</div>
				<h2>
					{data.administrator && allLists.length
						? 'All your lists are hidden'
						: data.administrator
							? 'Start with someone special'
							: 'No lists to show yet'}
				</h2>
				<p class="muted">
					{data.administrator && allLists.length
						? 'Select Show hidden lists above, then Show a list to make it available again.'
						: data.administrator
							? 'Create a recipient and their first list below. You can keep general ideas or make a list for a particular birthday or Christmas.'
							: 'Ask the administrator to share a list with you. Any list you can access will appear here.'}
				</p>
			</section>{/if}
	{/snippet}
	{#if data.administrator && data.administratorId}
		<ListLifecycle administratorId={data.administratorId} bind:mutationDisabled={lifecycleDisabled}>
			{#snippet children(controls)}{@render cards(controls)}{/snippet}
		</ListLifecycle>
	{:else}{@render cards()}{/if}
	{#if data.administrator}<details class="panel">
			<summary>Create a list</summary>
			<form
				onsubmit={(event) => {
					event.preventDefault();
					create();
				}}
			>
				<div class="form-grid">
					<label
						>Existing recipient <select bind:value={recipientId} disabled={!!recipientName}
							><option value="">Choose a recipient</option
							>{#each data.recipients as recipient}<option value={recipient.id}
									>{recipient.name}</option
								>{/each}</select
						></label
					><label
						>Or add a recipient <input bind:value={recipientName} placeholder="Their name" /></label
					>
				</div>
				<div class="form-grid">
					<label
						>List name <input
							required
							bind:value={listName}
							placeholder="For example: Birthday ideas"
						/></label
					><label
						>Occasion <input
							bind:value={occasion}
							placeholder="Leave blank for general ideas"
						/><small>Use a year to keep occasions distinct, such as Birthday 2027.</small></label
					>
				</div>
				<button disabled={busy || lifecycleDisabled}>{busy ? 'Creating…' : 'Create list'}</button>
			</form>
		</details>{/if}
	{#if message}<p class="notice" role="status">{message}</p>{/if}
</main>

<style>
	.list-card {
		padding: 0;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.list-open {
		display: block;
		padding: 1.5rem;
		flex: 1;
		color: inherit;
		text-decoration: none;
		overflow-wrap: anywhere;
	}
	.list-open:focus-visible {
		outline: 2px solid var(--accent, #356345);
		outline-offset: -4px;
		border-radius: 1rem;
	}
	.list-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		padding: 0 1.5rem 1.2rem;
	}
	.list-actions button {
		flex: 1;
	}
</style>
