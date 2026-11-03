<script lang="ts">
	import type { PageProps } from './$types';
	let { data, form }: PageProps = $props();
</script>

<svelte:head><title>Accept invitation · Family gifts</title></svelte:head>
<main>
	<h1>Join family gifts</h1>
	<p>Accept this invitation as {data.email}.</p>
	<p>It will add the list permissions chosen by the administrator.</p>
	<form method="POST"><button>Accept invitation</button></form>
	{#if form?.message}<p role="alert">{form.message}</p>{/if}
</main>

<style>
	main {
		max-width: 40rem;
		margin: 3rem auto;
		padding: 1rem;
	}
	button {
		font: inherit;
		padding: 0.8rem 1rem;
	}
</style>
