<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { CaptureDraft } from '#lib/catalogue-types.ts';
	import {
		applySuggestion,
		undoAutofill,
		type AutofillPatch
	} from '#lib/client/capture-autofill.ts';
	import type { ProductSuggestion } from '#lib/server/enrichment/types.ts';
	let {
		draft = $bindable(),
		photos = $bindable([]),
		disabled = false,
		ensureLocal
	}: {
		draft: CaptureDraft;
		photos?: File[];
		disabled?: boolean;
		ensureLocal?: () => Promise<void>;
	} = $props();
	let message = $state('');
	let busy = $state(false);
	let photoBusy = $state(false);
	let photoMessage = $state('');
	let blockedLink = $state(false);
	let allowAI = $state(true);
	let ai = $state({ configured: false, enabled: false });
	let selectedImage = $state(0);
	let choices = $state<ProductSuggestion[]>([]);
	let duplicates = $state<{ id: string; title: string }[]>([]);
	let duplicatesDismissed = $state(false);
	let patch = $state<AutofillPatch | null>(null);
	let patchDraft = $state.raw<CaptureDraft>();
	let choicesDraft = $state.raw<CaptureDraft>();
	let choicesSource = $state('');
	let renderedDraft: CaptureDraft | undefined;
	let importedPhoto: File | undefined;
	let autofillGeneration = 0;
	let attemptedDraft: CaptureDraft | undefined;
	let attemptedUrl = '';
	let attemptedPhotoDraft: CaptureDraft | undefined;
	let attemptedPhotoUrl = '';
	let lastOperation: { fingerprint: string; id: string } | undefined;
	let controller: AbortController | undefined;
	$effect(() => {
		const next = draft;
		untrack(() => {
			if (renderedDraft === next) return;
			renderedDraft = next;
			controller?.abort();
			message = '';
			photoMessage = '';
			blockedLink = false;
			choices = [];
			duplicates = [];
			duplicatesDismissed = false;
			patch = null;
			lastOperation = undefined;
		});
	});
	$effect(() => {
		if (selectedImage >= photos.length) selectedImage = 0;
	});

	onMount(() => {
		let disposed = false;
		void fetch('/api/capture-details', { cache: 'no-store' })
			.then(async (response) => {
				if (response.ok && !disposed) ai = await response.json();
			})
			.catch(() => {});
		return () => {
			disposed = true;
			controller?.abort();
		};
	});
	function evidence(candidate: ProductSuggestion) {
		const text = [
			(candidate.source === 'gemini'
				? 'Suggested details from supplied content'
				: 'Page details retrieved') +
				(candidate.sourceUrl ? ' from ' + candidate.sourceUrl : '') +
				' on ' +
				new Date(candidate.retrievedAt).toISOString() +
				'.',
			candidate.offer?.priceText
				? 'Observed ' +
					(candidate.offer.fromPrice ? 'from-price' : 'price') +
					': ' +
					candidate.offer.priceText +
					' ' +
					(candidate.offer.currency ?? '(currency missing)') +
					'.'
				: '',
			...candidate.uncertainty
		]
			.filter(Boolean)
			.join(' ');
		if (!draft.sourceText.includes(text))
			draft.sourceText = [draft.sourceText, text].filter(Boolean).join('\n');
	}
	async function useCandidate(candidate: ProductSuggestion, current: () => boolean) {
		if (!current()) return;
		const generation = ++autofillGeneration;
		choices = [];
		patch = applySuggestion(draft, candidate);
		patchDraft = draft;
		importedPhoto = undefined;
		evidence(candidate);
		message = [
			(candidate.source === 'gemini' ? 'Suggested details added.' : 'Imported available details.') +
				' Check the exact product and variant.',
			...candidate.uncertainty
		].join(' ');
		if (candidate.imageUrl && !photos.length && !draft.editedFields?.includes('photos')) {
			const selectedPhotos = photos;
			try {
				const image = await fetch('/api/metadata/image', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ url: candidate.imageUrl }),
					signal: AbortSignal.timeout(15000)
				});
				if (image.ok) {
					const blob = await image.blob();
					if (
						current() &&
						generation === autofillGeneration &&
						photos === selectedPhotos &&
						!photos.length &&
						!draft.editedFields?.includes('photos')
					) {
						importedPhoto = new File([blob], 'retailer-image.webp', { type: 'image/webp' });
						photos = [importedPhoto];
					}
				}
			} catch {
				if (current())
					photoMessage = 'The shop photo could not be copied. Add your own photo or screenshot.';
			}
		}
	}
	function undo() {
		autofillGeneration++;
		if (patch && patchDraft === draft) {
			undoAutofill(draft, patch);
			if (importedPhoto && !draft.editedFields?.includes('photos'))
				photos = photos.filter((photo) => photo !== importedPhoto);
		}
		patch = null;
		importedPhoto = undefined;
		message = 'Autofill undone. Your edits and list choices are kept.';
	}
	async function retrieve(url: string, explicit = false) {
		if (busy || disabled || !navigator.onLine) return;
		const requestedDraft = draft;
		const current = () => !disabled && draft === requestedDraft && draft.sourceUrl === url;
		const fingerprint = 'link:' + url + ':' + String(allowAI);
		if (!lastOperation || lastOperation.fingerprint !== fingerprint || explicit)
			lastOperation = { fingerprint, id: crypto.randomUUID() };
		controller?.abort();
		controller = new AbortController();
		busy = true;
		blockedLink = false;
		choices = [];
		patch = null;
		message = 'Reading product details…';
		try {
			await ensureLocal?.();
			if (!current()) return;
			void fetch('/api/capture-duplicates?url=' + encodeURIComponent(url), { cache: 'no-store' })
				.then(async (response) => {
					if (!response.ok) return;
					const result = await response.json();
					if (current()) {
						duplicates = result.matches ?? [];
						duplicatesDismissed = false;
					}
				})
				.catch(() => {});
			const response = await fetch('/api/metadata', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url, assist: allowAI, operationId: lastOperation.id }),
				signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)])
			});
			const result = await response.json();
			if (!current()) return;
			if (!response.ok) throw new Error(result.message);
			if (!result.suggestions?.length) {
				blockedLink = !result.aiUnavailable;
				message = result.aiUnavailable
					? result.message
					: "We couldn't read this shop page. Your link is kept. Add a screenshot showing the product and price, or save the idea as it is.";
				return;
			}
			if (result.suggestions.length > 1) {
				choicesDraft = draft;
				choicesSource = draft.sourceUrl;
				choices = result.suggestions;
				message = 'Which item? Choose the product you mean before filling its details.';
			} else {
				await useCandidate(result.suggestions[0], current);
				if (current() && result.aiUnavailable) message += ' ' + result.message;
			}
		} catch (error) {
			if (current()) {
				blockedLink = true;
				message =
					error instanceof Error && error.name !== 'TimeoutError' && error.name !== 'AbortError'
						? error.message
						: 'This shop took too long to respond. Your link is kept; retry or add a screenshot.';
			}
		} finally {
			busy = false;
		}
	}
	async function fill(kind: 'image' | 'text') {
		if (busy || disabled) return;
		if (!navigator.onLine) {
			message = 'Go online to fill details. Your idea can still be kept on this device.';
			return;
		}
		const file = kind === 'image' ? photos[selectedImage] : undefined;
		const text = draft.sourceText;
		if ((kind === 'image' && !file) || (kind === 'text' && !text.trim())) return;
		const requestedDraft = draft,
			sourceUrl = draft.sourceUrl;
		let applied = false;
		const current = () =>
			!disabled &&
			draft === requestedDraft &&
			draft.sourceUrl === sourceUrl &&
			(kind === 'image'
				? photos.includes(file!) && photos[selectedImage] === file
				: applied || draft.sourceText === text);
		const fingerprint =
			kind +
			':' +
			sourceUrl +
			':' +
			(file ? file.name + ':' + file.size + ':' + file.lastModified : text);
		if (!lastOperation || lastOperation.fingerprint !== fingerprint)
			lastOperation = { fingerprint, id: crypto.randomUUID() };
		controller?.abort();
		controller = new AbortController();
		busy = true;
		choices = [];
		patch = null;
		message = 'Reading the supplied ' + kind + '…';
		try {
			await ensureLocal?.();
			if (!current()) return;
			const body = new FormData();
			body.set('operationId', lastOperation.id);
			body.set('kind', kind);
			if (file) body.set('image', file);
			else body.set('text', text);
			if (sourceUrl) body.set('sourceUrl', sourceUrl);
			const response = await fetch('/api/capture-details', {
				method: 'POST',
				body,
				signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)])
			});
			const result = await response.json();
			if (!current()) return;
			if (!response.ok) throw new Error(result.message);
			if (result.failure) lastOperation = undefined;
			if (result.ambiguity || result.suggestions?.length > 1) {
				choicesDraft = draft;
				choicesSource = draft.sourceUrl;
				choices = result.suggestions ?? [];
				message =
					'More than one item or price is visible. Crop the image to one product and try again, or choose an item below.';
			} else if (result.suggestions?.length) {
				applied = true;
				await useCandidate(result.suggestions[0], current);
			} else
				message =
					result.message || 'No reliable details were found. Keep what you know and save the idea.';
		} catch (error) {
			if (current())
				message =
					error instanceof Error && error.name !== 'TimeoutError'
						? error.message
						: 'Reading details took too long. Keep this idea and try again later.';
		} finally {
			busy = false;
		}
	}
	async function importBrowserPhoto() {
		const requestedDraft = draft,
			capture = draft.browserCapture,
			url = capture?.imageUrl;
		if (!url || disabled || photoBusy || photos.length || capture.sourceUrl !== draft.sourceUrl)
			return;
		if (!navigator.onLine) {
			photoMessage = 'Go online to copy the shop photo, or add your own.';
			return;
		}
		const selectedPhotos = photos;
		const current = () =>
			!disabled &&
			draft === requestedDraft &&
			draft.sourceUrl === capture.sourceUrl &&
			draft.browserCapture?.imageUrl === url;
		photoBusy = true;
		photoMessage = '';
		try {
			const response = await fetch('/api/metadata/image', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url })
			});
			if (!response.ok)
				throw new Error('The shop photo could not be copied. Retry, or add your own photo.');
			const blob = await response.blob();
			if (
				current() &&
				photos === selectedPhotos &&
				!photos.length &&
				!draft.editedFields?.includes('photos')
			) {
				photos = [new File([blob], 'browser-image.webp', { type: 'image/webp' })];
				capture.imageUrl = '';
			}
		} catch (error) {
			if (current())
				photoMessage =
					error instanceof Error ? error.message : 'The shop photo could not be copied.';
		} finally {
			photoBusy = false;
		}
	}
	$effect(() => {
		const capture = draft.browserCapture;
		if (
			!capture?.imageUrl ||
			photoBusy ||
			disabled ||
			photos.length ||
			capture.sourceUrl !== draft.sourceUrl ||
			(attemptedPhotoDraft === draft && attemptedPhotoUrl === capture.imageUrl)
		)
			return;
		untrack(() => {
			attemptedPhotoDraft = draft;
			attemptedPhotoUrl = capture.imageUrl;
			void importBrowserPhoto();
		});
	});
	$effect(() => {
		const url = draft.sourceUrl;
		if (
			disabled ||
			busy ||
			draft.browserCapture?.sourceUrl === url ||
			!URL.canParse(url) ||
			new URL(url).protocol !== 'https:' ||
			(attemptedDraft === draft && attemptedUrl === url)
		)
			return;
		const requestedDraft = draft;
		const timer = setTimeout(
			() =>
				untrack(() => {
					if (draft !== requestedDraft) return;
					attemptedDraft = draft;
					attemptedUrl = url;
					void retrieve(url);
				}),
			600
		);
		return () => clearTimeout(timer);
	});
</script>

<div class="metadata-help">
	{#if duplicates.length && !duplicatesDismissed}<div class="notice">
			<p>This idea may already be saved.</p>
			{#each duplicates as match}<a
					href={'/products/' + encodeURIComponent(match.id)}
					target="_blank"
					rel="noopener noreferrer">View {match.title} and its lists</a
				>{/each}<button
				type="button"
				class="quiet"
				onclick={() => {
					duplicatesDismissed = true;
				}}>Keep as a separate idea</button
			>
		</div>{/if}
	<label class="check-label ai-option"
		><input type="checkbox" bind:checked={allowAI} /><span>Use AI for missing page details</span
		></label
	>
	<small
		>Product content may be sent to Google. Images are sent only when you choose Fill from image.</small
	>
	{#if ai.configured && !ai.enabled}<p class="muted">
			AI help is disabled. The administrator can enable it in Identification settings. You can still
			save ideas.
		</p>{/if}
	<div class="source-actions">
		<button
			type="button"
			class="quiet"
			disabled={disabled || busy || !draft.sourceUrl}
			onclick={() => retrieve(draft.sourceUrl, true)}
			>{busy ? 'Reading source…' : 'Look up retailer details'}</button
		>
		{#if photos.length}
			{#if photos.length > 1}<label
					>Image to read<select bind:value={selectedImage}
						>{#each photos as photo, index}<option value={index}>{photo.name}</option
							>{/each}</select
					></label
				>{/if}
			<button
				type="button"
				class="secondary"
				disabled={disabled || busy}
				onclick={() => fill('image')}>Fill from image</button
			>
		{/if}
		{#if draft.sourceText.trim()}<button
				type="button"
				class="quiet"
				disabled={disabled || busy}
				onclick={() => fill('text')}>Fill from text</button
			>{/if}
		{#if patch && patchDraft === draft}<button type="button" class="quiet" {disabled} onclick={undo}
				>Undo autofill</button
			>{/if}
	</div>
	{#if photos.length}<p class="muted">
			Preview or crop your image before filling details. Only the image you submit will be sent to
			Google.
		</p>{/if}
	{#if message}<p class="muted" role="status">{message}</p>{/if}
	{#if blockedLink}<div class="source-actions">
			<label class="button secondary"
				>Add screenshot<input
					class="visually-hidden"
					type="file"
					accept="image/jpeg,image/png,image/webp,image/heic,image/avif"
					{disabled}
					onchange={(event) => {
						const file = event.currentTarget.files?.[0];
						if (file) {
							photos = [...photos, file];
							draft.editedFields = [...new Set([...(draft.editedFields ?? []), 'photos' as const])];
							selectedImage = photos.length - 1;
						}
						event.currentTarget.value = '';
					}}
				/></label
			>
			{#if /^https:\/\//.test(draft.sourceUrl)}<a
					class="button secondary"
					href={draft.sourceUrl}
					target="_blank"
					rel="noopener noreferrer">Open product page</a
				>{/if}
		</div>{/if}
	{#if choices.length && choicesDraft === draft && choicesSource === draft.sourceUrl}<fieldset>
			<legend>Which item?</legend>{#each choices as candidate}<button
					type="button"
					class="secondary"
					{disabled}
					onclick={() => {
						void useCandidate(
							candidate,
							() => !disabled && draft === choicesDraft && draft.sourceUrl === choicesSource
						);
					}}>Use {candidate.title ?? 'this item'}</button
				>{/each}
		</fieldset>{/if}
	{#if photoBusy}<p role="status" class="muted">Copying shop photo…</p>{/if}
	{#if photoMessage}<p role="status" class="muted">{photoMessage}</p>{/if}
	{#if draft.browserCapture?.imageUrl && !photos.length}<button
			type="button"
			class="quiet"
			disabled={disabled || photoBusy}
			onclick={importBrowserPhoto}>Retry shop photo</button
		>{/if}
</div>

<style>
	.metadata-help {
		margin: 0.75rem 0 1rem;
	}
	.source-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
		margin-top: 0.6rem;
	}
	.ai-option {
		font-size: 0.85rem;
		margin-bottom: 0.3rem;
	}
	small {
		color: var(--muted);
	}
	fieldset {
		border: 1px solid var(--line);
		border-radius: 0.6rem;
	}
</style>
