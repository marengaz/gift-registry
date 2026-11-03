<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
	let email = $state('');
	let message = $state('');
	let invitationUrl = $state('');
	let busy = $state(false);
	let selected = $state<Record<string, string>>({});
	async function update(body: unknown) {
		busy = true;
		message = '';
		try {
			const response = await fetch('/api/people', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			const result = await response.json();
			if (!response.ok) {
				message = result.message;
				return null;
			}
			await invalidateAll();
			return result;
		} catch {
			message = 'The request could not be completed. Please try again.';
			return null;
		} finally {
			busy = false;
		}
	}
	async function invite() {
		const result = await update({
			action: 'invite',
			email: email.trim(),
			grants: Object.entries(selected)
				.filter(([, role]) => role)
				.map(([listId, role]) => ({ listId, role }))
		});
		if (result) {
			invitationUrl = result.url;
			email = '';
		}
	}
	async function copy() {
		try {
			await navigator.clipboard.writeText(invitationUrl);
			message = 'Invitation link copied.';
		} catch {
			message = 'Select and copy the invitation link below.';
		}
	}
</script>

<svelte:head><title>People and invitations · Family gifts</title></svelte:head>
<main>
	<h1>People and invitations</h1>
	<p>
		Choose permissions per list. Invitation links last seven days and work once, with the intended
		Google email.
	</p>
	<form
		onsubmit={(event) => {
			event.preventDefault();
			invite();
		}}
	>
		<label>Google email <input type="email" required bind:value={email} /></label>
		<fieldset>
			<legend>List permissions</legend
			>{#each data.lists.filter((list) => !list.archivedAt) as list}<label
					>{list.recipientName} · {list.name}<select bind:value={selected[list.id]}
						><option value="">No access</option><option value="viewer">Viewer</option><option
							value="buyer">Buyer</option
						><option value="contributor">Contributor</option></select
					></label
				>{/each}
		</fieldset>
		<button disabled={busy}>Create invitation</button>
	</form>
	{#if invitationUrl}<section>
			<h2>Copy this invitation</h2>
			<p>Send it using your chosen messaging app. This link is shown only when created.</p>
			<input aria-label="Invitation link" readonly value={invitationUrl} /><button onclick={copy}
				>Copy link</button
			>
		</section>{/if}
	{#if message}<p role="status">{message}</p>{/if}
	<h2>Family members</h2>
	{#each data.people as person}<section>
			<h3>{person.name}</h3>
			<p>{person.email}</p>
			{#each data.lists.filter((list) => !list.archivedAt) as list}<label
					>{list.recipientName} · {list.name}<select
						disabled={busy}
						value={data.grants.find(
							(grant) => grant.userId === person.id && grant.listId === list.id
						)?.role ?? ''}
						onchange={(event) =>
							update({
								action: 'grant',
								userId: person.id,
								listId: list.id,
								role: event.currentTarget.value || null
							})}
						><option value="">No access</option><option value="viewer">Viewer</option><option
							value="buyer">Buyer</option
						><option value="contributor">Contributor</option></select
					></label
				>{/each}
			<button disabled={busy} onclick={() => update({ action: 'revokeMember', userId: person.id })}
				>Revoke membership and sessions</button
			>
		</section>{:else}<p>No invitations have been accepted yet.</p>{/each}
	<h2>Pending invitations</h2>
	{#each data.invitations as invitation}<section>
			<p>
				{invitation.email} · expires {new Date(invitation.expiresAt).toLocaleDateString('en-GB')}
			</p>
			<button
				disabled={busy}
				onclick={() => update({ action: 'revokeInvitation', id: invitation.id })}
				>Revoke invitation</button
			>
		</section>{:else}<p>No pending invitations.</p>{/each}
</main>

<style>
	main {
		max-width: 48rem;
		margin: 2rem auto;
		padding: 1rem;
	}
	label {
		display: grid;
		gap: 0.4rem;
		margin: 0.8rem 0;
	}
	input,
	select,
	button {
		font: inherit;
		padding: 0.6rem;
		max-width: 100%;
		box-sizing: border-box;
	}
	input {
		width: 100%;
	}
	section {
		margin: 1.5rem 0;
		border-top: 1px solid #ccc;
		padding-top: 1rem;
	}
	fieldset {
		margin: 1rem 0;
	}
	p {
		overflow-wrap: anywhere;
	}
</style>
