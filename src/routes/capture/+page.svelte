<script lang="ts">
	import { onMount } from 'svelte';
	import { liveQuery } from 'dexie';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { importBrowserCapture } from '#lib/client/browser-capture.ts';
	import CaptureEditor from '#lib/components/CaptureEditor.svelte';
	import DraftPreview from '#lib/components/DraftPreview.svelte';
	import { emptyDraft, captureTitle } from '#lib/catalogue-types.ts';
	import {
		draftStore,
		requestPersistentStorage,
		type CaptureContext,
		type LocalDraft
	} from '#lib/client/drafts.ts';
	import { refreshCaptureIdentity, syncDrafts } from '#lib/client/sync.ts';
	import { registerCapturePreparation } from '#lib/client/capture-session.ts';
	let context = $state<CaptureContext | undefined>();
	let loading = $state(true);
	let busy = $state(false);
	let localSaving = $state(false);
	let localSaveTask: Promise<void> | undefined;
	let localError = $state('');
	let showContinuation = $state(true);
	let message = $state('');
	let browserImportError = $state('');
	let storage = $state('');
	let current = $state<LocalDraft | undefined>();
	let records = $state<LocalDraft[]>([]);
	let imports = $state<LocalDraft[]>([]);
	let draft = $state(emptyDraft());
	let photos = $state<File[]>([]);
	let formOwner = $state<string | null>(null);
	let initialised = false;
	let firstIdentityPending = $state(false);
	let refreshing = false;
	let changingOwner = $state(false);
	let editorReady = $state(true);
	let baseline = $state(JSON.stringify(emptyDraft()));
	let baselinePhotos = $state<File[]>([]);
	let lastRequestedDraft = $state<string | null>(null);
	let openVersion = 0;
	let requestedListPending = $state<string | null>(null);
	function applyRequestedList() {
		if (
			current ||
			!requestedListPending ||
			!context?.lists.some((list) => list.id === requestedListPending)
		)
			return;
		draft.listIds = [requestedListPending];
		baseline = JSON.stringify({ ...JSON.parse(baseline), listIds: [requestedListPending] });
		requestedListPending = null;
	}
	let releaseEditor: (() => Promise<void>) | undefined;
	let destroyed = false;
	const editorToken = crypto.randomUUID();
	const lists = $derived(context?.lists ?? []);
	const allowed = $derived(!context || context.administrator || lists.length > 0);
	const blocked = $derived(changingOwner || (!!formOwner && formOwner !== context?.ownerId));
	const dirty = $derived(
		JSON.stringify(draft) !== baseline ||
			photos.length !== baselinePhotos.length ||
			photos.some((photo, index) => photo !== baselinePhotos[index])
	);
	const savedId = $derived(!dirty ? (current?.ack?.productId ?? '') : '');
	const continuationTargets = $derived(
		[...records, ...imports]
			.filter(
				(record) =>
					record.id !== current?.id &&
					!record.attemptedAt &&
					record.status === 'local' &&
					(record.readyToSync === false || record.draft.browserCapture?.pendingReview === true)
			)
			.slice(0, 5)
	);
	async function keepLocally(incomingShare?: boolean) {
		if (localSaveTask) await localSaveTask;
		if (blocked || !editorReady || current?.attemptedAt || !hasContents()) return;
		const version = openVersion,
			ownerId = formOwner;
		const snapshot = JSON.stringify(draft),
			files = [...photos];
		localSaving = true;
		localSaveTask = (async () => {
			try {
				const kept = await draftStore.save({
					id: current?.id,
					ownerId,
					draft: JSON.parse(snapshot),
					photos: files,
					editorToken,
					submit: false,
					incomingShare
				});
				if (!sameForm(version, ownerId)) return;
				current = kept;
				if (
					JSON.stringify(draft) === snapshot &&
					photos.length === files.length &&
					photos.every((file, index) => file === files[index])
				)
					markClean();
				localError = '';
				await lock();
			} catch (error) {
				if (sameForm(version, ownerId))
					localError =
						error instanceof Error && error.name === 'QuotaExceededError'
							? 'Device storage is full. This idea has not been kept. Keep this page open and free some storage.'
							: 'This idea could not be kept on this device. Keep the page open and try again.';
				throw error;
			} finally {
				localSaving = false;
			}
		})();
		try {
			await localSaveTask;
		} finally {
			localSaveTask = undefined;
		}
	}
	$effect(() => {
		const changed = dirty;
		if (
			loading ||
			busy ||
			localSaving ||
			blocked ||
			!editorReady ||
			firstIdentityPending ||
			!changed ||
			!hasContents() ||
			current?.attemptedAt ||
			current?.status === 'saved'
		)
			return;
		const version = openVersion;
		const timer = setTimeout(() => {
			if (version === openVersion && !busy) void keepLocally().catch(() => {});
		}, 400);
		return () => clearTimeout(timer);
	});
	async function keepForLater() {
		if (busy || blocked || !hasContents()) return;
		busy = true;
		try {
			await keepLocally(false);
			if (localError) return;
			await unlock();
			reset();
			await goto('/capture', { replace: true });
			message =
				'Kept on this device. Choose the idea below to continue it; it will not send until you save.';
		} catch {
		} finally {
			busy = false;
		}
	}
	async function attachTo(target: LocalDraft) {
		if (busy || blocked || !current || current.ownerId) return;
		busy = true;
		try {
			await keepLocally();
			const incoming = current.id;
			if (target.ownerId) {
				const person = await refreshCaptureIdentity();
				if (person?.id !== target.ownerId)
					throw new Error('Sign in as the idea’s author before adding the screenshot.');
			}
			await unlock();
			const merged = await draftStore.attachIncoming(incoming, target.id, target.ownerId);
			current = merged;
			formOwner = merged.ownerId;
			draft = merged.draft;
			photos = await draftStore.files(merged.id, merged.ownerId);
			showContinuation = false;
			markClean();
			await lock();
			await goto('/capture?draft=' + encodeURIComponent(merged.id), { replace: true });
			message = 'Screenshot added to this idea. Your link, edits and lists are kept.';
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'The screenshot could not be attached. Both drafts are kept.';
			await lock();
		} finally {
			busy = false;
		}
	}
	function markClean() {
		baseline = JSON.stringify(draft);
		baselinePhotos = [...photos];
	}
	function hasContents() {
		return !!(
			draft.title ||
			draft.sourceUrl ||
			draft.sourceText ||
			draft.description ||
			draft.variant ||
			draft.labels ||
			draft.offers.length ||
			photos.length
		);
	}
	async function unlock() {
		const release = releaseEditor;
		releaseEditor = undefined;
		if (release) await release();
	}
	function sameForm(version: number, ownerId: string | null) {
		return (
			!destroyed &&
			version === openVersion &&
			formOwner === ownerId &&
			(!ownerId || context?.ownerId === ownerId)
		);
	}
	async function lock() {
		const record = current;
		if (!record || record.attemptedAt || record.status === 'saved' || releaseEditor) return;
		const version = openVersion;
		const ownerId = formOwner;
		editorReady = false;
		const release = await draftStore.lockEditor(record.id, record.ownerId, editorToken);
		if (!sameForm(version, ownerId)) {
			if (release) await release();
			return;
		}
		releaseEditor = release;
		editorReady = !!release;
		if (!editorReady) {
			const updated = await draftStore.get(record.id, record.ownerId);
			if (!sameForm(version, ownerId)) return;
			current = updated;
			message =
				'This draft is being checked or edited in another tab. Close that editor, then reopen this draft.';
		}
	}
	async function prepareSignOut() {
		if (localSaveTask) await localSaveTask;
		if (loading || busy || blocked)
			throw new Error(
				'Finish saving or recover the unfinished idea with its original account before signing out.'
			);
		firstIdentityPending = false;
		const version = ++openVersion;
		const ownerId = formOwner;
		busy = true;
		try {
			if (dirty && hasContents()) {
				if (current?.attemptedAt)
					throw new Error('Keep the unsaved edits on this page before signing out.');
				const record = await draftStore.save({
					id: current?.id,
					ownerId,
					draft,
					photos,
					editorToken,
					submit: false
				});
				if (!sameForm(version, ownerId))
					throw new Error('The account changed. Review its drafts before signing out.');
				current = record;
				markClean();
			}
			await unlock();
		} catch (reason) {
			if (sameForm(version, ownerId)) {
				await lock();
				busy = false;
			}
			throw new Error(
				reason instanceof Error && reason.name === 'QuotaExceededError'
					? 'Device storage is full. The unfinished idea could not be saved. Keep this page open and free storage before signing out.'
					: reason instanceof Error
						? reason.message
						: 'The unfinished idea could not be saved. Keep this page open before signing out.'
			);
		}
		return async () => {
			if (sameForm(version, ownerId)) {
				await lock();
				busy = false;
			}
		};
	}
	async function preserveOwner() {
		if (localSaveTask) {
			try {
				await localSaveTask;
			} catch {}
		}
		if (changingOwner || !formOwner || formOwner === context?.ownerId) return;
		changingOwner = true;
		openVersion++;
		try {
			if (dirty && current?.attemptedAt)
				throw new Error('Unsaved recovery remains with its author.');
			if (hasContents() && (!current || (!current.attemptedAt && current.status !== 'saved'))) {
				await draftStore.save({
					id: current?.id,
					ownerId: formOwner,
					draft,
					photos,
					preserve: true,
					submit: false
				});
			}
			await unlock();
			reset();
			lastRequestedDraft = null;
			message =
				'The account changed. Your previous unfinished idea remains on this device under its original account.';
		} catch {
			message =
				'The account changed and device storage could not preserve the unfinished idea. It is held on this page for its original account. Sign back in as that account and free device storage before saving. Keep this page open.';
		} finally {
			changingOwner = false;
		}
	}
	async function open(id: string) {
		if (localSaveTask) {
			try {
				await localSaveTask;
			} catch {}
		}
		firstIdentityPending = false;
		if (
			busy ||
			blocked ||
			(dirty &&
				hasContents() &&
				!confirm('Discard the unsaved changes on this page and open another draft?'))
		)
			return;
		const version = ++openVersion;
		const ownerId = context?.ownerId;
		try {
			await unlock();
			const record =
				(ownerId ? await draftStore.get(id, ownerId) : undefined) ??
				(await draftStore.get(id, null));
			const files =
				record && record.status !== 'saved' ? await draftStore.files(id, record.ownerId) : [];
			if (version !== openVersion || ownerId !== context?.ownerId || destroyed) return;
			if (!record) {
				message = 'This draft is not available to this account. Sign in as its author.';
				return;
			}
			firstIdentityPending = false;
			current = record;
			formOwner = record.ownerId;
			draft = record.draft;
			photos = files;
			showContinuation = true;
			markClean();
			editorReady = true;
			message = record.message ?? '';
			await lock();
			if (
				version === openVersion &&
				ownerId === context?.ownerId &&
				record.attemptedAt &&
				navigator.onLine
			)
				void retry();
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
		if (requested && requested !== current?.id) void open(requested);
	});
	async function reconnect() {
		if (busy || refreshing || blocked || !navigator.onLine) return;
		let version = openVersion;
		let ownerId = formOwner;
		const firstRefresh = firstIdentityPending;
		refreshing = true;
		try {
			const person = await refreshCaptureIdentity();
			if (firstRefresh && firstIdentityPending) {
				firstIdentityPending = false;
				if (
					person?.member &&
					!busy &&
					!current &&
					!destroyed &&
					(version === openVersion || formOwner === person.id)
				) {
					const active = await draftStore.current();
					if (
						active?.ownerId === person.id &&
						!busy &&
						!current &&
						!destroyed &&
						(version === openVersion || formOwner === person.id) &&
						(!formOwner || formOwner === person.id)
					) {
						if (!formOwner) {
							openVersion++;
							formOwner = person.id;
							busy = false;
						}
						context = active;
						version = openVersion;
						ownerId = formOwner;
						applyRequestedList();
					}
				}
			}
			if (!person?.member || !sameForm(version, ownerId) || dirty) return;
			busy = true;
			const target = current;
			await unlock();
			if (!sameForm(version, ownerId)) return;
			await syncDrafts(draftStore, fetch, context?.ownerId);
			if (!sameForm(version, ownerId)) return;
			const updated = target ? await draftStore.get(target.id, target.ownerId) : undefined;
			if (!sameForm(version, ownerId)) return;
			if (target) current = updated;
			await lock();
		} catch {
			if (firstRefresh) firstIdentityPending = false;
			if (sameForm(version, ownerId))
				message = 'You are offline. Save an idea on this device and synchronise when connected.';
		} finally {
			refreshing = false;
			if (sameForm(version, ownerId)) busy = false;
		}
	}
	onMount(() => {
		const unregisterPreparation = registerCapturePreparation(prepareSignOut);
		const subscription = liveQuery(async () => {
			const active = await draftStore.current();
			return {
				active,
				own: active ? await draftStore.list(active.ownerId) : [],
				unbound: await draftStore.list(null)
			};
		}).subscribe({
			next(value) {
				const previousOwner = context?.ownerId;
				context = value.active;
				if (initialised && previousOwner !== context?.ownerId) lastRequestedDraft = null;
				if (initialised && !busy && !formOwner && context?.ownerId && !current && !hasContents()) {
					openVersion++;
					busy = false;
					formOwner = context.ownerId;
				}
				applyRequestedList();
				records = value.own;
				imports = value.unbound;
				if (initialised && formOwner && formOwner !== context?.ownerId) {
					void preserveOwner();
					return;
				}
				const updated = [...records, ...imports].find((record) => record.id === current?.id);
				if (updated) {
					current = updated;
					if (updated.ack && dirty)
						message =
							'An earlier version was saved. Your newer edits remain on this page; keep them before leaving or adding another idea.';
					else if (updated.message) message = updated.message;
				}
			},
			error() {
				message =
					'Local storage is unavailable. Keep this page open and free some device storage before trying again.';
			}
		});
		void (async () => {
			if (page.url.hash.startsWith('#gift=')) {
				try {
					const imported = await importBrowserCapture(page.url.hash);
					await goto(`/capture?draft=${encodeURIComponent(imported.id)}`, { replace: true });
				} catch (error) {
					browserImportError =
						error instanceof Error && error.name === 'QuotaExceededError'
							? 'Device storage is full. Keep this page open, free storage, then refresh to keep the browser capture.'
							: error instanceof Error
								? error.message
								: 'This browser capture could not be kept. Open the shop and choose Save gift again.';
				}
			}
			try {
				context = await draftStore.current();
				requestedListPending = page.url.searchParams.get('list');
				formOwner = context?.ownerId ?? null;
				firstIdentityPending = !context && navigator.onLine;
				initialised = true;
				const requestedDraft = page.url.searchParams.get('draft');
				lastRequestedDraft = requestedDraft;
				if (requestedDraft) await open(requestedDraft);
				else {
					applyRequestedList();
					markClean();
				}
			} catch {
				message = 'Local storage could not be opened. Keep your idea on this page and try again.';
			} finally {
				loading = false;
			}
			void requestPersistentStorage().then((persistence) => {
				storage =
					persistence === 'persistent'
						? 'Persistent device storage granted.'
						: persistence === 'temporary'
							? 'Device storage is best effort. Your browser may remove it under storage pressure; synchronise when you can.'
							: 'Persistent storage is unavailable. Keep drafts on this device only until you can synchronise.';
			});
			void reconnect();
		})();
		const online = () => {
			void reconnect();
		};
		const leaving = (event: BeforeUnloadEvent) => {
			if (dirty && hasContents()) {
				event.preventDefault();
				event.returnValue = '';
			}
		};
		window.addEventListener('online', online);
		window.addEventListener('beforeunload', leaving);
		return () => {
			destroyed = true;
			unregisterPreparation();
			subscription.unsubscribe();
			window.removeEventListener('online', online);
			window.removeEventListener('beforeunload', leaving);
			void unlock();
		};
	});
	async function save() {
		if (busy || blocked || !editorReady) return;
		if (localSaveTask) {
			try {
				await localSaveTask;
			} catch {
				return;
			}
		}
		firstIdentityPending = false;
		let version = ++openVersion;
		let ownerId = formOwner;
		busy = true;
		message = '';
		try {
			if (navigator.onLine) {
				const person = await refreshCaptureIdentity();
				if (!sameForm(version, ownerId)) return;
				if (
					!person?.member ||
					(!person.administrator &&
						!person.lists.some((list) => !list.archivedAt && list.role === 'contributor'))
				)
					throw new Error(
						'Sign in with contributor access to save. Your idea remains on this device.'
					);
				if (ownerId && person.id !== ownerId)
					throw new Error('The account changed. Return to this idea’s author before saving.');
				if (!ownerId) {
					current = await draftStore.save({
						id: current?.id,
						ownerId: null,
						draft,
						photos,
						editorToken,
						submit: false,
						incomingShare: false
					});
					await unlock();
					current = await draftStore.adopt(current.id, person);
					formOwner = person.id;
					ownerId = person.id;
					context = await draftStore.current();
					version = ++openVersion;
					await lock();
				}
			}
			if (!ownerId) {
				busy = false;
				await keepLocally(false);
				message = 'Kept on this device. Sign in, review the account shown, then choose Save idea.';
				return;
			}
			if (!sameForm(version, ownerId)) return;
			if (draft.browserCapture) draft.browserCapture.pendingReview = false;
			if (
				!draft.title.trim() &&
				!draft.sourceUrl.trim() &&
				photos.length &&
				!draft.description.trim()
			)
				draft.title = 'Photo idea';
			const record = await draftStore.save({
				id: current?.id,
				ownerId,
				draft,
				photos,
				editorToken,
				submit: true,
				incomingShare: false
			});
			if (!sameForm(version, ownerId)) return;
			current = record;
			markClean();
			await lock();
			if (!sameForm(version, ownerId)) return;
			message = 'Saved on this device — will send when online.';
			if (navigator.onLine) {
				await unlock();
				if (!sameForm(version, ownerId)) return;
				await syncDrafts(draftStore, fetch, ownerId);
				if (!sameForm(version, ownerId)) return;
				current = await draftStore.get(record.id, ownerId);
				if (!sameForm(version, ownerId)) return;
				await lock();
			}
		} catch (error) {
			if (sameForm(version, ownerId)) {
				message =
					error instanceof Error && error.name === 'QuotaExceededError'
						? 'Device storage is full. This idea has not been saved on this device. Keep this page open, free storage and try again.'
						: error instanceof Error
							? error.message
							: 'Saving failed. Keep this page open and try again.';
				await lock();
			}
		} finally {
			if (sameForm(version, ownerId)) busy = false;
		}
	}
	async function retry() {
		const target = current;
		if (busy || blocked || !target?.ownerId) return;
		const version = openVersion;
		const ownerId = formOwner;
		busy = true;
		try {
			await unlock();
			if (!sameForm(version, ownerId)) return;
			await syncDrafts(draftStore, fetch, target.ownerId);
			if (!sameForm(version, ownerId)) return;
			const updated = await draftStore.get(target.id, target.ownerId);
			if (!sameForm(version, ownerId)) return;
			current = updated;
			await lock();
			if (sameForm(version, ownerId))
				message = updated?.message ?? 'Check the synchronisation status below.';
		} catch {
			if (sameForm(version, ownerId))
				message = 'Reconnect or sign in again, then retry. Your local draft is still here.';
		} finally {
			if (sameForm(version, ownerId)) busy = false;
		}
	}
	function reset() {
		openVersion++;
		busy = false;
		current = undefined;
		formOwner = context?.ownerId ?? null;
		draft = emptyDraft();
		photos = [];
		markClean();
		editorReady = true;
		message = '';
	}
	async function another() {
		if (localSaveTask) {
			try {
				await localSaveTask;
			} catch {
				return;
			}
		}
		if (
			blocked ||
			(dirty &&
				hasContents() &&
				!confirm('Discard the unsaved changes on this page and add another idea?'))
		)
			return;
		await unlock();
		reset();
	}
	const statusText = (record: LocalDraft) =>
		record.readyToSync === false && !record.attemptedAt
			? 'Draft'
			: {
					local: 'Waiting to send',
					queued: 'Waiting to send',
					syncing: 'Sending',
					saved: 'Saved to family catalogue',
					needsattention: 'Needs attention'
				}[record.status];
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
	{#if browserImportError}<p class="notice error" role="alert">{browserImportError}</p>{/if}
	{#if loading}<p role="status">Opening your capture drafts…</p>
	{:else if blocked}<section class="panel">
			<h2>Unfinished idea kept for its author</h2>
			<p>
				Sign back in as the original account to recover it. Keep this page open until it can be
				saved.
			</p>
		</section>
	{:else if savedId}<section class="panel">
			<h2>Idea saved</h2>
			<p>
				{draft.listIds.length > 1
					? 'One idea added to ' + draft.listIds.length + ' lists.'
					: draft.listIds.length === 1
						? 'Saved to ' +
							(lists.find((list) => list.id === draft.listIds[0])?.name ?? 'your selected list') +
							'.'
						: 'Saved to unlisted ideas.'}
			</p>
			<div class="heading-actions">
				<a class="button" href={`/products/${savedId}`}>View idea</a><button
					class="secondary"
					onclick={another}>Add another</button
				>
			</div>
		</section>
	{:else if allowed}
		{#if current?.incomingShare && !current.ownerId && photos.length && showContinuation && continuationTargets.length}
			<section class="panel" aria-label="Continue an existing idea">
				<h2>Use this with an existing idea?</h2>
				<p>Your screenshot is kept. Choose the idea it belongs to, or start a new idea.</p>
				{#each continuationTargets as target (target.id)}<div class="draft-row">
						<DraftPreview record={target} />
						<div>
							<button
								type="button"
								class="secondary"
								disabled={busy}
								onclick={() => attachTo(target)}>Add to {captureTitle(target.draft)}</button
							>
							<p class="muted">
								{target.draft.sourceUrl} · {new Date(target.updatedAt).toLocaleString('en-GB')}
							</p>
						</div>
					</div>{/each}
				<button
					type="button"
					class="quiet"
					disabled={busy}
					onclick={() => {
						showContinuation = false;
						void keepLocally(false).catch(() => {});
					}}>Start a new idea</button
				>
			</section>
		{/if}
		{#if current}<section class="panel">
				<h2>{statusText(current)}</h2>
				{#if !current.ownerId}<p>
						This idea is kept on this device. Check the account shown before choosing Save idea.
					</p>
					{#if !context}<a href="/login">Sign in</a>{/if}
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
			locked={!!current?.attemptedAt || busy || !editorReady || blocked}
			onSave={save}
			onKeep={keepForLater}
			onEnsureLocal={() => keepLocally()}
			localCapture
			canSynchronise={!!context?.ownerId && (!formOwner || formOwner === context.ownerId)}
			addingAs={context?.name ?? ''}
			onListsChanged={() => {
				requestedListPending = null;
			}}
		/>
		{#if !context && firstIdentityPending}<p class="notice" role="status">
				Checking your account. You can start writing now.
			</p>
		{:else if !context}<p class="notice">
				You can keep a draft on this device. Sign in with contributor access when you are ready to
				save it. <a href="/login">Sign in</a>
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
	{#if localError}<p class="notice error" role="alert">{localError}</p>
	{:else if localSaving}<p role="status" class="muted">Keeping this draft…</p>
	{:else if current && !current.attemptedAt && current.readyToSync === false}<p class="muted">
			Draft kept on this device.
		</p>{/if}
	{#if storage}<p class="muted storage-note">{storage}</p>{/if}
	{#if records.length || imports.length}<section class="panel">
			<h2>Drafts on this device</h2>
			<ul class="draft-list">
				{#each [...records, ...imports] as record (record.id)}<li>
						<DraftPreview {record} />
						<div>
							<button class="quiet" onclick={() => open(record.id)}
								>{captureTitle(record.draft)}</button
							><span>{statusText(record)}{!record.ownerId ? ' · sign in to save' : ''}</span>
						</div>
					</li>{/each}
			</ul>
		</section>{/if}
</main>

<style>
	.storage-note {
		font-size: 0.85rem;
	}
	.draft-list {
		padding: 0;
		list-style: none;
	}
	.draft-list li {
		margin-bottom: 0.65rem;
		display: flex;
		gap: 0.8rem;
	}
	.draft-row {
		display: flex;
		gap: 0.8rem;
		align-items: center;
		margin: 0.8rem 0;
		overflow-wrap: anywhere;
	}
	.draft-list span {
		display: block;
		font-size: 0.85rem;
	}
</style>
