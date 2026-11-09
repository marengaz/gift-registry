<script lang="ts">
	import { onMount, tick, type Snippet } from 'svelte';
	import { containDialogFocus } from '#lib/dialog-focus.ts';
	import { invalidateAll } from '$app/navigation';
	import { navigating } from '$app/state';
	import type { Product, GiftList } from '#lib/catalogue-types.ts';
	import type {
		CatalogueActionStatus,
		CatalogueActionRequest,
		CatalogueUndoRequest,
		CatalogueActionResult,
		CatalogueActionError,
		CatalogueDeleteImpact,
		CatalogueUndoSummary
	} from '#lib/shared/catalogue-actions.ts';
	import CatalogueListPicker from './CatalogueListPicker.svelte';
	type Controls = {
		selected: string[];
		disabled: boolean;
		toggle: (id: string) => void;
		add: (ids: string[]) => void;
		remove: (ids: string[]) => void;
	};
	type Pending = {
		endpoint: 'action' | 'undo';
		body: CatalogueActionRequest | CatalogueUndoRequest;
	};
	let {
		products,
		lists,
		status,
		filterKey,
		children
	}: {
		products: Product[];
		lists: GiftList[];
		status: CatalogueActionStatus;
		filterKey: string;
		children: Snippet<[Controls]>;
	} = $props();
	let selected = $state<string[]>([]);
	let targetIds = $state<string[]>([]);
	let pickerOpen = $state(false);
	let undo = $state<CatalogueUndoSummary | null>(null);
	let busy = $state(false);
	let ready = $state(false);
	let online = $state(false);
	let message = $state('');
	let signInRequired = $state(false);
	let pending = $state<Pending | null>(null);
	let impact = $state<CatalogueDeleteImpact | null>(null);
	let impactDialog: HTMLDialogElement;
	let statusRegion: HTMLDivElement;
	let confirmButton = $state<HTMLButtonElement>();
	const storageKey = $derived(`family-gifts-catalogue-pending:${status.administratorId}`);
	const disabled = $derived(!ready || !online || busy || !!pending || !!navigating.to);
	const targets = $derived(products.filter((product) => targetIds.includes(product.id)));
	const allSelected = $derived(
		products.length > 0 && products.every((product) => selected.includes(product.id))
	);
	let lastFilter = '';
	$effect(() => {
		if (filterKey !== lastFilter) {
			lastFilter = filterKey;
			selected = [];
		}
	});
	$effect(() => {
		undo = status.undo;
	});
	$effect(() => {
		if (!impactDialog) return;
		if (impact && !impactDialog.open) {
			impactDialog.showModal();
			void tick().then(() => confirmButton?.focus());
		} else if (!impact && impactDialog.open) impactDialog.close();
	});
	onMount(() => {
		online = navigator.onLine;
		try {
			const stored = sessionStorage.getItem(storageKey);
			if (stored) {
				const value = JSON.parse(stored);
				if (
					value?.body?.operationId &&
					(value.endpoint === 'action' || value.endpoint === 'undo')
				) {
					pending = value;
					if (value.endpoint === 'action' && Array.isArray(value.body.productIds))
						targetIds = [...value.body.productIds];
					message =
						'A previous request is awaiting confirmation. Retry it before making another change.';
				} else sessionStorage.removeItem(storageKey);
			}
		} catch {
			message = 'Browser storage is unavailable. Keep this page open until actions are confirmed.';
		}
		ready = true;
		const update = () => (online = navigator.onLine);
		window.addEventListener('online', update);
		window.addEventListener('offline', update);
		return () => {
			window.removeEventListener('online', update);
			window.removeEventListener('offline', update);
		};
	});
	function toggle(id: string) {
		if (disabled) return;
		selected = selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id];
	}
	function add(ids: string[]) {
		if (disabled) return;
		targetIds = [...ids];
		message = '';
		pickerOpen = true;
	}
	function clearPending() {
		pending = null;
		try {
			sessionStorage.removeItem(storageKey);
		} catch {}
	}
	async function focusStatus() {
		await tick();
		statusRegion?.focus();
	}
	async function refreshStatus() {
		const response = await fetch('/api/catalogue-actions', { cache: 'no-store' });
		if (response.ok) {
			const value: CatalogueActionStatus = await response.json();
			if (value.administratorId === status.administratorId) undo = value.undo;
		}
	}
	function acknowledgementMessage(result: CatalogueActionResult) {
		const ack = result.acknowledgement;
		if (ack.kind === 'undo')
			return result.undo
				? 'That Undo request was completed earlier. The latest action is shown above.'
				: 'Last action undone.';
		if (ack.effective && result.undo?.actionId !== ack.actionId)
			return 'This request was completed earlier. It is no longer the latest undoable action.';
		if (ack.kind === 'delete')
			return `${ack.productCount} ${ack.productCount === 1 ? 'idea deleted' : 'ideas deleted'}. You can undo this action.`;
		if (!ack.effective) return 'These ideas were already on the selected lists. Nothing changed.';
		return `Added ${ack.productCount} ${ack.productCount === 1 ? 'idea' : 'ideas'} (${ack.entryCount} new ${ack.entryCount === 1 ? 'list entry' : 'list entries'}).`;
	}
	async function readActionResponse(current: Pending) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 12_000);
		try {
			const response = await fetch(
				current.endpoint === 'undo' ? '/api/catalogue-actions/undo' : '/api/catalogue-actions',
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(current.body),
					signal: controller.signal
				}
			);
			const value = await response.json();
			return { response, value };
		} catch {
			throw new Error(
				controller.signal.aborted
					? 'The confirmation took too long. Retry the same request to check its result.'
					: 'No confirmation was received. Retry the same request to check its result.'
			);
		} finally {
			clearTimeout(timeout);
		}
	}
	async function send(command?: Pending) {
		if (busy || !navigator.onLine || navigating.to) return;
		if (command) {
			if (pending) return;
			pending = command;
			try {
				sessionStorage.setItem(storageKey, JSON.stringify(command));
			} catch {
				pending = null;
				message =
					'This browser cannot retain an unconfirmed action. Enable browser storage and try again.';
				return;
			}
		}
		if (!pending) return;
		const current = pending;
		busy = true;
		message = '';
		signInRequired = false;
		try {
			const { response, value } = await readActionResponse(current);
			if (!response.ok) {
				const error = value as CatalogueActionError;
				if (response.status === 401 || response.status === 403) {
					signInRequired = true;
					message =
						'Sign in again as the same administrator, then retry this request to confirm its result.';
					return;
				}
				if (response.status < 500) {
					clearPending();
					if (error.reason === 'refresh-impact' && error.impact) {
						impact = error.impact;
						message = 'Review the current buying commitments before deleting.';
						return;
					}
					message = error.message ?? 'The action could not be completed.';
					if (error.reason === 'stale-undo') {
						await invalidateAll();
						await refreshStatus();
					}
					return;
				}
				throw new Error(
					'No confirmation was received. Retry the same request to check its result.'
				);
			}
			const result = value as CatalogueActionResult;
			if (
				result.administratorId !== status.administratorId ||
				result.acknowledgement?.operationId !== current.body.operationId
			)
				throw new Error('The action has not been confirmed. Retry this same request.');
			clearPending();
			undo = result.undo;
			selected = [];
			pickerOpen = false;
			impact = null;
			message = acknowledgementMessage(result);
			try {
				await invalidateAll();
			} catch {
				message += ' Refresh the page to load the updated catalogue.';
			}
			await focusStatus();
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'No confirmation was received. Retry the same request to check its result.';
		} finally {
			busy = false;
		}
	}
	function remove(ids: string[]) {
		if (disabled) return;
		targetIds = [...ids];
		message = '';
		void send({
			endpoint: 'action',
			body: { operationId: crypto.randomUUID(), kind: 'delete', productIds: [...ids] }
		});
	}
	function confirmDelete() {
		if (!impact || disabled) return;
		void send({
			endpoint: 'action',
			body: {
				operationId: crypto.randomUUID(),
				kind: 'delete',
				productIds: [...targetIds],
				impactFingerprint: impact.fingerprint
			}
		});
	}
</script>

<div class="catalogue-status" tabindex="-1" bind:this={statusRegion}>
	<div class="undo-line">
		<span
			>{#if undo}Last action: {undo.kind === 'add' ? 'added to lists' : 'deleted'} · {undo.productCount}
				{undo.productCount === 1 ? 'idea' : 'ideas'}{:else}Organise ideas here. Your last change can
				be undone.{/if}</span
		><button
			class="secondary"
			disabled={disabled || !undo}
			onclick={() =>
				undo &&
				send({
					endpoint: 'undo',
					body: { operationId: crypto.randomUUID(), expectedActionId: undo.actionId }
				})}>Undo last action</button
		>
	</div>
	{#if message}<p role={pending ? 'alert' : 'status'}>{message}</p>{/if}
	{#if signInRequired}<a href="/login">Sign in again</a>{/if}
	{#if !online && ready}<p class="muted">
			Connect to the internet to organise or delete ideas.
		</p>{/if}
	{#if pending && !pickerOpen && !impact}<button disabled={!online || busy} onclick={() => send()}
			>{busy ? 'Checking…' : 'Retry last request'}</button
		>{/if}
</div>
{#if products.length}<div class="selection-bar" class:has-selection={selected.length > 0}>
		<label
			><input
				type="checkbox"
				checked={allSelected}
				indeterminate={selected.length > 0 && !allSelected}
				{disabled}
				onchange={() => (selected = allSelected ? [] : products.map((product) => product.id))}
			/>Select all matching ideas</label
		>
		<strong>{selected.length} {selected.length === 1 ? 'idea' : 'ideas'} selected</strong>
		{#if selected.length}<div class="selection-buttons">
				<button {disabled} aria-label="Add selected to lists" onclick={() => add(selected)}
					>Add to lists</button
				><button
					class="secondary"
					{disabled}
					aria-label="Delete selected ideas"
					onclick={() => remove(selected)}>Delete</button
				><button class="quiet" {disabled} onclick={() => (selected = [])}>Clear</button>
			</div>{/if}
	</div>{/if}
{@render children({ selected, disabled, toggle, add, remove })}
<CatalogueListPicker
	open={pickerOpen}
	products={targets}
	{lists}
	{busy}
	{online}
	pending={!!pending}
	{message}
	{signInRequired}
	onclose={() => {
		if (!pending && !busy) {
			pickerOpen = false;
			message = '';
		}
	}}
	onsubmit={(ids) =>
		send({
			endpoint: 'action',
			body: {
				operationId: crypto.randomUUID(),
				kind: 'add',
				productIds: [...targetIds],
				listIds: ids
			}
		})}
	onretry={() => send()}
/>
<dialog
	bind:this={impactDialog}
	onkeydown={containDialogFocus}
	aria-labelledby="catalogue-delete-heading"
	oncancel={(event) => {
		event.preventDefault();
		if (!busy && !pending) {
			impact = null;
			message = '';
		}
	}}
>
	<h2 id="catalogue-delete-heading">Delete ideas with buying commitments?</h2>
	{#if impact}<p>
			{impact.allocatedCount} reserved or assigned {impact.allocatedCount === 1 ? 'gift' : 'gifts'} and
			{impact.purchasedCount} purchased {impact.purchasedCount === 1 ? 'gift' : 'gifts'} will be hidden
			from their lists and buyers.
		</p>
		<p>Their buying history and photos are kept for Undo.</p>{/if}
	{#if message}<p role="alert">{message}</p>{/if}
	{#if signInRequired}<a href="/login">Sign in again</a>{/if}
	<div class="confirmation-actions">
		<button
			class="secondary"
			disabled={busy || !!pending}
			onclick={() => {
				impact = null;
				message = '';
			}}>Cancel</button
		>{#if pending}<button disabled={busy || !online} onclick={() => send()}
				>{busy ? 'Checking…' : 'Retry last request'}</button
			>{:else}<button bind:this={confirmButton} {disabled} onclick={confirmDelete}
				>Delete these ideas</button
			>{/if}
	</div>
</dialog>

<style>
	.catalogue-status {
		border: 1px solid var(--line);
		border-radius: 0.7rem;
		padding: 0.8rem 1rem;
		margin: 1rem 0;
		background: var(--paper);
	}
	.undo-line {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}
	.undo-line span {
		font-size: 0.85rem;
		color: var(--muted);
	}
	.catalogue-status p {
		margin: 0.5rem 0 0;
		font-size: 0.9rem;
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
	.selection-buttons button {
		padding: 0.5rem 0.75rem;
	}
	dialog {
		max-width: 34rem;
		width: calc(100vw - 2rem);
		box-sizing: border-box;
		max-height: calc(100dvh - 2rem);
		overflow: auto;
		border: 1px solid var(--line);
		border-radius: 1rem;
		padding: 1.4rem;
		background: var(--paper);
		color: var(--ink);
	}
	dialog::backdrop {
		background: #172d3980;
	}
	.confirmation-actions {
		display: flex;
		justify-content: flex-end;
		flex-wrap: wrap;
		gap: 0.6rem;
		margin-top: 1.2rem;
	}
	@media (max-width: 600px) {
		.undo-line {
			align-items: flex-start;
			flex-direction: column;
			gap: 0.6rem;
		}
		.selection-bar {
			padding: 0.6rem;
			gap: 0.5rem;
		}
		.selection-buttons {
			margin: 0;
			width: 100%;
		}
		.selection-buttons button {
			flex: 1;
		}
		.selection-bar label {
			font-size: 0.8rem;
		}
	}
</style>
