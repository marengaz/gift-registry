const MULTI_PART_PUBLIC_SUFFIXES = new Set([
	'co.uk',
	'org.uk',
	'me.uk',
	'ltd.uk',
	'plc.uk',
	'ac.uk',
	'gov.uk',
	'com.au',
	'net.au',
	'org.au',
	'co.nz',
	'co.za',
	'com.br',
	'co.jp',
	'com.sg',
	'com.hk'
]);

function isIpAddress(host: string): boolean {
	return /^\d+(\.\d+){3}$/.test(host) || host.includes(':');
}

function normaliseHost(raw: string): string | null {
	const host = raw
		.trim()
		.replace(/^\[|\]$/g, '')
		.toLowerCase()
		.replace(/\.+$/, '')
		.replace(/^www\d*\./, '');
	if (
		!host ||
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		!host.includes('.') ||
		isIpAddress(host) ||
		!/^[a-z0-9.-]+$/.test(host)
	)
		return null;
	return host;
}

/**
 * Extracts the top-level registrable domain (eTLD+1) from a URL or hostname,
 * ignoring subdomains and paths (e.g. `https://www.currys.co.uk/products/...` -> `currys.co.uk`).
 */
export function registrableDomain(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	let rawHost = trimmed;
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
		if (!URL.canParse(trimmed)) return null;
		const parsed = new URL(trimmed);
		if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
			return null;
		rawHost = parsed.hostname;
	} else if (/[/?#@:\s]/.test(trimmed)) {
		return null;
	}
	const host = normaliseHost(rawHost);
	if (!host) return null;
	const parts = host.split('.').filter(Boolean);
	if (parts.length < 2) return null;
	const lastTwo = parts.slice(-2).join('.');
	if (MULTI_PART_PUBLIC_SUFFIXES.has(lastTwo)) {
		if (parts.length < 3) return null;
		return parts.slice(-3).join('.');
	}
	return lastTwo;
}

export function quidcoSearchUrl(input: string): string | null {
	const domain = registrableDomain(input);
	if (!domain) return null;
	const parts = domain.split('.');
	const brand = parts[0]?.replace(/-/g, ' ').trim();
	if (!brand) return null;
	return `https://www.quidco.com/search/?q=${encodeURIComponent(brand)}`;
}
