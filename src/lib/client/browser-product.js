/** @param {string} targetPage */
function saveGift(targetPage) {
	const host = location.hostname.replace(/^www\./, '');
	/** @type {Record<string, RegExp>} */
	const paths = {
		'smythstoys.com': /\/p\/\d+\/?$/,
		'thetoyshop.com': /\/p\/\d+\/?$/,
		'argos.co.uk': /^\/product\/\d+\/?$/,
		'currys.co.uk': /^\/products\/[^/]+\.html$/,
		'etsy.com': /^\/(?:uk\/)?listing\/\d+\//,
		'hamleys.com': /^\/[^/]+\/?$/,
		'lego.com': /^\/en-gb\/product\//,
		'theworks.co.uk': /^\/p\/.+\.html$/,
		'johnlewis.com': /\/p\d+\/?$/
	};
	if (
		location.protocol !== 'https:' ||
		!Object.hasOwn(paths, host) ||
		!paths[host].test(location.pathname)
	) {
		alert('Open a product page at one of the supported shops, then choose Save gift again.');
		return;
	}
	/** @param {unknown} value */
	const text = (value, limit = 4000) => {
		if (typeof value !== 'string' && typeof value !== 'number') return '';
		const template = document.createElement('template');
		template.innerHTML = String(value).slice(0, 16000);
		return (template.content.textContent || '').trim().slice(0, limit);
	};
	/** @param {unknown} value */
	const url = (value) => {
		if (typeof value !== 'string' || !value.trim()) return '';
		try {
			const result = new URL(value, location.href);
			return result.protocol === 'https:' && !result.username && !result.password
				? result.href.slice(0, 4000)
				: '';
		} catch {
			return '';
		}
	};
	/** @param {string} name */
	const meta = (name) =>
		document
			.querySelector(`meta[property="${name}"],meta[name="${name}"]`)
			?.getAttribute('content') || '';
	/** @param {unknown} value @returns {Record<string, unknown>} */
	const object = (value) =>
		value && typeof value === 'object' && !Array.isArray(value)
			? /** @type {Record<string, unknown>} */ (value)
			: {};
	/** @param {unknown} node @param {string} name */
	const isType = (node, name) =>
		[object(node)['@type']]
			.flat()
			.some(
				(value) =>
					typeof value === 'string' && value.replace(/^https?:\/\/schema.org\//, '') === name
			);
	/** @type {Record<string, unknown>[]} */
	const products = [];
	let visited = 0;
	/** @param {unknown} node */
	const walk = (node, depth = 0) => {
		if (!node || typeof node !== 'object' || depth > 8 || ++visited > 500) return;
		if (Array.isArray(node)) {
			for (const child of node) walk(child, depth + 1);
			return;
		}
		const value = object(node);
		if (isType(value, 'Product') || isType(value, 'ProductGroup')) {
			products.push(value);
			return;
		}
		for (const key of ['@graph', 'mainEntity', 'itemListElement', 'item'])
			walk(value[key], depth + 1);
	};
	for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
		if (visited > 500) break;
		const raw = script.textContent || '';
		if (raw.length > 128000) continue;
		try {
			walk(JSON.parse(raw));
		} catch {}
	}
	const heading = text(document.querySelector('h1')?.textContent, 500);
	/** @param {unknown} value */
	const samePage = (value) => {
		if (typeof value !== 'string') return false;
		try {
			return (
				new URL(value, location.href).pathname.replace(/\/$/, '') ===
				location.pathname.replace(/\/$/, '')
			);
		} catch {
			return false;
		}
	};
	const product =
		products.find(
			(item) =>
				(item.url && samePage(item.url)) ||
				text(item.name, 500).toLowerCase() === heading.toLowerCase()
		) ||
		products[0] ||
		{};
	const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
	const offer = object(offers[0]);
	const primaryPrice = [
		'.js-pdp-price .price',
		'[itemprop="price"]',
		'[data-price-type="finalPrice"] .price',
		'[data-testid="product-price"]',
		'[data-test="product-price"]'
	]
		.map((selector) => document.querySelector(selector))
		.find(Boolean);
	const rawPrice = offer.price ?? offer.lowPrice;
	const priceText = text(
		rawPrice ??
			(meta('product:price:amount') ||
				primaryPrice?.getAttribute('content') ||
				primaryPrice?.textContent),
		80
	);
	let currency = text(
		offer.priceCurrency ||
			meta('product:price:currency') ||
			document.querySelector('[itemprop="priceCurrency"]')?.getAttribute('content'),
		3
	).toUpperCase();
	if (!currency && /^£\s*\d/.test(priceText)) currency = 'GBP';
	let picture = Array.isArray(product.image) ? product.image[0] : product.image;
	if (picture && typeof picture === 'object')
		picture = object(picture).url || object(picture).contentUrl;
	const photo = document.querySelector(
		'.image-gallery__image img, [itemprop="image"], .product-image-photo'
	);
	const imageUrl =
		url(picture) ||
		url(meta('og:image') || meta('twitter:image')) ||
		url(photo?.getAttribute('src') || photo?.getAttribute('content'));
	const title = text(product.name || heading || meta('og:title') || document.title, 500);
	if (
		!title ||
		/^(access denied|just a moment|attention required|error(?:\s|:|$)|please wait|captcha)/i.test(
			title
		) ||
		(!products.length && !imageUrl && !priceText)
	) {
		alert(
			'Wait until the product page is visible, including any shop checks, then choose Save gift again.'
		);
		return;
	}
	const variants = Array.isArray(product.hasVariant) && product.hasVariant.length > 1;
	const source = new URL(location.href);
	source.username = '';
	source.password = '';
	source.hash = '';
	const payload = {
		version: 1,
		sourceUrl: source.href,
		title,
		description: text(product.description || meta('og:description') || meta('description'), 2000),
		variant: variants
			? ''
			: [text(product.color, 200), text(product.size, 200)].filter(Boolean).join(' · '),
		imageUrl,
		priceText,
		currency,
		fromPrice:
			isType(offer, 'AggregateOffer') ||
			offer.lowPrice !== undefined ||
			offers.length > 1 ||
			/^from\b/i.test(priceText)
	};
	const target = new URL(targetPage);
	target.hash = 'gift=' + encodeURIComponent(JSON.stringify(payload));
	if (target.hash.length > 64000) {
		alert('These product details are too long. Copy the link into Family gifts instead.');
		return;
	}
	location.assign(target.href);
}
