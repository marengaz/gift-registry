<script lang="ts">
	import { authClient } from '#lib/client/auth.ts';
	let busy = $state(false);
	// Replace this handler when account-bound pending drafts are introduced.
	async function signOut() {
		busy = true;
		await authClient.signOut();
		window.location.assign('/login');
	}
</script>

<button class="quiet" disabled={busy} onclick={signOut}>{busy ? 'Signing out…' : 'Sign out'}</button
>
