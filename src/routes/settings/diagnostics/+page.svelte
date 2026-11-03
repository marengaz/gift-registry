<script lang="ts">
	import type { PageProps } from './$types';
	let { data }: PageProps = $props();
	const status = (value: boolean) => (value ? 'Ready' : 'Needs attention');
</script>

<svelte:head><title>Server checks · Family gifts</title></svelte:head>
<main class="narrow">
	<div class="page-heading">
		<div>
			<p class="eyebrow">Home server</p>
			<h1>Server checks</h1>
			<p class="muted">
				Local checks for the administrator. These do not contact Google or prove a real sign-in.
			</p>
		</div>
	</div>
	<section class="panel">
		<h2>Application readiness</h2>
		<dl>
			<dt>Database integrity and write access</dt>
			<dd>{status(data.readiness.database)}</dd>
			<dt>Private image storage</dt>
			<dd>{status(data.readiness.media)}</dd>
			<dt>Required Google sign-in settings</dt>
			<dd>{status(data.readiness.authentication)}</dd>
		</dl>
	</section>
	<section class="panel">
		<h2>HTTPS proxy</h2>
		<p>
			Incoming address matches the configured sign-in address: <strong
				>{data.proxy.originMatches ? 'Yes' : 'No'}</strong
			>
		</p>
		<p>
			Trusted forwarded protocol is configured: <strong
				>{data.proxy.forwardedProtocolConfigured ? 'Yes' : 'No'}</strong
			>
		</p>
		{#if !data.proxy.originMatches}<p class="notice error" role="alert">
				The request address differs from the configured origin. Check the HTTPS proxy and origin
				settings before using forms or sign-in.
			</p>{/if}
	</section>
	<section class="panel">
		<h2>Identification worker</h2>
		<p>
			Personal provider settings: {data.identificationConfigured
				? 'Configured'
				: 'Not configured; ordinary capture still works'}
		</p>
		<dl>
			<dt>Queued lookups</dt>
			<dd>{data.jobs.queued}</dd>
			<dt>Running lookups</dt>
			<dd>{data.jobs.running}</dd>
			<dt>Uncertain paid results</dt>
			<dd>{data.jobs.uncertain}</dd>
		</dl>
		<p class="muted">
			Uncertain requests keep their allowance reservation. Review their evidence before making
			another explicit request.
		</p>
		<a href="/settings/identification">Identification settings</a>
	</section>
</main>

<style>
	dl {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0.7rem;
	}
	dd {
		margin: 0;
		font-weight: 650;
	}
	dt {
		min-width: 0;
	}
</style>
