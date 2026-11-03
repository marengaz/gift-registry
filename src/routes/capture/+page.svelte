<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import CaptureEditor from '#lib/components/CaptureEditor.svelte';
	import { emptyDraft, capturePayload, type Identity } from '#lib/catalogue-types.ts';
	let person = $state<Identity | null>(null);
	let loading = $state(true);
	let busy = $state(false);
	let message = $state('');
	let savedId = $state('');
	let draft = $state(emptyDraft());
	let photos = $state<File[]>([]);
	const lists = $derived(
		person?.lists.filter(
			(list) => !list.archivedAt && (person?.administrator || list.role === 'contributor')
		) ?? []
	);
	const allowed = $derived(person?.member && (person.administrator || lists.length > 0));
	onMount(async () => {
		try {
			const response = await fetch('/api/me', { cache: 'no-store' });
			if (response.ok) {
				person = await response.json();
				const requested = page.url.searchParams.get('list');
				if (
					requested &&
					person?.lists.some(
						(list) =>
							list.id === requested &&
							!list.archivedAt &&
							(person?.administrator || list.role === 'contributor')
					)
				)
					draft.listIds = [requested];
			} else message = 'Sign in to load your current list permissions.';
		} catch {
			message = 'You are offline. Reconnect to load your lists and save this idea.';
		} finally {
			loading = false;
		}
	});
	async function save() {
		busy = true;
		message = '';
		savedId = '';
		try {
			const body = new FormData();
			body.set('draft', JSON.stringify(capturePayload(draft)));
			for (const photo of photos) body.append('photos', photo);
			const response = await fetch('/api/products', { method: 'POST', body });
			const result = await response.json();
			if (!response.ok) throw new Error(result.message);
			savedId = result.id;
			message = 'Idea saved.';
		} catch (error) {
			message =
				error instanceof Error
					? error.message
					: 'Saving failed. Your idea is still here. Reconnect and try again.';
		} finally {
			busy = false;
		}
	}
	function another() {
		draft = emptyDraft();
		photos = [];
		message = '';
		savedId = '';
	}
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
	{#if loading}<p role="status">Loading your list permissions…</p>{:else if savedId}<section
			class="panel"
		>
			<h2>Idea saved</h2>
			<p>Your idea is ready to view.</p>
			<div class="heading-actions">
				<a class="button" href={`/products/${savedId}`}>View idea</a><button
					class="secondary"
					onclick={another}>Add another</button
				>
			</div>
		</section>{:else if allowed}<CaptureEditor
			bind:draft
			bind:photos
			{lists}
			{busy}
			onSave={save}
		/>{:else}<section class="panel">
			<h2>{person ? 'Contributor access needed' : 'Sign in to save an idea'}</h2>
			<p>
				{person
					? 'Ask the administrator for contributor access to a list. Buyers and viewers can browse the lists shared with them.'
					: 'Use the Google account named in your family invitation.'}
			</p>
			<a class="button" href={person ? '/lists' : '/login'}>{person ? 'View lists' : 'Sign in'}</a>
		</section>{/if}
	{#if message && !savedId}<p class="notice error" role="alert">{message}</p>{/if}
</main>
