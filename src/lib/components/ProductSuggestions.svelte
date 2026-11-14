<script lang="ts">
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { formatPrice, type Product } from '#lib/catalogue-types.ts';
	import type { LookupResult } from '#lib/server/enrichment/types.ts';
	import type { LookupProvider } from '#lib/shared/photo-shopping-links.ts';
	type Job = {
		id: string;
		operationId?: string;
		kind: string;
		provider?: LookupProvider;
		state: string;
		createdAt: number;
		result: LookupResult | null;
		message: string | null;
	};
	let { product, administrator }: { product: Product; administrator: boolean } = $props();
	let jobs = $state<Job[]>([]);
	let canIdentify = $state(false);
	let enabled = $state(false);
	let configured = $state(false);
	let serpapiConfigured = $state(false);
	let busy = $state(false);
	let message = $state('');
	let mediaId = $state('');
	let pending = $state<{
		operationId: string;
		kind: 'metadata' | 'vision';
		mediaId?: string;
	} | null>(null);
	let selections = $state<Record<string, string[]>>({});
	let photo = $state<File | null>(null);
	let uploadId = '';
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	async function refresh() {
		try {
			const response = await fetch(`/api/products/${product.id}/identify`, { cache: 'no-store' });
			const result = await response.json();
			if (!response.ok) {
				jobs = [];
				throw new Error(result.message);
			}
			jobs = result.jobs.filter((job: Job) => job.provider !== 'serpapi');
			for (const job of jobs)
				for (let index = 0; index < (job.result?.suggestions.length ?? 0); index++)
					selections[`${job.id}-${index}`] ??= [];
			canIdentify = result.canIdentify;
			enabled = result.enabled;
			configured = result.visionConfigured;
			serpapiConfigured = result.serpapi?.configured ?? false;
			if (pending && jobs.some((job) => job.operationId === pending?.operationId)) pending = null;
			clearTimeout(timer);
			if (!disposed && jobs.some((job) => ['queued', 'running'].includes(job.state)))
				timer = setTimeout(refresh, 2000);
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'Lookup status needs an online connection.';
		}
	}
	onMount(() => {
		void refresh();
		return () => {
			disposed = true;
			clearTimeout(timer);
		};
	});
	async function identify(kind?: 'metadata' | 'vision') {
		if (busy) return;
		busy = true;
		message = '';
		if (!pending && kind)
			pending = {
				operationId: crypto.randomUUID(),
				kind,
				...(kind === 'vision' && (mediaId || product.media[0]?.id)
					? { mediaId: mediaId || product.media[0].id }
					: {})
			};
		try {
			const response = await fetch(`/api/products/${product.id}/identify`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(pending)
			});
			const result = await response.json();
			if (!response.ok) {
				if (response.status < 500) pending = null;
				throw new Error(result.message);
			}
			pending = null;
			message = 'Lookup requested. You can keep using the app while it runs.';
			await refresh();
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'The request result is unknown. Retry the same request to check it.';
		} finally {
			busy = false;
		}
	}
	async function confirm(jobId: string, index: number) {
		busy = true;
		message = '';
		try {
			const response = await fetch(`/api/products/${product.id}/identify/confirm`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ jobId, index, fields: selections[`${jobId}-${index}`] ?? [] })
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.message);
			await invalidateAll();
			message = 'Selected details confirmed. List estimates and the original source are preserved.';
		} catch (error) {
			message =
				error instanceof Error ? error.message : 'The selected details could not be confirmed.';
		} finally {
			busy = false;
		}
	}
	async function attach() {
		if (!photo || busy) return;
		busy = true;
		message = '';
		try {
			const body = new FormData();
			body.set('photo', photo);
			body.set('operationId', uploadId);
			const response = await fetch(`/api/products/${product.id}/identify/photo`, {
				method: 'POST',
				body
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.message);
			photo = null;
			await invalidateAll();
			message = 'Photo attached. Open Find where to buy to search it.';
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'The upload result is unknown. Retry with this same photo.';
		} finally {
			busy = false;
		}
	}
</script>

<section class="panel product-suggestions" aria-label="Product suggestions">
	<h2>Find product details</h2>
	<p class="muted">
		Read an accessible retailer page first. Private social posts may need a screenshot or manual
		details.
	</p>
	{#if canIdentify}<div class="heading-actions">
			<button
				class="secondary"
				disabled={busy || !!pending || !product.sourceUrl}
				onclick={() => identify('metadata')}>Read source details</button
			>
		</div>
		{#if configured && !serpapiConfigured}<details>
				<summary>Optional image matching</summary>
				<p>
					A photo or accessible source image is sent to your personal Google Vision project only
					when you request matching. Matches need checking and may not identify the exact variant.
				</p>
				{#if product.media.length}<label
						>Photo to identify<select bind:value={mediaId}
							><option value="">First attached photo</option>{#each product.media as image}<option
									value={image.id}>{image.originalName || 'Attached photo'}</option
								>{/each}</select
						></label
					>{/if}
				{#if !enabled}<p>Paid identification is disabled by the administrator.</p>{/if}
				<button
					disabled={busy || !!pending || !enabled || (!product.media.length && !product.sourceUrl)}
					onclick={() => identify('vision')}>Request image matching</button
				>
				<p class="muted">
					One image uses the configured monthly allowance. Uncertain requests remain counted; paid
					requests are never retried automatically.
				</p>
			</details>{/if}{/if}
	{#if administrator}<details>
			<summary>Add a screenshot or shop photo</summary><label
				>Additional photo<input
					type="file"
					accept="image/jpeg,image/png,image/webp,image/heic,image/avif"
					onchange={(event) => {
						photo = event.currentTarget.files?.[0] ?? null;
						uploadId = crypto.randomUUID();
					}}
				/></label
			><button class="secondary" disabled={busy || !photo} onclick={attach}>Attach photo</button>
		</details>{/if}
	{#if pending}<button class="secondary" disabled={busy} onclick={() => identify()}
			>Retry the same lookup request</button
		>{/if}
	{#if message}<p role="status" class="notice">{message}</p>{/if}
	{#if jobs.length}<h3>Lookup evidence</h3>
		<button class="quiet" disabled={busy} onclick={refresh}>Refresh lookup status</button>{/if}
	{#each jobs as job}<details class="lookup-job">
			<summary
				>{job.kind === 'vision' ? 'Image matching' : 'Source metadata'} · {job.state} · {new Date(
					job.createdAt
				).toLocaleString('en-GB')}</summary
			>
			{#if job.message}<p>{job.message}</p>{/if}
			{#if job.result}<p>{job.result.message}</p>
				{#if job.result.labels.length}<p>Image labels: {job.result.labels.join(', ')}</p>{/if}
				{#each job.result.suggestions as candidate, index}{@const key = `${job.id}-${index}`}
					<div class="candidate">
						<h4>{candidate.title || 'Possible buying page'}</h4>
						{#if job.kind === 'vision'}{@const checkedOffer = product.offers.find(
								(offer) => offer.url === candidate.offer?.url && offer.checked
							)}{#if checkedOffer}<p>
									Checked by a person on {new Date(checkedOffer.checkedAt!).toLocaleDateString(
										'en-GB'
									)}.
								</p>{:else}<p class="notice">
									This link may be incorrect. Check the product and variant before buying.
								</p>{/if}{/if}
						{#if candidate.description}<p>{candidate.description}</p>{/if}{#if candidate.variant}<p>
								Variant: {candidate.variant}
							</p>{/if}
						{#if candidate.offer}<p>
								{candidate.offer.fromPrice ? 'From ' : ''}{candidate.offer.priceMinor !== null &&
								candidate.offer.currency
									? formatPrice(candidate.offer.priceMinor, candidate.offer.currency)
									: candidate.offer.priceText
										? `${candidate.offer.priceText} (currency or price unconfirmed)`
										: 'Price unknown'}
							</p>{/if}
						<a href={candidate.sourceUrl} target="_blank" rel="noopener noreferrer"
							>Inspect source ↗</a
						>
						<p class="muted">
							{candidate.source} · retrieved {new Date(candidate.retrievedAt).toLocaleString(
								'en-GB'
							)}
						</p>
						{#each candidate.uncertainty as uncertainty}<p class="muted">{uncertainty}</p>{/each}
						{#if administrator}<fieldset disabled={busy}>
								<legend>Choose details to apply</legend>
								{#if candidate.title}<label class="check-label"
										><input type="checkbox" value="title" bind:group={selections[key]} /><span
											>Title</span
										></label
									>{/if}
								{#if candidate.description}<label class="check-label"
										><input type="checkbox" value="description" bind:group={selections[key]} /><span
											>Description</span
										></label
									>{/if}
								{#if candidate.variant}<label class="check-label"
										><input type="checkbox" value="variant" bind:group={selections[key]} /><span
											>Variant — replaces the saved variant only if selected</span
										></label
									>{/if}
								{#if candidate.offer}<label class="check-label"
										><input type="checkbox" value="offer" bind:group={selections[key]} /><span
											>Add shopping link and exact published price, when known</span
										></label
									>{/if}
								{#if candidate.imageUrl}<label class="check-label"
										><input type="checkbox" value="image" bind:group={selections[key]} /><span
											>Import product picture</span
										></label
									>{/if}
								<button
									class="secondary"
									disabled={!selections[key]?.length}
									onclick={() => confirm(job.id, index)}>Confirm selected details</button
								>
							</fieldset>{:else}<p class="muted">
								The administrator can confirm these suggestions for the shared catalogue.
							</p>{/if}
					</div>{/each}{/if}
		</details>{/each}
</section>

<style>
	.product-suggestions {
		overflow-wrap: anywhere;
	}
	.product-suggestions details {
		margin: 1rem 0;
	}
	.candidate {
		padding: 1rem;
		border: 1px solid var(--border);
		border-radius: 0.6rem;
		margin: 1rem 0;
	}
	.candidate h4 {
		margin-top: 0;
	}
	.candidate fieldset {
		margin-top: 1rem;
	}
	.lookup-job {
		border-top: 1px solid var(--border);
		padding-top: 0.75rem;
	}
</style>
