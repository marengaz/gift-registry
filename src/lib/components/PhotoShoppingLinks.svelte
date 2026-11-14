<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { formatPrice, type Product, type Identity } from '#lib/catalogue-types.ts';
	import type { LookupResult } from '#lib/server/enrichment/types.ts';
	import type {
		LookupProvider,
		PhotoShoppingRequest,
		OfferCheckRequest,
		SerpApiSearchStatus
	} from '#lib/shared/photo-shopping-links.ts';

	type Job = {
		id: string;
		operationId?: string;
		provider: LookupProvider;
		mediaId: string | null;
		state: string;
		createdAt: number;
		message: string | null;
		result: LookupResult | null;
	};
	type Status = {
		jobs: Job[];
		canIdentify: boolean;
		administrator: boolean;
		enabled: boolean;
		serpapi: SerpApiSearchStatus;
	};
	let { product, administrator }: { product: Product; administrator: boolean } = $props();
	let mediaId = $state(untrack(() => product.media[0]?.id ?? ''));
	let jobs = $state<Job[]>([]);
	let actorId = $state('');
	let canIdentify = $state(false);
	let currentAdministrator = $state(false);
	let enabled = $state(false);
	let allowance = $state<SerpApiSearchStatus | null>(null);
	let pending = $state<PhotoShoppingRequest | null>(null);
	let busy = $state(false);
	let message = $state('');
	let reviewed = $state<Record<string, string | undefined>>({});
	let contextLost = $state(false);
	let version = 0;
	let refreshVersion = 0;
	let disposed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const searching = $derived(jobs.some((job) => ['queued', 'running'].includes(job.state)));
	const maySearch = $derived(
		canIdentify &&
			enabled &&
			allowance?.configured &&
			allowance.remaining > 0 &&
			!!mediaId &&
			!contextLost
	);
	function snapshot() {
		return { productId: product.id, mediaId, version, actorId };
	}
	function currentProduct(context: ReturnType<typeof snapshot>) {
		return (
			!disposed &&
			!contextLost &&
			context.productId === product.id &&
			(!context.actorId || context.actorId === actorId)
		);
	}
	function current(context: ReturnType<typeof snapshot>) {
		return currentProduct(context) && context.mediaId === mediaId && context.version === version;
	}
	function storageKey() {
		return `photo-shopping:${actorId}:${product.id}:${mediaId}`;
	}
	class RequestError extends Error {
		readonly status: number;
		constructor(message: string, status: number) {
			super(message);
			this.status = status;
		}
	}
	async function json<T>(url: string, init?: RequestInit): Promise<T> {
		const response = await fetch(url, { cache: 'no-store', ...init });
		if (!response.ok) {
			const result = await response.json().catch(() => null);
			throw new RequestError(
				result?.message || 'This action could not be completed. Your saved idea is unchanged.',
				response.status
			);
		}
		return (await response.json()) as T;
	}
	async function fresh(context: ReturnType<typeof snapshot>, isCurrent = current) {
		const [person, status] = await Promise.all([
			json<Identity>('/api/me'),
			json<Status>(`/api/products/${context.productId}/identify`)
		]);
		if (!isCurrent(context)) return null;
		if (actorId && person.id !== actorId) {
			contextLost = true;
			canIdentify = false;
			currentAdministrator = false;
			jobs = [];
			message =
				'The signed-in account changed. Reload this idea before searching or changing links.';
			return null;
		}
		actorId = person.id;
		return { person, status };
	}
	function clearPending() {
		sessionStorage.removeItem(storageKey());
		pending = null;
	}
	async function refresh() {
		if (disposed || contextLost) return;
		const context = snapshot();
		const generation = ++refreshVersion;
		const latest = () => generation === refreshVersion && current(context);
		clearTimeout(timer);
		try {
			const live = await fresh(context, latest);
			if (!live || !latest()) return;
			canIdentify = live.status.canIdentify;
			currentAdministrator = live.person.administrator && live.status.administrator;
			enabled = live.status.enabled;
			allowance = live.status.serpapi;
			jobs = live.status.jobs.filter(
				(job) => job.provider === 'serpapi' && job.mediaId === mediaId
			);
			if (!pending) {
				const stored = sessionStorage.getItem(storageKey());
				if (stored) {
					const value = JSON.parse(stored) as PhotoShoppingRequest;
					if (
						value.provider === 'serpapi' &&
						value.kind === 'vision' &&
						value.mediaId === mediaId &&
						typeof value.operationId === 'string'
					)
						pending = value;
				}
			}
			if (pending && jobs.some((job) => job.operationId === pending?.operationId)) clearPending();
			if (jobs.some((job) => ['queued', 'running'].includes(job.state)))
				timer = setTimeout(() => void refresh(), 2000);
		} catch (error) {
			if (!latest()) return;
			message =
				error instanceof Error ? error.message : 'Photo search status needs an online connection.';
			if (error instanceof RequestError && [401, 403, 404].includes(error.status)) {
				contextLost = true;
				canIdentify = false;
				currentAdministrator = false;
				jobs = [];
				pending = null;
			} else if (jobs.some((job) => ['queued', 'running'].includes(job.state))) {
				timer = setTimeout(() => void refresh(), 2000);
			}
		}
	}
	onMount(() => {
		void refresh();
		const resume = () => void refresh();
		window.addEventListener('focus', resume);
		return () => {
			disposed = true;
			clearTimeout(timer);
			window.removeEventListener('focus', resume);
		};
	});
	$effect(() => {
		if (
			!product.media.some((image) => image.id === mediaId) &&
			mediaId !== (product.media[0]?.id ?? '')
		) {
			mediaId = product.media[0]?.id ?? '';
			choosePhoto();
		}
	});
	function choosePhoto() {
		version++;
		pending = null;
		jobs = [];
		message = '';
		busy = false;
		void refresh();
	}
	async function search(separate = false) {
		if (busy || !mediaId) return;
		refreshVersion++;
		clearTimeout(timer);
		const context = snapshot();
		busy = true;
		message = '';
		try {
			const live = await fresh(context);
			if (!live || !current(context)) return;
			if (!live.status.canIdentify)
				throw new Error('Contributor permission is needed to search this photo.');
			if (!live.status.enabled)
				throw new Error(
					'Photo search is disabled by the administrator. You can still edit this idea manually.'
				);
			if (!live.status.serpapi.configured)
				throw new Error(
					'SerpAPI needs configuring on the server. You can still add a shopping link manually.'
				);
			if (live.status.serpapi.remaining < 1)
				throw new Error(
					'The monthly photo search allowance is used up. Add a link manually or try in a later month.'
				);
			if (pending && !separate) return;
			const command: PhotoShoppingRequest = {
				operationId: crypto.randomUUID(),
				kind: 'vision',
				provider: 'serpapi',
				mediaId: context.mediaId
			};
			sessionStorage.setItem(storageKey(), JSON.stringify(command));
			pending = command;
			const response = await fetch(`/api/products/${context.productId}/identify`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(command)
			});
			const result = await response.json();
			if (!current(context)) return;
			if (!response.ok) {
				if (response.status < 500) clearPending();
				throw new Error(result.message || 'The photo search request could not be accepted.');
			}
			refreshVersion++;
			clearTimeout(timer);
			if (!(await fresh(context)) || !current(context)) return;
			message = 'Photo search requested. Possible matches still need checking.';
			await refresh();
		} catch (error) {
			if (current(context))
				message =
					error instanceof Error
						? error.message
						: 'The request result is unknown. Refresh its status before making another request.';
		} finally {
			if (current(context)) busy = false;
		}
	}
	async function add(jobId: string, index: number) {
		if (busy) return;
		const context = snapshot();
		busy = true;
		message = '';
		try {
			const live = await fresh(context);
			if (!live || !current(context)) return;
			if (!administrator || !live.person.administrator || !live.status.administrator)
				throw new Error('Only the administrator can add shopping links.');
			await json(`/api/products/${context.productId}/identify/confirm`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ jobId, index, fields: ['offer'] })
			});
			if (!(await fresh(context, currentProduct)) || !currentProduct(context)) return;
			await invalidateAll();
			if (current(context))
				message =
					'Link added unchecked. Open it and check the product and variant before marking it checked.';
		} catch (error) {
			if (current(context))
				message =
					error instanceof Error
						? error.message
						: 'The link could not be added. Refresh the idea to check its saved links.';
		} finally {
			if (current(context)) busy = false;
		}
	}
	async function check(offer: Product['offers'][number], checked: boolean) {
		if (
			busy ||
			!offer.reviewFingerprint ||
			(checked && reviewed[offer.id] !== offer.reviewFingerprint)
		)
			return;
		const context = snapshot();
		busy = true;
		message = '';
		const body: OfferCheckRequest = {
			checked,
			reviewedURL: offer.url,
			reviewFingerprint: offer.reviewFingerprint
		};
		try {
			const live = await fresh(context);
			if (!live || !current(context)) return;
			if (!administrator || !live.person.administrator || !live.status.administrator)
				throw new Error('Only the administrator can record a link check.');
			await json(`/api/products/${context.productId}/offers/${offer.id}/check`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!(await fresh(context, currentProduct)) || !currentProduct(context)) return;
			reviewed[offer.id] = undefined;
			await invalidateAll();
			if (current(context))
				message = checked
					? 'Human check recorded for this link, product and variant.'
					: 'Link marked unchecked.';
		} catch (error) {
			if (current(context))
				message =
					error instanceof Error
						? error.message
						: 'The check could not be saved. Refresh this idea before checking again.';
		} finally {
			if (current(context)) busy = false;
		}
	}
</script>

<div class="photo-shopping-links">
	{#if product.offers.length}<section class="panel" aria-label="Shopping links">
			<h2>Shopping links</h2>
			<ul class="link-list">
				{#each product.offers as offer}<li>
						<a href={offer.url} target="_blank" rel="noopener noreferrer"
							>{offer.retailer || new URL(offer.url).hostname} ↗</a
						>
						{#if offer.priceMinor != null}<small
								>{formatPrice(offer.priceMinor, offer.currency ?? 'GBP')} · noted {new Date(
									offer.observedAt
								).toLocaleDateString('en-GB')}</small
							>{/if}
						{#if offer.reverseFound}
							{#if offer.checked}<p class="check-status">
									Checked by a person on {new Date(offer.checkedAt!).toLocaleDateString('en-GB')}.
								</p>
							{:else}<p class="notice">
									This link may be incorrect. Check the product and variant before buying.
								</p>{/if}
							{#if administrator && currentAdministrator && !contextLost}
								{#if offer.checked}<button
										class="quiet"
										disabled={busy}
										onclick={() => check(offer, false)}>Mark unchecked again</button
									>
								{:else}<div class="human-check">
										<p>
											Open this exact link and check that it is <strong>{product.title}</strong
											>{product.variant ? ` (${product.variant})` : ''}, including the correct size,
											colour or edition. Adding or opening a link does not check it.
										</p>
										<label class="check-label"
											><input
												type="checkbox"
												checked={!!offer.reviewFingerprint &&
													reviewed[offer.id] === offer.reviewFingerprint}
												onchange={(event) => {
													reviewed[offer.id] = event.currentTarget.checked
														? offer.reviewFingerprint
														: undefined;
												}}
												disabled={busy}
											/><span>I have opened this link and checked the product and variant</span
											></label
										>
										<button
											class="secondary"
											disabled={busy ||
												!offer.reviewFingerprint ||
												reviewed[offer.id] !== offer.reviewFingerprint}
											onclick={() => check(offer, true)}>Mark checked</button
										>
									</div>{/if}
							{/if}
						{/if}
					</li>{/each}
			</ul>
		</section>{/if}
	{#if product.media.length}<section
			class="panel search-panel"
			aria-label="Find where to buy"
			id="find-where-to-buy"
		>
			<h2>Find where to buy</h2>
			<p>
				A compressed copy of the selected photo goes to SerpAPI and Google. The original stays
				private in this app.
			</p>
			<label
				>Photo to search<select bind:value={mediaId} onchange={choosePhoto}
					>{#each product.media as image}<option value={image.id}
							>{image.originalName || 'Attached photo'}</option
						>{/each}</select
				></label
			>
			{#if mediaId}<img
					class="selected-photo"
					src={`/api/media/${mediaId}`}
					alt="Selected item for shopping search"
				/>{/if}
			<p class="muted">
				Results are possible matches. Photos can lead to a different product or variant, or a page
				that does not sell it.
			</p>
			{#if canIdentify}
				{#if !enabled}<p>
						Photo search is disabled by the administrator. You can still edit this idea manually.
					</p>
				{:else if allowance && !allowance.configured}<p>
						SerpAPI needs configuring on the server. You can still add a shopping link manually.
					</p>
				{:else if allowance && allowance.remaining < 1}<p>
						The monthly photo search allowance is used up. Add a link manually or try in a later
						month.
					</p>{/if}
				{#if allowance?.configured}<p class="muted">
						{allowance.used} of {allowance.limit} app searches used this month. Uncertain searches remain
						counted.
					</p>{/if}
				<button disabled={busy || !maySearch || !!pending || searching} onclick={() => search()}
					>{searching ? 'Searching…' : 'Find where to buy'}</button
				>
			{:else}<p class="muted">
					A contributor or administrator can request matches for an attached photo.
				</p>{/if}
			{#if pending}<p class="notice">
					The result of the saved request is not yet known. Checking its status does not send the
					photo again.
				</p>
				{#if canIdentify}<p class="muted">
						A separate search may use another monthly slot if the earlier request reached the
						provider.
					</p>
					<button class="secondary" disabled={busy || !maySearch} onclick={() => search(true)}
						>Make a separate search request</button
					>{/if}
			{/if}
			<button class="quiet" disabled={busy} onclick={refresh}>Refresh photo search status</button>
			{#each jobs as job}<article class="lookup-job">
					<h3>Photo search · {job.state}</h3>
					<p class="muted">Requested {new Date(job.createdAt).toLocaleString('en-GB')}</p>
					{#if job.message}<p>{job.message}</p>{/if}
					{#if job.state === 'uncertain'}<p class="notice">
							The provider outcome is uncertain. This request remains counted and will not be sent
							again. Refreshing only checks its status.
						</p>{/if}
					{#if job.result}<p>{job.result.message}</p>
						{#if !job.result.suggestions.length}<p>
								No possible buying pages were found. Keep this idea and add a link or details
								manually.
							</p>{/if}
						{#each job.result.suggestions as candidate, index}{@const checkedOffer =
								product.offers.find((offer) => offer.url === candidate.offer?.url && offer.checked)}
							<div class="candidate">
								<h4>{candidate.title || 'Possible buying page'}</h4>
								<p>
									{new URL(candidate.sourceUrl).hostname}{candidate.offer?.retailer
										? ` · ${candidate.offer.retailer}`
										: ''}
								</p>
								<p>
									{candidate.offer?.fromPrice ? 'From ' : ''}{candidate.offer?.priceMinor != null &&
									candidate.offer?.currency
										? formatPrice(candidate.offer.priceMinor, candidate.offer.currency)
										: candidate.offer?.priceText
											? `${candidate.offer.priceText} (price or currency unconfirmed)`
											: 'Price unknown'} · observed {new Date(
										candidate.retrievedAt
									).toLocaleDateString('en-GB')}
								</p>
								<a href={candidate.sourceUrl} target="_blank" rel="noopener noreferrer"
									>Inspect possible match</a
								>
								{#if checkedOffer}<p>
										Checked by a person on {new Date(checkedOffer.checkedAt!).toLocaleDateString(
											'en-GB'
										)}.
									</p>{:else}<p class="notice">
										This link may be incorrect. Check the product and variant before buying.
									</p>{/if}
								{#each candidate.uncertainty as uncertainty}<p class="muted">
										{uncertainty}
									</p>{/each}
								{#if administrator && currentAdministrator && candidate.offer && !contextLost}<button
										class="secondary"
										disabled={busy}
										onclick={() => add(job.id, index)}>Add link</button
									>
								{:else if !administrator}<p class="muted">
										The administrator can add this possible buying link.
									</p>{/if}
							</div>{/each}
					{/if}
				</article>{/each}
		</section>{/if}
	{#if message}<p role="status" class="notice">{message}</p>{/if}
</div>

<style>
	.photo-shopping-links {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.selected-photo {
		display: block;
		width: 8rem;
		max-width: 100%;
		height: 8rem;
		object-fit: contain;
		margin: 1rem 0;
		border-radius: 0.5rem;
	}
	.search-panel {
		scroll-margin-top: 1rem;
	}
	select {
		width: 100%;
		max-width: 100%;
	}
	.candidate,
	.lookup-job {
		border-top: 1px solid var(--border);
		margin-top: 1rem;
		padding-top: 1rem;
	}
	.candidate h4 {
		margin-top: 0;
	}
	.human-check {
		margin: 0.75rem 0;
	}
	.check-status {
		font-weight: 650;
	}
	.link-list li {
		margin-bottom: 1.5rem;
	}
	button {
		max-width: 100%;
		white-space: normal;
	}
</style>
