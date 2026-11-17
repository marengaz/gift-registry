<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import type { SiteRole } from '#lib/catalogue-types.ts';
	import type { PageProps } from './$types';
	const siteRoleLabels: Record<SiteRole, string> = {
		administrator: 'Administrator',
		collaborator: 'Collaborator',
		buyer: 'Gift buyer',
		guest: 'Guest'
	};
	let { data }: PageProps = $props();
	let email = $state('');
	let inviteRole = $state<SiteRole>('guest');
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
		const grants =
			inviteRole === 'administrator' || inviteRole === 'collaborator'
				? []
				: Object.entries(selected)
						.filter(([, role]) => role && (inviteRole === 'guest' || role === 'contributor'))
						.map(([listId, role]) => ({ listId, role }));
		const result = await update({
			action: 'invite',
			email: email.trim(),
			role: inviteRole,
			grants
		});
		if (result) {
			invitationUrl = result.url;
			email = '';
			inviteRole = 'guest';
			selected = {};
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
		Manage site-wide roles and per-list permissions at any time. Invitation links last seven days
		and work once, with the intended Google email.
	</p>
	{#if data.superAdministrator}<section>
			<h2>Super administrator</h2>
			<h3>{data.superAdministrator.name}</h3>
			<p>{data.superAdministrator.email}</p>
			<p class="muted">Environment-configured super administrator (permanent full access).</p>
		</section>{/if}
	<form
		onsubmit={(event) => {
			event.preventDefault();
			invite();
		}}
	>
		<h2>Create invitation</h2>
		<label>Google email <input type="email" required bind:value={email} /></label>
		<label
			>Site-wide permission<select bind:value={inviteRole}
				><option value="guest">Guest (list permissions only)</option><option value="buyer"
					>Gift buyer (all lists)</option
				><option value="collaborator">Collaborator (all lists &amp; catalogue)</option><option
					value="administrator">Administrator (full access)</option
				></select
			></label
		>
		{#if inviteRole === 'guest' || inviteRole === 'buyer'}<fieldset>
				<legend
					>{inviteRole === 'buyer'
						? 'Extra list collaborator permissions'
						: 'List permissions'}</legend
				>{#each data.lists.filter((list) => !list.archivedAt) as list}<label
						>{list.recipientName} · {list.name}<select
							value={selected[list.id] ?? ''}
							onchange={(event) => {
								selected[list.id] = event.currentTarget.value;
							}}
							>{#if inviteRole === 'buyer'}<option value="">Gift buyer (default)</option><option
									value="contributor">List collaborator</option
								>{:else}<option value="">No access</option><option value="viewer">Viewer</option
								><option value="buyer">List gift buyer</option><option value="contributor"
									>List collaborator</option
								>{/if}</select
						></label
					>{/each}
			</fieldset>{/if}
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
	<h2>People</h2>
	{#each data.people as person}<section>
			<h3>{person.name}</h3>
			<p>
				{person.email} · {person.member ? siteRoleLabels[person.role] : 'Signed in (no access yet)'}
			</p>
			<label
				>Site-wide permission<select
					disabled={busy || person.id === data.currentUserId}
					value={person.role}
					onchange={(event) =>
						update({
							action: 'siteRole',
							userId: person.id,
							role: event.currentTarget.value
						})}
					><option value="guest">Guest</option><option value="buyer">Gift buyer</option><option
						value="collaborator">Collaborator</option
					><option value="administrator">Administrator</option></select
				></label
			>
			{#if person.role === 'guest' || person.role === 'buyer'}<fieldset>
					<legend
						>{person.role === 'buyer'
							? 'Extra list collaborator permissions'
							: 'List permissions'}</legend
					>{#each data.lists.filter((list) => !list.archivedAt) as list}{@const grantedRole =
							data.grants.find((grant) => grant.userId === person.id && grant.listId === list.id)
								?.role ?? ''}<label
							>{list.recipientName} · {list.name}<select
								disabled={busy}
								value={person.role === 'buyer' && grantedRole !== 'contributor' ? '' : grantedRole}
								onchange={(event) =>
									update({
										action: 'grant',
										userId: person.id,
										listId: list.id,
										role: event.currentTarget.value || null
									})}
								>{#if person.role === 'buyer'}<option value="">Gift buyer (site-wide)</option
									><option value="contributor">List collaborator</option>{:else}<option value=""
										>No access</option
									><option value="viewer">Viewer</option><option value="buyer"
										>List gift buyer</option
									><option value="contributor">List collaborator</option>{/if}</select
							></label
						>{/each}
				</fieldset>{/if}
			{#if person.member}<button
					disabled={busy || person.id === data.currentUserId}
					onclick={() => update({ action: 'revokeMember', userId: person.id })}
					>Revoke access and sessions</button
				>{/if}
		</section>{:else}<p>No one else has signed in or been invited yet.</p>{/each}
	<h2>Pending invitations</h2>
	{#each data.invitations as invitation}<section>
			<p>
				{invitation.email} · {siteRoleLabels[invitation.role]} · expires {new Date(
					invitation.expiresAt
				).toLocaleDateString('en-GB')}
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
	form {
		margin-bottom: 2rem;
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
