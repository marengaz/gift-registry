<script lang="ts">
	import { draftStore, type LocalDraft } from '#lib/client/drafts.ts';
	let { record }: { record: LocalDraft } = $props();
	let source = $state('');
	$effect(() => {
		const id = record.id,
			owner = record.ownerId;
		const revision = record.updatedAt;
		let disposed = false;
		let objectUrl = '';
		source = '';
		void draftStore
			.firstPhoto(id, owner)
			.then(async (file) => {
				if (disposed || !file) return;
				const context = await draftStore.current();
				if (disposed || (owner && context?.ownerId !== owner) || record.updatedAt !== revision)
					return;
				objectUrl = URL.createObjectURL(file);
				source = objectUrl;
			})
			.catch(() => {});
		return () => {
			disposed = true;
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
