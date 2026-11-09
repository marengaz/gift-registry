/** Keep keyboard focus within a modal's currently enabled controls. */
export function containDialogFocus(event: KeyboardEvent & { currentTarget: HTMLDialogElement }) {
	if (event.key !== 'Tab') return;
	const dialog = event.currentTarget;
	const controls = [
		...dialog.querySelectorAll<HTMLElement>(
			'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
		)
	].filter((element) => element.getClientRects().length > 0);
	const first = controls[0];
	const last = controls.at(-1);
	if (!first || !last) return;
	if (
		event.shiftKey &&
		(document.activeElement === first || !dialog.contains(document.activeElement))
	) {
		event.preventDefault();
		last.focus();
	} else if (
		!event.shiftKey &&
		(document.activeElement === last || !dialog.contains(document.activeElement))
	) {
		event.preventDefault();
		first.focus();
	}
}
