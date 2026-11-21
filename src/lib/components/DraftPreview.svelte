<script lang="ts">
	import { draftStore, type LocalDraft } from '#lib/client/drafts.ts';
	import { downloadDraftThumbnail } from '#lib/client/wishlist-import.ts';
	let { record }: { record: LocalDraft } = $props();
	let source = $state('');
	const draftId = $derived(record.id);
	const ownerId = $derived(record.ownerId);
	const updatedAt = $derived(record.updatedAt);
	const productId = $derived(record.status === 'saved' ? record.ack?.productId : undefined);
	const pendingImageUrl = $derived(record.draft.browserCapture?.imageUrl ?? '');
	$effect(() => {
		const id = draftId,
			owner = ownerId;
		const revision = updatedAt;
		const savedProduct = productId;
		const fallbackImageUrl = pendingImageUrl;
		let disposed = false;
		let objectUrl = '';
		const controller = new AbortController();
		const current = async () => {
			const context = await draftStore.current();
			return !disposed && (!owner || context?.ownerId === owner) && record.updatedAt === revision;
		};
		source = '';
		void draftStore
			.firstPhoto(id, owner)
			.then(async (file) => {
				if (!(await current())) return;
				if (file) {
					objectUrl = URL.createObjectURL(file);
					source = objectUrl;
				} else if (savedProduct && owner) {
					const response = await fetch('/api/products/' + encodeURIComponent(savedProduct), {
						cache: 'no-store',
						signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
					});
					if (!response.ok) return;
					const product = await response.json();
					const imageId = product.media?.[0]?.id;
					if (typeof imageId === 'string' && (await current()))
						source = '/api/media/' + encodeURIComponent(imageId);
				} else if (fallbackImageUrl && typeof navigator !== 'undefined' && navigator.onLine) {
					void downloadDraftThumbnail(record, draftStore, fetch, controller.signal);
				}
			})
			.catch(() => {});
		return () => {
			disposed = true;
			controller.abort();
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	});
</script>

<span class="draft-preview"
	>{#if source}<img src={source} alt="" />{:else}<span aria-hidden="true">✦</span>{/if}</span
>

<style>
	.draft-preview {
		width: 3.5rem;
		height: 3.5rem;
		flex: 0 0 3.5rem;
		display: grid;
		place-items: center;
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		overflow: hidden;
		color: var(--muted);
	}
	img {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}
</style>
