<script lang="ts">
	import { onMount } from 'svelte';
	import { liveQuery } from 'dexie';
	import { page } from '$app/state';
	import CaptureEditor from '#lib/components/CaptureEditor.svelte';
	import { emptyDraft } from '#lib/catalogue-types.ts';
	import {
		draftStore,
		requestPersistentStorage,
		type CaptureContext,
		type LocalDraft
	} from '#lib/client/drafts.ts';
	import { refreshCaptureIdentity, syncDrafts } from '#lib/client/sync.ts';
	let context = $state<CaptureContext | undefined>();
	let loading = $state(true);
	let busy = $state(false);
	let message = $state('');
	let storage = $state('');
	let current = $state<LocalDraft | undefined>();
	let records = $state<LocalDraft[]>([]);
	let imports = $state<LocalDraft[]>([]);
	let draft = $state(emptyDraft());
	let photos = $state<File[]>([]);
	let lastRequestedDraft = $state<string | null>(null);
	let openVersion = 0;
	const lists = $derived(context?.lists ?? []);
	const allowed = $derived(!context || context.administrator || lists.length > 0);
	const savedId = $derived(current?.ack?.productId ?? '');
	async function open(id: string) {
		const version = ++openVersion;
		const ownerId = context?.ownerId;
		try {
			const record =
				(ownerId ? await draftStore.get(id, ownerId) : undefined) ??
				(await draftStore.get(id, null));
			const files =
				record && record.status !== 'saved' ? await draftStore.files(id, record.ownerId) : [];
			if (version !== openVersion || ownerId !== context?.ownerId) return;
			if (!record) {
				message = 'This draft is not available to this account. Sign in as its author.';
				return;
			}
			current = record;
			draft = record.draft;
			photos = files;
			message = record.message ?? '';
		} catch {
			if (version === openVersion && ownerId === context?.ownerId)
				message = 'Local storage could not open this draft. Keep this page open and try again.';
		}
	}
	$effect(() => {
		if (loading) return;
		const requested = page.url.searchParams.get('draft');
		if (requested === lastRequestedDraft) return;
		lastRequestedDraft = requested;
		if (requested) void open(requested);
	});
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
				if (current?.ownerId && current.ownerId !== context?.ownerId) another();
				const updated = [...records, ...imports].find((record) => record.id === current?.id);
				if (updated) {
					current = updated;
					if (updated.message) message = updated.message;
				}
			},
			error() {
				message =
					'Local storage is unavailable. Keep this page open and free some device storage before trying again.';
			}
		});
		void (async () => {
			try {
				try {
					await refreshCaptureIdentity();
				} catch {
					message = 'You are offline. Save an idea on this device and synchronise when connected.';
				}
				context = await draftStore.current();
				const requestedDraft = page.url.searchParams.get('draft');
				lastRequestedDraft = requestedDraft;
				if (requestedDraft) await open(requestedDraft);
				else {
					const requested = page.url.searchParams.get('list');
					if (requested && context?.lists.some((list) => list.id === requested))
						draft.listIds = [requested];
				}
				const persistence = await requestPersistentStorage();
				storage =
					persistence === 'persistent'
						? 'Persistent device storage granted.'
						: persistence === 'temporary'
							? 'Device storage is best effort. Your browser may remove it under storage pressure; synchronise when you can.'
							: 'Persistent storage is unavailable. Keep drafts on this device only until you can synchronise.';
				if (navigator.onLine && context) await syncDrafts(draftStore, fetch, context.ownerId);
			} catch {
				message = 'Local storage could not be opened. Keep your idea on this page and try again.';
			} finally {
				loading = false;
			}
		})();
		return () => subscription.unsubscribe();
	});
	async function save() {
		if (busy) return;
		busy = true;
		message = '';
		try {
			current = await draftStore.save({
				id: current?.id,
				ownerId: current ? current.ownerId : (context?.ownerId ?? null),
				draft,
				photos
			});
			message = current.ownerId
				? 'Saved on this device. Waiting to synchronise.'
				: 'Saved on this device without an account. Sign in, then explicitly adopt this draft.';
			if (navigator.onLine && current.ownerId) {
				await syncDrafts(draftStore, fetch, current.ownerId);
				current = await draftStore.get(current.id, current.ownerId);
			}
		} catch (error) {
			message =
				error instanceof Error && error.name === 'QuotaExceededError'
					? 'Device storage is full. This idea has not been saved on this device. Keep this page open, free storage and try again.'
					: error instanceof Error
						? error.message
						: 'Saving on this device failed. Keep this page open and try again.';
		} finally {
			busy = false;
		}
	}
	async function retry() {
		if (busy || !current?.ownerId) return;
		busy = true;
		try {
			await syncDrafts(draftStore, fetch, current.ownerId);
			current = await draftStore.get(current.id, current.ownerId);
			message = current?.message ?? 'Check the synchronisation status below.';
		} catch {
			message = 'Reconnect or sign in again, then retry. Your local draft is still here.';
		} finally {
			busy = false;
		}
	}
	async function adopt() {
		if (busy || !current || current.ownerId) return;
		busy = true;
		try {
			const person = await refreshCaptureIdentity();
			if (!person) throw new Error('Sign in before adopting this draft.');
			current = await draftStore.adopt(current.id, person);
			context = await draftStore.current();
			message =
				'This draft now belongs to your account. Review its lists, then save to synchronise.';
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Adoption needs a connection and current contributor access.';
		} finally {
			busy = false;
		}
	}
	function another() {
		openVersion++;
		current = undefined;
		draft = emptyDraft();
		photos = [];
		message = '';
	}
	const statusText = (status: LocalDraft['status']) =>
		({
			local: 'Saved on this device',
			queued: 'Queued',
			syncing: 'Synchronising',
			saved: 'Saved to family catalogue',
			needsattention: 'Needs attention'
		})[status];
</script>

<svelte:head><title>Add an idea · Family gifts</title></svelte:head>
<main class="narrow">
	<div class="page-heading">
		<div>
			<p class="eyebrow">Found something lovely?</p>
			<h1>Add an idea</h1>
			<p class="muted">
				A link, a photo or just a thought. Keep the details now and organise them as you go.
			</p>
		</div>
	</div>
	{#if loading}<p role="status">Opening your capture drafts…</p>
	{:else if savedId}<section class="panel">
			<h2>Idea saved</h2>
			<p>Your idea was acknowledged by the server.</p>
			<div class="heading-actions">
				<a class="button" href={`/products/${savedId}`}>View idea</a><button
					class="secondary"
					onclick={another}>Add another</button
				>
			</div>
		</section>
	{:else if allowed}
		{#if current}<section class="panel">
				<h2>{statusText(current.status)}</h2>
				{#if !current.ownerId}<p>
						This draft has no account. Sign in and choose to adopt it before synchronising.
					</p>
					<button disabled={busy} onclick={adopt}>Adopt with my signed-in account</button><a
						href="/login">Sign in</a
					>
				{:else if current.attemptedAt}<p>
						These details are held unchanged while we check whether the server saved them. Retry
						with the same account to avoid duplicates.
					</p>
					<button disabled={busy} onclick={retry}>Retry this idea</button>{/if}
				<button class="quiet" disabled={busy} onclick={another}>Add another idea</button>
			</section>{/if}
		<CaptureEditor
			bind:draft
			bind:photos
			{lists}
			{busy}
			locked={!!current?.attemptedAt}
			onSave={save}
			localCapture
		/>
		{#if !context}<p class="notice">
				You can keep an unbound draft on this device. Current contributor permission is required to
				synchronise it. <a href="/login">Sign in</a>
			</p>{/if}
	{:else}<section class="panel">
			<h2>Contributor access needed</h2>
			<p>
				Ask the administrator for contributor access to a list. Buyers and viewers can browse the
				lists shared with them.
			</p>
			<a class="button" href="/lists">View lists</a>
		</section>{/if}
	{#if message && !savedId}<p
			class="notice"
			role={current?.status === 'needsattention' ? 'alert' : 'status'}
		>
			{message}
		</p>{/if}
	{#if storage}<p class="muted storage-note">{storage}</p>{/if}
	{#if records.length || imports.length}<section class="panel">
			<h2>Ideas on this device</h2>
			<ul class="draft-list">
				{#each [...records, ...imports] as record}<li>
						<button class="quiet" onclick={() => open(record.id)}
							>{record.draft.title || 'Untitled idea'}</button
						><span>{statusText(record.status)}{!record.ownerId ? ' · account needed' : ''}</span>
					</li>{/each}
			</ul>
		</section>{/if}
</main>

<style>
	.storage-note {
		font-size: 0.85rem;
	}
	.draft-list {
		padding-left: 1rem;
	}
	.draft-list li {
		margin-bottom: 0.65rem;
	}
	.draft-list span {
		display: block;
		font-size: 0.85rem;
	}
</style>
