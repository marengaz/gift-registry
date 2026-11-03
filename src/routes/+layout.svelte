<script lang="ts">
	import favicon from '#lib/assets/favicon.svg';
	import Navigation from '#lib/components/Navigation.svelte';
	import SyncStatus from '#lib/components/SyncStatus.svelte';
	import '../app.css';
	import type { LayoutProps } from './$types';
	let { children }: LayoutProps = $props();
</script>

<svelte:head
	><link rel="icon" href={favicon} /><meta name="theme-color" content="#213b43" /></svelte:head
>
<a class="skip-link" href="#main-content">Skip to content</a>
<Navigation />
<SyncStatus />
<div id="main-content" tabindex="-1">{@render children()}</div>
<footer class="site-footer">A little inspiration, all in one place.</footer>
