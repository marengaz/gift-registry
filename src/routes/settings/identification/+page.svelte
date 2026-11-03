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
				Retailer metadata is free to retrieve. Image matching uses your personal Google Vision
				project.
			</p>
		</div>
	</div>
	<section class="panel">
		<h2>This UTC month: {data.month}</h2>
		<p>
			{usd(data.reservedMicrodollars)} reserved of {usd(data.monthlyLimitMicrodollars)}. {usd(
				data.remainingMicrodollars
			)} remains.
		</p>
		<p class="muted">
			Every image is counted at the full conservative unit cost, including free-tier requests.
			Timeouts and uncertain results stay reserved. This limits requests admitted by this app; it
			does not cap the project's entire Google bill.
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
			><input type="checkbox" bind:checked={enabled} /><span>Enable paid image identification</span
			></label
		><label>Monthly allowance (USD)<input inputmode="decimal" bind:value={allowance} /></label>
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
