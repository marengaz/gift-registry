<script lang="ts">
	import { untrack } from 'svelte';
	import { priceInput, type CaptureDraft } from '#lib/catalogue-types.ts';
	import type { ProductSuggestion } from '#lib/server/enrichment/types.ts';
	let {
		draft = $bindable(),
		photos = $bindable([]),
		disabled = false
	}: { draft: CaptureDraft; photos?: File[]; disabled?: boolean } = $props();
	let message = $state('');
	let busy = $state(false);
	let attempted = '';
	let photoBusy = $state(false);
	let photoMessage = $state('');
	let attemptedPhotoDraft: CaptureDraft | undefined;
	let attemptedPhotoUrl = '';
	async function importBrowserPhoto() {
		const requestedDraft = draft;
		const capture = draft.browserCapture;
		const url = capture?.imageUrl;
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
			if (current() && photos === selectedPhotos && !photos.length) {
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
	async function retrieve(url: string) {
		if (busy || disabled || !navigator.onLine) return;
		const requestedDraft = draft;
		const current = () => !disabled && draft === requestedDraft && draft.sourceUrl === url;
		busy = true;
		message = 'Looking for retailer details…';
		try {
			const response = await fetch('/api/metadata', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url })
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.message);
			if (!current()) return;
			const candidate: ProductSuggestion | undefined = result.suggestions[0];
			if (!candidate) {
				message = result.message;
				return;
			}
			if (!draft.title.trim() && candidate.title) draft.title = candidate.title;
			if (!draft.description.trim() && candidate.description)
				draft.description = candidate.description;
			if (!draft.variant.trim() && candidate.variant) draft.variant = candidate.variant;
			const currency = candidate.offer?.currency;
			if (
				!draft.estimate.trim() &&
				candidate.offer?.currency === 'GBP' &&
				!candidate.offer.fromPrice &&
				candidate.offer.priceMinor != null
			)
				draft.estimate = priceInput(candidate.offer.priceMinor, 'GBP');
			if (!draft.offers.length && candidate.offer && currency) {
				const offer = candidate.offer;
				draft.offers = [
					{
						url: offer.url,
						retailer: offer.retailer ?? '',
						price: offer.fromPrice ? '' : priceInput(offer.priceMinor, offer.currency ?? 'GBP'),
						currency
					}
				];
			}
			const evidence = [
				`Page details retrieved from ${candidate.sourceUrl} on ${new Date(candidate.retrievedAt).toISOString()}.`,
				candidate.offer?.priceText
					? `Published ${candidate.offer.fromPrice ? 'from-price' : 'price'}: ${candidate.offer.priceText} ${candidate.offer.currency ?? '(currency missing)'}.`
					: '',
				...candidate.uncertainty
			]
				.filter(Boolean)
				.join(' ');
			if (!draft.sourceText.includes(evidence))
				draft.sourceText = [draft.sourceText, evidence].filter(Boolean).join('\n');
			message = [
				'Imported available details. Check the exact product and variant.',
				...candidate.uncertainty
			].join(' ');
			if (candidate.imageUrl && !photos.length) {
				const selectedPhotos = photos;
				const image = await fetch('/api/metadata/image', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ url: candidate.imageUrl })
				});
				if (image.ok) {
					const blob = await image.blob();
					if (current() && photos === selectedPhotos && !photos.length)
						photos = [new File([blob], 'retailer-image.webp', { type: 'image/webp' })];
				}
			}
		} catch (error) {
			if (!current()) return;
			message =
				error instanceof Error
					? error.message
					: 'Keep the link and add a screenshot or enter the details manually.';
		} finally {
			busy = false;
		}
	}
	$effect(() => {
		const url = draft.sourceUrl;
		const locked = disabled;
		if (draft.browserCapture?.sourceUrl === url) return;
		if (locked || !URL.canParse(url) || new URL(url).protocol !== 'https:' || url === attempted)
			return;
		const timer = setTimeout(
			() =>
				untrack(() => {
					attempted = url;
					void retrieve(url);
				}),
			600
		);
		return () => clearTimeout(timer);
	});
</script>

<div class="metadata-help">
	{#if draft.browserCapture?.sourceUrl === draft.sourceUrl}<p class="muted">
			Details copied from your browser. Review the exact product, variant and current price before
			saving.
		</p>{/if}
	{#if photoBusy}<p role="status" class="muted">Copying shop photo…</p>{/if}
	{#if photoMessage}<p role="status" class="muted">{photoMessage}</p>{/if}
	{#if draft.browserCapture?.imageUrl && !photos.length}<button
			type="button"
			class="quiet"
			disabled={disabled || photoBusy}
			onclick={importBrowserPhoto}>Retry shop photo</button
		>{/if}
	<button
		type="button"
		class="quiet"
		disabled={disabled || busy || !draft.sourceUrl}
		onclick={() => retrieve(draft.sourceUrl)}
		>{busy ? 'Reading source…' : 'Look up retailer details'}</button
	>{#if message}<p class="muted" role="status">{message}</p>{/if}
</div>
