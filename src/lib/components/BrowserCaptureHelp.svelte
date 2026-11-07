<script lang="ts">
	import { page } from '$app/state';
	import { browserCaptureButton } from '#lib/client/browser-capture.ts';
	let message = $state('');
	const button = $derived(browserCaptureButton(page.url.origin));
	async function copy() {
		try {
			await navigator.clipboard.writeText(button);
			message = 'Copied. Paste this into the URL of a bookmark named Save gift.';
		} catch {
			message = 'Copy the bookmark code from the field below.';
		}
	}
</script>

<details class="browser-capture-help">
	<summary>Save from a shop page</summary>
	<p>
		Some shops block link lookups. This free browser button copies the product details from the page
		you can already see.
	</p>
	<p class="bookmark-row">
		<a class="button secondary" href={button}>Save gift</a><span
			>On a computer, drag this button to your bookmarks bar.</span
		>
	</p>
	<p>
		On Android Chrome, bookmark any page, rename it <strong>Save gift</strong>, then edit its URL
		and paste the code below. On a shop page, type <strong>Save gift</strong> in the address bar and choose
		that bookmark.
	</p>
	<button type="button" class="quiet" onclick={copy}>Copy bookmark code</button>
	{#if message}<p role="status">{message}</p>{/if}
	<details>
		<summary>Bookmark code</summary><label
			>Save gift code<textarea readonly value={button} rows="3"></textarea></label
		>
	</details>
	<p>
		<small
			>Use on product pages from Smyths, Argos, Currys, Etsy, Hamleys, The Entertainer, LEGO UK, The
			Works, John Lewis. Open a product page first, then choose Save gift. Review the captured
			details and adopt the device draft with your signed-in account before saving. It copies
			product fields only.</small
		>
	</p>
</details>

<style>
	.browser-capture-help {
		margin: 1rem 0;
		font-size: 0.85rem;
		border-top: 1px solid var(--line);
		padding-top: 0.5rem;
	}
	.bookmark-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.8rem;
	}
	textarea {
		font-family: monospace;
		font-size: 0.75rem;
	}
</style>
