<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { cropImage, fullImage, normaliseCrop, type CropBox } from '#lib/client/image-crop.ts';
	let {
		file,
		disabled = false,
		onReplace
	}: { file: File; disabled?: boolean; onReplace: (file: File) => void } = $props();
	let editing = $state(false);
	let busy = $state(false);
	let message = $state('');
	let original = $state<File>();
	let editingBase = $state<File>();
	let rotatedPreview = $state<File>();
	let preview = $state('');
	let selection = $state<CropBox>({ ...fullImage });
	let turns = $state(0);
	let stage: HTMLDivElement | undefined;
	let trackedFile: File | undefined;
	let expectedReplacement: File | undefined;
	let generation = 0;
	onDestroy(() => generation++);
	let drag: { x: number; y: number; pointer: number } | undefined;
	$effect(() => {
		const incoming = file;
		untrack(() => {
			if (incoming === trackedFile) return;
			trackedFile = incoming;
			if (incoming !== expectedReplacement) original = incoming;
			expectedReplacement = undefined;
			cancel();
		});
	});
	$effect(() => {
		const shown = editing && rotatedPreview ? rotatedPreview : file;
		const url = URL.createObjectURL(shown);
		preview = url;
		return () => URL.revokeObjectURL(url);
	});
	function cancel() {
		generation++;
		editing = false;
		busy = false;
		message = '';
		rotatedPreview = undefined;
		drag = undefined;
	}
	function start() {
		if (disabled) return;
		generation++;
		editingBase = file;
		selection = { ...fullImage };
		turns = 0;
		rotatedPreview = undefined;
		message = '';
		editing = true;
	}
	function change(key: keyof CropBox, event: Event) {
		const value = Number((event.target as HTMLInputElement).value);
		if (Number.isFinite(value)) selection = normaliseCrop({ ...selection, [key]: value });
	}
	function point(event: PointerEvent) {
		const bounds = stage!.getBoundingClientRect();
		return {
			x: Math.min(100, Math.max(0, ((event.clientX - bounds.left) / bounds.width) * 100)),
			y: Math.min(100, Math.max(0, ((event.clientY - bounds.top) / bounds.height) * 100))
		};
	}
	function beginDrag(event: PointerEvent) {
		if (!editing || busy || disabled || event.button !== 0) return;
		event.preventDefault();
		const position = point(event);
		drag = { ...position, pointer: event.pointerId };
		stage!.setPointerCapture(event.pointerId);
		selection = normaliseCrop({ left: position.x, top: position.y, width: 1, height: 1 });
	}
	function moveDrag(event: PointerEvent) {
		if (!drag || drag.pointer !== event.pointerId || busy || disabled) return;
		const position = point(event);
		selection = normaliseCrop({
			left: Math.min(drag.x, position.x),
			top: Math.min(drag.y, position.y),
			width: Math.abs(drag.x - position.x),
			height: Math.abs(drag.y - position.y)
		});
	}
	function endDrag(event: PointerEvent) {
		if (drag?.pointer !== event.pointerId) return;
		moveDrag(event);
		drag = undefined;
		if (stage?.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
	}
	async function rotate() {
		if (disabled || busy || !editingBase) return;
		const version = ++generation;
		const requested = file;
		busy = true;
		message = '';
		try {
			const nextTurns = (turns + 1) % 4;
			const result = await cropImage(editingBase, fullImage, nextTurns);
			if (version !== generation || requested !== file || disabled) return;
			turns = nextTurns;
			rotatedPreview = result;
			selection = { ...fullImage };
		} catch (error) {
			if (version === generation)
				message = error instanceof Error ? error.message : 'The image could not be rotated.';
		} finally {
			if (version === generation) busy = false;
		}
	}
	async function apply() {
		if (disabled || busy || !editingBase) return;
		const version = ++generation;
		const requested = file;
		busy = true;
		message = '';
		try {
			const result = await cropImage(editingBase, selection, turns);
			if (version !== generation || requested !== file || disabled) return;
			expectedReplacement = result;
			onReplace(result);
			cancel();
		} catch (error) {
			if (version === generation)
				message = error instanceof Error ? error.message : 'The cropped image could not be kept.';
		} finally {
			if (version === generation) busy = false;
		}
	}
	function restore() {
		if (disabled || !original) return;
		expectedReplacement = original;
		onReplace(original);
		cancel();
	}
</script>

<div class="image-capture-tools">
	<div
		class="crop-stage"
		class:editing
		bind:this={stage}
		role="group"
		aria-label={editing ? 'Image crop selection' : 'Image preview'}
		onpointerdown={beginDrag}
		onpointermove={moveDrag}
		onpointerup={endDrag}
		onpointercancel={() => (drag = undefined)}
	>
		<img src={preview} alt={file.name} draggable="false" />
		{#if editing}<div
				class="crop-selection"
				style:left={`${selection.left}%`}
				style:top={`${selection.top}%`}
				style:width={`${selection.width}%`}
				style:height={`${selection.height}%`}
			></div>{/if}
	</div>
	{#if editing}
		<p class="muted">Drag over the part to keep, or adjust the crop percentages below.</p>
		<fieldset class="crop-controls" disabled={disabled || busy}>
			<legend>Crop area</legend>
			{#each ['left', 'top', 'width', 'height'] as key}
				<label
					>Crop {key} (%)<input
						type="number"
						min={key === 'width' || key === 'height' ? 1 : 0}
						max="100"
						step="1"
						value={Math.round(selection[key as keyof CropBox])}
						oninput={(event) => change(key as keyof CropBox, event)}
					/></label
				>
			{/each}
		</fieldset>
		<div class="image-actions">
			<button type="button" class="quiet" disabled={disabled || busy} onclick={rotate}
				>Rotate right</button
			>
			<button
				type="button"
				class="quiet"
				disabled={disabled || busy}
				onclick={() => (selection = { ...fullImage })}>Reset crop</button
			>
			<button type="button" disabled={disabled || busy} onclick={apply}
				>{busy ? 'Preparing image…' : 'Use cropped image'}</button
			>
			<button type="button" class="quiet" onclick={cancel}>Cancel crop</button>
		</div>
		<p class="muted">
			Only the part you keep will be used when filling details or saving this image.
		</p>
	{:else}
		<div class="image-actions">
			<button type="button" class="quiet" {disabled} onclick={start}>Crop or rotate</button>
			{#if original && original !== file}<button
					type="button"
					class="quiet"
					{disabled}
					onclick={restore}>Restore original image</button
				>{/if}
		</div>
	{/if}
	{#if message}<p role="alert">{message}</p>{/if}
</div>

<style>
	.image-capture-tools {
		min-width: 0;
	}
	.crop-stage {
		position: relative;
		display: inline-block;
		max-width: 100%;
		overflow: hidden;
		line-height: 0;
	}
	.crop-stage img {
		display: block;
		max-width: 100%;
		max-height: 24rem;
		width: auto;
		height: auto;
	}
	.crop-stage.editing {
		touch-action: none;
		cursor: crosshair;
	}
	.crop-selection {
		position: absolute;
		box-sizing: border-box;
		border: 2px solid white;
		outline: 1px solid #203b43;
		box-shadow: 0 0 0 9999px #0008;
		pointer-events: none;
	}
	.crop-controls {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.5rem;
		min-width: 0;
		border: 0;
		padding: 0;
	}
	.crop-controls label {
		min-width: 0;
		font-size: 0.8rem;
	}
	.crop-controls input {
		width: 100%;
		box-sizing: border-box;
	}
	.image-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin: 0.5rem 0;
	}
	.muted {
		font-size: 0.8rem;
	}
</style>
