<script lang="ts">
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
	let enabled = $state(untrack(() => data.enabled));
	let allowance = $state(untrack(() => (data.monthlyLimitMicrodollars / 1000000).toFixed(2)));
	let unit = $state(untrack(() => String(data.unitMicrodollars)));
	let revision = $state(untrack(() => data.pricingRevision));
	let busy = $state(false);
	let message = $state('');
	const usd = (micro: number) =>
		new Intl.NumberFormat('en-GB', {
			style: 'currency',
			currency: 'USD',
			maximumFractionDigits: 4
		}).format(micro / 1000000);
	async function save() {
		busy = true;
		message = '';
		try {
			if (!/^\d+(\.\d{1,6})?$/.test(allowance))
				throw new Error('Enter a USD allowance with up to six decimal places.');
			const [whole, part = ''] = allowance.split('.');
			const monthlyLimitMicrodollars = Number(whole) * 1000000 + Number(part.padEnd(6, '0'));
			const response = await fetch('/api/identification', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					enabled,
					monthlyLimitMicrodollars,
					unitMicrodollars: Number(unit),
					pricingRevision: revision
				})
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.message);
			await invalidateAll();
			message = 'Identification settings saved.';
		} catch (error) {
			message = error instanceof Error ? error.message : 'Settings could not be saved.';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Identification · Family gifts</title></svelte:head>
<main class="narrow">
	<div class="page-heading">
		<div>
			<p class="eyebrow">Optional help</p>
			<h1>Product identification</h1>
			<p class="muted">
				The existing retailer reader runs first. Gemini can fill missing details from readable
				pages, text and selected screenshots. Ordinary capture always works without AI.
			</p>
		</div>
	</div>
	<section class="panel">
		<h2>Gemini help with gift details</h2>
		<p>
			{data.gemini.configured
				? 'Gemini is configured on the server.'
				: 'Set GEMINI_API_KEY on the server to configure Gemini.'}
		</p>
		<p>{data.gemini.enabled ? 'AI help is enabled.' : 'Enable AI help below to use it.'}</p>
		<p>
			{usd(data.gemini.reservedMicrodollars)} reserved of {usd(
				data.gemini.monthlyLimitMicrodollars
			)} this UTC month; {usd(data.gemini.remainingMicrodollars)} remains.
		</p>
		<p class="muted">
			Each request reserves {usd(data.gemini.reservationMicrodollars)} conservatively, including failed
			or uncertain requests. Evaluations are included in this allowance and have their own {usd(
				data.gemini.evaluationLimitMicrodollars
			)} limit. The environment limits and the administrator's allowance both apply; the smaller remaining
			allowance wins.
		</p>
	</section>
	<section class="panel">
		<h2>Find buying links from photos</h2>
		<p>
			{data.serpapi?.configured
				? 'SerpAPI Google Lens is configured on the server.'
				: 'Set SERPAPI_API_KEY on the server to configure photo search.'}
		</p>
		{#if data.serpapi}<p>
				{data.serpapi.used} of {data.serpapi.limit} app searches reserved this UTC month;
				{data.serpapi.remaining} remain.
			</p>{/if}
		<p class="muted">
			Searching sends a compressed photo to SerpAPI and Google. Results may be incorrect until a
			person checks the linked product and variant. This search count is separate from the USD
			allowance below and the provider's account-wide allowance. Uncertain requests remain counted.
		</p>
	</section>
	<section class="panel">
		<h2>Google Vision and Gemini: {data.month}</h2>
		<p>
			{usd(data.reservedMicrodollars)} reserved of {usd(data.monthlyLimitMicrodollars)}. {usd(
				data.remainingMicrodollars
			)} remains.
		</p>
		<p class="muted">
			Every Google Vision image is counted at the full conservative unit cost, including free-tier
			requests. Timeouts and uncertain results stay reserved. This limits requests admitted by this
			app; it does not cap the project's entire Google bill.
		</p>
		<p>
			{data.provider.ready
				? `Personal project: ${data.provider.projectId}`
				: 'Personal Vision credentials have not been configured on the server. Ordinary capture and retailer metadata still work.'}
		</p>
	</section>
	<form
		onsubmit={(event) => {
			event.preventDefault();
			void save();
		}}
		class="panel"
	>
		<label class="check-label"
			><input type="checkbox" bind:checked={enabled} /><span
				>Enable AI help and paid image identification</span
			></label
		><label>Monthly allowance (USD)<input inputmode="decimal" bind:value={allowance} /></label>
		<p class="muted">
			This switch also enables SerpAPI photo searches. Their monthly search limit is set separately
			with SERPAPI_MONTHLY_SEARCH_LIMIT on the server.
		</p>
		<details>
			<summary>Conservative pricing</summary><label
				>Microdollars per image<input inputmode="numeric" bind:value={unit} /></label
			><label>Pricing revision<input bind:value={revision} /></label>
			<p class="muted">
				3500 microdollars is US$0.0035 per image. With US$1, at most 285 requests are admitted.
				Raise the unit cost before using a higher published rate.
			</p>
		</details>
		<div class="form-actions">
			<button disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
		</div>
	</form>
	{#if message}<p class="notice" role="status">{message}</p>{/if}
</main>
