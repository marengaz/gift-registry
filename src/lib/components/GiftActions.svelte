<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { navigating } from '$app/state';
	import {
		money,
		pence,
		type GiftEntry,
		type AllocationRecord,
		type AssignmentMember
	} from '#lib/catalogue-types.ts';
	let {
		entry,
		listId,
		administrator = false,
		role,
		archived = false,
		compact = false
	}: {
		entry: GiftEntry;
		listId?: string;
		administrator?: boolean;
		role?: string | null;
		archived?: boolean;
		compact?: boolean;
	} = $props();
	let current = $state<GiftEntry | null>(null);
	let members = $state<AssignmentMember[]>([]);
	let history = $state<AllocationRecord[]>([]);
	let fresh = $state(false);
	let busy = $state(false);
	let online = $state(false);
	let message = $state('');
	let buyerId = $state('');
	let actual = $state('');
	let pending = $state<Record<string, unknown> | null>(null);
	let controlsOpen = $state(false);
	const gift = $derived(current ?? entry);
	const availabilityLabel = $derived.by(() => {
		if (!fresh) return 'Availability needs an online refresh';
		if (gift.state === 'available') return 'Available';
		if (gift.state === 'purchased') return 'Purchased';
		if (gift.allocationSource === 'administrator') return 'Assigned';
		return 'Reserved';
	});
	const mayBuy = $derived(administrator || role === 'buyer' || role === 'contributor');
	const enabled = $derived(fresh && online && !busy && !pending && !navigating.to);
	async function refresh() {
		online = navigator.onLine;
		fresh = false;
		if (!online) return;
		try {
			const response = await fetch(`/api/entries/${entry.id}/allocation`, { cache: 'no-store' });
			const result = await response.json();
			if (!response.ok) {
				message = result.message;
				await invalidateAll();
				return;
			}
			current = result.entry;
			members = result.members;
			history = result.history ?? [];
			fresh = true;
		} catch {
			fresh = false;
		}
	}
	onMount(() => {
		void refresh();
		const offline = () => {
			online = false;
			fresh = false;
		};
		const recheck = () => {
			void refresh();
		};
		window.addEventListener('offline', offline);
		window.addEventListener('online', recheck);
		window.addEventListener('focus', recheck);
		return () => {
			window.removeEventListener('offline', offline);
			window.removeEventListener('online', recheck);
			window.removeEventListener('focus', recheck);
		};
	});
	async function send(action?: string) {
		if (!navigator.onLine || busy || navigating.to) {
			online = navigator.onLine;
			return;
		}
		if (!pending && action) {
			try {
				pending = {
					action,
					actionId: crypto.randomUUID(),
					expectedVersion: gift.version,
					...(action === 'assign' ? { buyerId } : {}),
					...(action === 'purchase' ? { actualPence: pence(actual) } : {})
				};
			} catch (error) {
				message = error instanceof Error ? error.message : 'Check the GBP amount.';
				return;
			}
		}
		if (!pending) return;
		busy = true;
		message = '';
		try {
			const response = await fetch(`/api/entries/${entry.id}/allocation`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(pending)
			});
			const result = await response.json();
			if (!response.ok) {
				if (response.status < 500) {
					pending = null;
					fresh = false;
					await refresh();
					await invalidateAll();
				}
				throw new Error(result.message ?? 'The buying action could not be confirmed.');
			}
			current = result.entry ?? null;
			pending = null;
			actual = '';
			await refresh();
			await invalidateAll();
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'The result is unknown. Retry this same action when online.';
		} finally {
			busy = false;
		}
	}
	async function removeFromList() {
		if (!listId || !navigator.onLine || busy || navigating.to) return;
		busy = true;
		message = '';
		try {
			const response = await fetch(`/api/lists/${listId}/entries/${gift.id}`, {
				method: 'DELETE'
			});
			const result = await response.json();
			if (!response.ok)
				throw new Error(result.message ?? 'Could not remove this idea from the list.');
			await invalidateAll();
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Could not remove this idea from the list.';
		} finally {
			busy = false;
		}
	}
</script>

<div class="gift-actions">
	<p class="gift-state">
		{availabilityLabel}{#if administrator && gift.buyerId}
			{' · '}{members.find((person) => person.id === gift.buyerId)?.name ?? 'Existing buyer'}{/if}
	</p>
	{#if gift.state === 'purchased'}<p class="value">
			{money(gift.actualPence ?? gift.estimatePence)}{gift.actualPence === null
				? ' · estimate'
				: ' · actual spend'}
		</p>{/if}
	<details
		class="action-controls"
		class:expanded={!compact}
		open={!compact || controlsOpen}
		ontoggle={(event) => {
			if (compact) controlsOpen = event.currentTarget.open;
		}}
	>
		<summary>Gift actions</summary>
		<div class="action-buttons">
			{#if !online}<p class="hint">Buying needs a current online connection.</p>{:else if !fresh}<p
					class="hint"
				>
					Refresh availability before buying.
				</p>
				<button class="secondary compact" disabled={busy} onclick={refresh}
					>Refresh availability</button
				>{/if}
			{#if pending}<p class="hint">
					This action has not been confirmed. Retry it to check the saved result.
				</p>
				<button class="secondary compact" disabled={!online || busy} onclick={() => send()}
					>Retry action</button
				>{/if}
			{#if mayBuy}
				{#if gift.state === 'available' && !archived}<button
						class="compact"
						disabled={!enabled}
						onclick={() => send('reserve')}>Reserve for me</button
					>{/if}
				{#if gift.state === 'allocated'}
					<label
						>Actual GBP spend (optional)<input
							aria-label="Actual GBP spend (optional)"
							inputmode="decimal"
							placeholder="Leave blank to use estimate"
							bind:value={actual}
							disabled={!enabled}
						/></label
					>
					<button class="compact" disabled={!enabled} onclick={() => send('purchase')}
						>Mark purchased</button
					>
					{#if !administrator && gift.allocationSource === 'self'}<button
							class="secondary compact"
							disabled={!enabled}
							onclick={() => send('release')}>Release reservation</button
						>{/if}
				{/if}
			{/if}
			{#if !mayBuy && gift.state === 'allocated'}<p class="hint">
					Ask the administrator to record a purchase or change your assignment.
				</p>{/if}
			{#if administrator}
				{#if gift.state === 'purchased'}<button
						class="secondary compact"
						disabled={!enabled}
						onclick={() => send('undo')}>Undo purchase</button
					>{:else}
					{#if !archived}<label
							>Assign to<select bind:value={buyerId} disabled={!enabled}
								><option value="">Choose a person</option>{#each members as person}<option
										value={person.id}>{person.name} ({person.role})</option
									>{/each}</select
							></label
						><button
							class="secondary compact"
							disabled={!enabled || !buyerId}
							onclick={() => send('assign')}
							>{gift.state === 'allocated' ? 'Reassign gift' : 'Assign gift'}</button
						>{/if}
					{#if gift.state === 'allocated'}<button
							class="secondary compact"
							disabled={!enabled}
							onclick={() => send('clear')}>Clear allocation</button
						>{/if}
				{/if}
			{/if}
			{#if !archived && gift.state === 'available' && listId && (administrator || role === 'contributor')}<button
					type="button"
					class="secondary compact"
					disabled={!enabled}
					onclick={removeFromList}>Remove from list</button
				>{/if}
			{#if administrator && history.length}<details>
					<summary>Allocation history</summary>
					<ol>
						{#each history as record}<li>
								{record.action} · {record.fromState} → {record.toState} · {new Date(
									record.createdAt
								).toLocaleString('en-GB')}
							</li>{/each}
					</ol>
				</details>{/if}
			{#if message}<p class="error hint" role="alert">{message}</p>{/if}
		</div>
	</details>
</div>

<style>
	.gift-actions {
		border-top: 1px solid var(--border, #e7e4dd);
		margin-top: 1rem;
		padding-top: 1rem;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
	}
	.action-controls.expanded > summary {
		display: none;
	}
	.action-buttons {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
	}
	.action-controls > summary {
		font-size: 0.8rem;
	}
	details {
		width: 100%;
		font-size: 0.8rem;
	}
	.gift-state {
		font-weight: 650;
		width: 100%;
		margin: 0;
	}
	.hint,
	.value {
		width: 100%;
		font-size: 0.85rem;
		margin: 0;
	}
	label {
		width: 100%;
		font-size: 0.85rem;
		display: grid;
		gap: 0.3rem;
	}
	input,
	select {
		width: 100%;
		min-width: 0;
	}
	.compact {
		font-size: 0.85rem;
		padding: 0.55rem 0.8rem;
	}
</style>
