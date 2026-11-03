<script lang="ts">
	import { money } from '#lib/catalogue-types.ts';
	import type { ListTotals } from '#lib/server/totals.ts';
	let { totals }: { totals: ListTotals } = $props();
</script>

<section class="totals" aria-label="List totals">
	{#each [{ name: 'All gifts', value: totals.all }, { name: 'Allocated', value: totals.allocated }, { name: 'Purchased', value: totals.purchased }] as item}
		<div>
			<p>{item.name}</p>
			<strong>{money(item.value.pence)}</strong><small
				>{item.value.count}
				{item.value.count === 1 ? 'gift' : 'gifts'} · {item.value.unknown} unknown</small
			>
		</div>
	{/each}
	<p class="explanation">
		All gifts and allocated gifts use GBP estimates. Allocated includes purchased gifts. Purchased
		uses actual spend where entered; {totals.purchased.estimatedCount}
		{totals.purchased.estimatedCount === 1
			? 'purchase uses its estimate'
			: 'purchases use their estimates'}.
	</p>
</section>

<style>
	.totals {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 1rem;
		padding: 1.2rem;
		border: 1px solid #e7e4dd;
		border-radius: 1rem;
		margin: 1.2rem 0 2rem;
		background: #fff;
	}
	p {
		margin: 0 0 0.35rem;
		font-size: 0.85rem;
	}
	strong {
		font-size: clamp(1rem, 4vw, 1.5rem);
	}
	small {
		display: block;
		margin-top: 0.4rem;
		color: #625e55;
		font-size: 0.75rem;
	}
	.explanation {
		grid-column: 1 / -1;
		margin: 0.3rem 0 0;
		line-height: 1.5;
		color: #625e55;
	}
</style>
