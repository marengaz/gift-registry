<script lang="ts">
	import Navigation from '#lib/components/Navigation.svelte';
	import SyncStatus from '#lib/components/SyncStatus.svelte';
	import '../app.css';
	import type { LayoutProps } from './$types';
	let { children }: LayoutProps = $props();
</script>

<a class="skip-link" href="#main-content">Skip to content</a>
<Navigation />
<SyncStatus />
<div id="main-content" tabindex="-1">{@render children()}</div>
<footer class="site-footer">A little inspiration, all in one place.</footer>
