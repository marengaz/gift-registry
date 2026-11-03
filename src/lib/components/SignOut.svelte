<script lang="ts">
	import { authClient } from '#lib/client/auth.ts';
	import { draftStore } from '#lib/client/drafts.ts';
	import { refreshCaptureIdentity, syncDrafts } from '#lib/client/sync.ts';
	let busy = $state(false);
	let choosing = $state(false);
	let ownerId = $state('');
	let pending = $state(0);
	let error = $state('');
	let online = $state(true);
	function showChoice(dialog: HTMLDialogElement) {
		dialog.showModal();
	}
	async function signOut() {
		if (busy) return;
		busy = true;
		error = '';
		try {
			const person = await refreshCaptureIdentity();
			const context = await draftStore.current();
			ownerId = person?.id ?? context?.ownerId ?? '';
			pending = ownerId
				? (await draftStore.list(ownerId)).filter((record) => record.status !== 'saved').length
				: 0;
			online = navigator.onLine;
			if (pending) choosing = true;
			else await finish();
		} catch {
			const context = await draftStore.current();
			ownerId = context?.ownerId ?? '';
			pending = ownerId
				? (await draftStore.list(ownerId)).filter((record) => record.status !== 'saved').length
				: 0;
			online = navigator.onLine;
			if (pending) choosing = true;
			else error = 'Reconnect before signing out. Your drafts are still on this device.';
		} finally {
			busy = false;
		}
	}
	async function finish() {
		if (ownerId) await draftStore.beginSignOut(ownerId);
		try {
			const result = await authClient.signOut();
			if (result.error) throw new Error('Sign-out failed. Please try again.');
		} catch (error) {
			if (ownerId) await draftStore.endSignOut(ownerId);
			throw error;
		}
		if (ownerId) await draftStore.discard(ownerId);
		const context = await draftStore.current();
		if (context?.ownerId === ownerId) await draftStore.remember(null);
		window.location.assign('/login');
	}
	async function choose(sync: boolean) {
		if (busy) return;
		busy = true;
		error = '';
		try {
			if (sync) {
				await syncDrafts(draftStore, fetch, ownerId);
				const remaining = (await draftStore.list(ownerId)).filter(
					(record) => record.status !== 'saved'
				);
				if (remaining.length)
					throw new Error(
						'Some ideas still need attention. Review your drafts or choose to discard them before signing out.'
					);
			} else {
				await draftStore.discard(ownerId);
			}
			await finish();
		} catch (reason) {
			error =
				reason instanceof Error
					? reason.message
					: 'Sign-out failed. Your remaining drafts are still here.';
		} finally {
			busy = false;
		}
	}
</script>

<button class="quiet" disabled={busy} onclick={signOut}>{busy ? 'Signing out…' : 'Sign out'}</button
>
{#if choosing}<dialog
		use:showChoice
		class="signout-choice"
		oncancel={(event) => {
			event.preventDefault();
			if (!busy) {
				choosing = false;
				error = '';
				if (ownerId) void draftStore.endSignOut(ownerId);
			}
		}}
		aria-labelledby="signout-title"
	>
		<h2 id="signout-title">Keep your pending ideas safe</h2>
		<p>
			{pending}
			{pending === 1 ? 'idea has' : 'ideas have'} not been acknowledged by the server. Choose what to
			do before signing out.
		</p>
		<div class="choices">
			<button disabled={busy || !online} onclick={() => choose(true)}
				>Synchronise, then sign out</button
			><button class="secondary" disabled={busy} onclick={() => choose(false)}
				>Discard drafts and sign out</button
			><button
				class="quiet"
				disabled={busy}
				onclick={() => {
					choosing = false;
					error = '';
					if (ownerId) void draftStore.endSignOut(ownerId);
				}}>Cancel</button
			>
		</div>
		{#if !online}<p>Reconnect to synchronise first.</p>{/if}
		{#if error}<p role="alert">{error}</p>{/if}
	</dialog>{:else if error}<p role="alert">{error}</p>{/if}

<style>
	.signout-choice {
		position: fixed;
		margin: 0;
		z-index: 50;
		inset: 15% auto auto 50%;
		transform: translateX(-50%);
		width: min(34rem, calc(100vw - 2rem));
		padding: 1.5rem;
		border: 2px solid #213b43;
		border-radius: 1rem;
		background: #fff;
		box-shadow: 0 0 0 100vmax #213b4370;
	}
	.choices {
		display: flex;
		gap: 0.65rem;
		flex-wrap: wrap;
	}
</style>
