<script lang="ts">
	import { onMount } from 'svelte';
	import { liveQuery } from 'dexie';
	import { draftStore, type CaptureContext, type LocalDraft } from '#lib/client/drafts.ts';
	import { syncDrafts } from '#lib/client/sync.ts';
	let context = $state<CaptureContext | undefined>();
	let pending = $state<LocalDraft[]>([]);
	let unbound = $state(0);
	let offline = $state(false);
	let busy = $state(false);
	let error = $state('');
	let ready = $state(false);
	async function retry() {
		if (busy) return;
		busy = true;
		try {
			await syncDrafts(draftStore);
		} catch {
			error = 'Local storage could not be opened. Keep this page open and try again.';
		} finally {
			busy = false;
			ready = true;
		}
	}
	onMount(() => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const subscription = liveQuery(async () => {
			const active = await draftStore.current();
			return {
				active,
				records: active
					? (await draftStore.list(active.ownerId)).filter((record) => record.status !== 'saved')
					: [],
				imports: (await draftStore.list(null)).length
			};
		}).subscribe({
			next(value) {
				context = value.active;
				pending = value.records;
				unbound = value.imports;
				clearTimeout(timer);
				const lease = pending
					.filter((record) => record.status === 'syncing')
					.map((record) => record.leaseUntil ?? 0)
					.sort((a, b) => a - b)[0];
				if (lease)
					timer = setTimeout(
						() => {
							if (navigator.onLine) void retry();
						},
						Math.max(0, lease - Date.now()) + 100
					);
			},
			error() {
				error = 'Local storage is unavailable. Saving on this device needs attention.';
			}
		});
		const online = () => {
			offline = !navigator.onLine;
			if (!offline) void retry();
			else ready = true;
		};
		window.addEventListener('online', online);
		window.addEventListener('offline', online);
		online();
		return () => {
			subscription.unsubscribe();
			clearTimeout(timer);
			window.removeEventListener('online', online);
			window.removeEventListener('offline', online);
		};
	});
</script>

{#if ready && (pending.length || unbound || error)}
	<aside class="sync-status" aria-label="Capture synchronisation">
		{#if error}<p role="alert">{error}</p>{/if}
		{#if pending.length}<p role="status">
				{pending.length}
				{pending.length === 1 ? 'idea' : 'ideas'} pending for {context?.name}. {offline
					? 'Saved on this device; connect to synchronise.'
					: pending.some((record) => record.status === 'needsattention')
						? 'Some ideas need attention. Sign in as their author and check access before retrying.'
						: 'Waiting to synchronise.'}
			</p>
			<a href="/capture">Review drafts</a><button
				class="quiet"
				disabled={busy || offline}
				onclick={retry}>{busy ? 'Checking…' : 'Retry synchronisation'}</button
			>
		{/if}
		{#if unbound}<p>
				{unbound} unbound {unbound === 1 ? 'draft needs' : 'drafts need'} an account.
				<a href="/capture">Review and adopt</a>
			</p>{/if}
	</aside>
{/if}

<style>
	.sync-status {
		max-width: 78rem;
		margin: 0.75rem auto;
		padding: 0.8rem 1.25rem;
		background: #fff7df;
		border-radius: 0.6rem;
	}
	.sync-status p {
		margin: 0 0 0.35rem;
	}
	.sync-status button {
		margin-left: 0.7rem;
	}
</style>
