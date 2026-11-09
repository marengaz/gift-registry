<script lang="ts">
	import { onMount, tick, type Snippet } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { navigating } from '$app/state';
	import { containDialogFocus } from '#lib/dialog-focus.ts';
	import type { GiftList } from '#lib/catalogue-types.ts';
	import type {
		ListDeleteCommand,
		ListDeletionImpact,
		ListDeletionAcknowledgement
	} from '#lib/shared/list-lifecycle.ts';

	type Target = { listId: string; listName: string; recipientName: string };
	type Pending = Target & {
		administratorId: string;
		url: string;
		body: string;
	} & (
			{ kind: 'delete'; productCount: number; orphanProductCount: number } | { kind: 'visibility' }
		);
	type Controls = {
		disabled: boolean;
		hide: (list: GiftList, trigger: HTMLElement) => void;
		remove: (list: GiftList, trigger: HTMLElement) => void;
	};
	let {
		administratorId,
		mutationDisabled = $bindable(false),
		children
	}: {
		administratorId: string;
		mutationDisabled?: boolean;
		children: Snippet<[Controls]>;
	} = $props();
	let ready = $state(false);
	let online = $state(false);
	let busy = $state(false);
	let message = $state('');
	let signInRequired = $state(false);
	let pending = $state<Pending | null>(null);
	let target = $state<Target | null>(null);
	let impact = $state<ListDeletionImpact | null>(null);
	let deleteOrphans = $state(false);
	let previewBusy = $state(false);
	let dialog = $state<HTMLDialogElement>();
	let cancelButton = $state<HTMLButtonElement>();
	let statusRegion = $state<HTMLDivElement>();
	let trigger: HTMLElement | null = null;
	let previewController: AbortController | null = null;
	const storageKey = $derived(`family-gifts-list-pending:${administratorId}`);
	const disabled = $derived(
		!ready || !online || busy || previewBusy || !!target || !!pending || !!navigating.to
	);
	$effect(() => {
		mutationDisabled = disabled;
	});
	$effect(() => {
		if (!dialog) return;
		if (target && !dialog.open) {
			dialog.showModal();
			void tick().then(() => cancelButton?.focus());
		} else if (!target && dialog.open) dialog.close();
	});

	function count(value: unknown): value is number {
		return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
	}
	function validImpact(value: unknown, listId: string): value is ListDeletionImpact {
		if (!value || typeof value !== 'object') return false;
		const item = value as ListDeletionImpact;
		return (
			item.administratorId === administratorId &&
			item.listId === listId &&
			typeof item.listName === 'string' &&
			typeof item.recipientName === 'string' &&
			typeof item.fingerprint === 'string' &&
			item.fingerprint.length > 0 &&
			count(item.productCount) &&
			count(item.orphanProductCount) &&
			item.orphanProductCount <= item.productCount &&
			count(item.allocatedCount) &&
			count(item.purchasedCount)
		);
	}
	function savedCommand(value: unknown): value is Pending {
		if (!value || typeof value !== 'object') return false;
		const item = value as Pending;
		if (
			item.administratorId !== administratorId ||
			typeof item.listId !== 'string' ||
			typeof item.listName !== 'string' ||
			typeof item.recipientName !== 'string' ||
			item.url !== `/api/lists/${encodeURIComponent(item.listId)}` ||
			typeof item.body !== 'string'
		)
			return false;
		try {
			const body = JSON.parse(item.body);
			if (item.kind === 'visibility')
				return typeof body.archived === 'boolean' && Object.keys(body).length === 1;
			return (
				item.kind === 'delete' &&
				/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(
					body.operationId
				) &&
				typeof body.deleteOrphans === 'boolean' &&
				typeof body.impactFingerprint === 'string' &&
				body.impactFingerprint.length > 0 &&
				Object.keys(body).length === 3 &&
				count(item.productCount) &&
				count(item.orphanProductCount) &&
				item.orphanProductCount <= item.productCount
			);
		} catch {
			return false;
		}
	}
	onMount(() => {
		online = navigator.onLine;
		try {
			const stored = sessionStorage.getItem(storageKey);
			if (stored) {
				const value: unknown = JSON.parse(stored);
				if (savedCommand(value)) {
					pending = value;
					if (value.kind === 'delete') {
						target = value;
						deleteOrphans = JSON.parse(value.body).deleteOrphans;
					}
					message =
						'A previous request is awaiting confirmation. Retry the same request to check its result.';
				} else message = 'A saved list request could not be read. No request has been sent.';
			}
		} catch {
			message =
				'Browser storage is unavailable. No new list changes will be sent unless their request can be saved.';
		}
		ready = true;
		const update = () => (online = navigator.onLine);
		window.addEventListener('online', update);
		window.addEventListener('offline', update);
		return () => {
			previewController?.abort();
			window.removeEventListener('online', update);
			window.removeEventListener('offline', update);
		};
	});
	async function read(url: string, options: RequestInit = {}) {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(
					new Error('The confirmation took too long. Retry the same request to check its result.')
				);
			}, 12_000);
		});
		try {
			return await Promise.race([
				deadline,
				(async () => {
					const response = await fetch(url, {
						...options,
						cache: 'no-store',
						signal: options.signal
							? AbortSignal.any([controller.signal, options.signal])
							: controller.signal
					});
					let value: unknown = null;
					try {
						value = await response.json();
					} catch {
						/* An unreadable reply cannot acknowledge a write. */
					}
					return { response, value };
				})()
			]);
		} catch (error) {
			if (controller.signal.aborted && error instanceof Error) throw error;
			throw new Error('No confirmation was received. Retry the same request to check its result.');
		} finally {
			clearTimeout(timer!);
		}
	}
	function clearPending() {
		pending = null;
		try {
			sessionStorage.removeItem(storageKey);
		} catch {}
	}
	async function focusAfterChange() {
		await tick();
		if (trigger?.isConnected) trigger.focus();
		else statusRegion?.focus();
	}
	function closePreview() {
		if (busy || pending) return;
		previewController?.abort();
		previewController = null;
		previewBusy = false;
		target = null;
		impact = null;
		message = '';
		signInRequired = false;
		void focusAfterChange();
	}
	async function preview(current: Target) {
		previewController?.abort();
		const controller = new AbortController();
		previewController = controller;
		previewBusy = true;
		message = '';
		signInRequired = false;
		try {
			const { response, value } = await read(
				`/api/lists/${encodeURIComponent(current.listId)}/deletion-impact`,
				{ signal: controller.signal }
			);
			if (controller.signal.aborted) return;
			if (response.status === 401 || response.status === 403) {
				signInRequired = true;
				message = 'Sign in again as the same administrator to review this list.';
			} else if (response.ok && validImpact(value, current.listId)) impact = value;
			else
				message =
					response.status === 404
						? 'This list is no longer available.'
						: 'The list could not be reviewed. Try loading its details again.';
		} catch {
			if (!controller.signal.aborted) message = 'The list details could not be loaded. Try again.';
		} finally {
			if (previewController === controller) previewBusy = false;
		}
	}
	function remove(list: GiftList, source: HTMLElement) {
		if (disabled) return;
		trigger = source;
		deleteOrphans = false;
		impact = null;
		target = { listId: list.id, listName: list.name, recipientName: list.recipientName };
		void preview(target);
	}
	function hide(list: GiftList, source: HTMLElement) {
		if (disabled) return;
		trigger = source;
		void send({
			administratorId,
			kind: 'visibility',
			listId: list.id,
			listName: list.name,
			recipientName: list.recipientName,
			url: `/api/lists/${encodeURIComponent(list.id)}`,
			body: JSON.stringify({ archived: !list.archivedAt })
		});
	}
	function validAcknowledgement(
		value: unknown,
		current: Pending
	): value is ListDeletionAcknowledgement {
		if (!value || typeof value !== 'object' || current.kind !== 'delete') return false;
		const ack = value as ListDeletionAcknowledgement;
		const body: ListDeleteCommand = JSON.parse(current.body);
		return (
			ack.administratorId === administratorId &&
			ack.listId === current.listId &&
			ack.operationId === body.operationId &&
			ack.deleteOrphans === body.deleteOrphans &&
			count(ack.productCount) &&
			count(ack.deletedProductCount) &&
			count(ack.keptProductCount) &&
			ack.productCount === current.productCount &&
			ack.deletedProductCount === (body.deleteOrphans ? current.orphanProductCount : 0) &&
			ack.keptProductCount + ack.deletedProductCount === ack.productCount
		);
	}
	async function send(command?: Pending) {
		if (busy || !navigator.onLine || navigating.to) return;
		if (command) {
			if (pending) return;
			try {
				sessionStorage.setItem(storageKey, JSON.stringify(command));
			} catch {
				message =
					'This browser cannot retain an unconfirmed request. Enable browser storage and try again.';
				return;
			}
			pending = command;
		}
		if (!pending || pending.administratorId !== administratorId) return;
		const current = pending;
		busy = true;
		message = '';
		signInRequired = false;
		try {
			const { response, value } = await read(current.url, {
				method: current.kind === 'delete' ? 'DELETE' : 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: current.body
			});
			if (response.status === 401 || response.status === 403) {
				signInRequired = true;
				message =
					'Sign in again as the same administrator, then retry this request to confirm its result.';
				return;
			}
			if (!value || typeof value !== 'object')
				throw new Error(
					'The server returned an unreadable confirmation. Retry the same request to check its result.'
				);
			const failure = value as { reason?: string; message?: string; impact?: unknown };
			if (!response.ok) {
				if (
					response.status === 409 &&
					failure.reason === 'refresh-impact' &&
					validImpact(failure.impact, current.listId)
				) {
					clearPending();
					impact = failure.impact;
					message =
						'This list changed. Review the updated counts, then confirm again if you still want to delete it.';
					return;
				}
				if (response.status < 500) {
					clearPending();
					impact = null;
					message =
						response.status === 404
							? 'This list is no longer available.'
							: failure.reason === 'operation-reused'
								? 'This request could not be confirmed. Close this dialog and review the list again.'
								: 'The list change could not be completed. Review the list and try again.';
					return;
				}
				throw new Error(
					'No confirmation was received. Retry the same request to check its result.'
				);
			}
			if (current.kind === 'delete') {
				if (!validAcknowledgement(value, current))
					throw new Error(
						'This reply does not confirm the saved request. Retry the same request to check its result.'
					);
				message = `${current.listName} for ${current.recipientName} deleted. ${value.keptProductCount} ${value.keptProductCount === 1 ? 'idea kept' : 'ideas kept'}${value.deletedProductCount ? `; ${value.deletedProductCount} ${value.deletedProductCount === 1 ? 'idea deleted' : 'ideas deleted'}` : ''}.`;
			} else {
				const result = value as { ok?: boolean };
				const desired = JSON.parse(current.body).archived;
				if (result.ok !== true)
					throw new Error(
						'This reply does not confirm the saved request. Retry the same request to check its result.'
					);
				message = `${current.listName} for ${current.recipientName} ${desired ? 'hidden. Relatives can no longer open it.' : 'shown again.'}`;
			}
			clearPending();
			target = null;
			impact = null;
			try {
				await invalidateAll();
			} catch {
				message += ' Refresh the page to load the updated lists.';
			}
			busy = false;
			await focusAfterChange();
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'No confirmation was received. Retry the same request to check its result.';
		} finally {
			busy = false;
		}
	}
	function confirmDelete() {
		if (!target || !impact || pending || busy || previewBusy) return;
		void send({
			...target,
			administratorId,
			kind: 'delete',
			url: `/api/lists/${encodeURIComponent(target.listId)}`,
			body: JSON.stringify({
				operationId: crypto.randomUUID(),
				deleteOrphans,
				impactFingerprint: impact.fingerprint
			} satisfies ListDeleteCommand),
			productCount: impact.productCount,
			orphanProductCount: impact.orphanProductCount
		});
	}
</script>

<div class="list-lifecycle-status" tabindex="-1" bind:this={statusRegion}>
	{#if message}<p role={pending ? 'alert' : 'status'}>{message}</p>{/if}
	{#if signInRequired && !target}<a href="/login">Sign in again</a>{/if}
	{#if pending && !target}<button disabled={!online || busy} onclick={() => send()}
			>{busy ? 'Checking…' : 'Retry last request'}</button
		>{/if}
	{#if !online && ready}<p class="muted">Connect to the internet to change lists.</p>{/if}
</div>
{@render children({ disabled, hide, remove })}
<dialog
	bind:this={dialog}
	onkeydown={containDialogFocus}
	aria-labelledby="list-delete-heading"
	oncancel={(event) => {
		event.preventDefault();
		closePreview();
	}}
>
	<h2 id="list-delete-heading">Delete {target?.listName} for {target?.recipientName}?</h2>
	{#if previewBusy}<p role="status">Loading the current list details…</p>{/if}
	{#if impact}
		<p>
			{impact.productCount} {impact.productCount === 1 ? 'idea is' : 'ideas are'} on this list.
		</p>
		<p>
			{impact.allocatedCount} reserved or assigned {impact.allocatedCount === 1 ? 'gift' : 'gifts'} and
			{impact.purchasedCount} purchased {impact.purchasedCount === 1 ? 'gift' : 'gifts'} will disappear
			from this list. Their buying history is retained.
		</p>
		<p>
			<strong>Keep ideas</strong> is the default. Kept ideas remain in the catalogue and on their other
			lists.
		</p>
		<label class="cleanup-choice"
			><input type="checkbox" bind:checked={deleteOrphans} disabled={busy || !!pending} />Delete
			ideas left on no other list ({impact.orphanProductCount})</label
		>
		<p class="muted">
			Ideas on another list, including a hidden list, are kept. Deleting a list cannot be undone
			here.
		</p>
	{:else if pending?.kind === 'delete'}
		<p>
			The saved request concerns {pending.productCount}
			{pending.productCount === 1 ? 'idea' : 'ideas'}. {deleteOrphans
				? `It deletes up to ${pending.orphanProductCount} ideas left on no other list.`
				: 'It keeps the ideas.'}
		</p>
		<p>
			The result is not yet confirmed. Retry this exact request before making another list change.
		</p>
	{/if}
	{#if message}<p role="alert">{message}</p>{/if}
	{#if signInRequired}<a href="/login">Sign in again</a>{/if}
	<div class="confirmation-actions">
		<button
			bind:this={cancelButton}
			class="secondary"
			disabled={busy || !!pending}
			onclick={closePreview}>Cancel</button
		>
		{#if pending}<button disabled={busy || !online} onclick={() => send()}
				>{busy ? 'Checking…' : 'Retry last request'}</button
			>
		{:else if impact}<button disabled={busy || !online || previewBusy} onclick={confirmDelete}
				>Delete list</button
			>
		{:else if target}<button
				disabled={!online || previewBusy}
				onclick={() => target && preview(target)}>Load list details again</button
			>{/if}
	</div>
	{#if pending}<p>
			<a href="/catalogue">Browse ideas while this request is awaiting confirmation</a>
		</p>{/if}
</dialog>

<style>
	.list-lifecycle-status {
		margin: 0.8rem 0;
	}
	.list-lifecycle-status:focus {
		outline: 2px solid var(--accent, #356345);
		outline-offset: 0.3rem;
	}
	.list-lifecycle-status p {
		margin: 0.5rem 0;
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
	dialog h2 {
		overflow-wrap: anywhere;
	}
	.cleanup-choice {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
	}
	.cleanup-choice input {
		flex-shrink: 0;
		margin-top: 0.25rem;
	}
	.confirmation-actions {
		display: flex;
		justify-content: flex-end;
		flex-wrap: wrap;
		gap: 0.6rem;
		margin-top: 1.2rem;
	}
</style>
