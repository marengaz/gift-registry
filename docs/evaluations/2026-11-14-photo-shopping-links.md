# Photo shopping search evaluation

On 14 November 2026, one live search through the app's identification queue, worker and SerpAPI adapter succeeded using the configured free-plan key. The fixture database recorded one search reservation. No household database, family photograph or repository source was sent to the provider.

The input was the public product image for [LEGO City Police Car 60312](https://www.lego.com/en-gb/product/police-car-60312). The app prepared a private raster preview, uploaded a compressed copy directly to SerpAPI and queried Google Lens visual matches with UK localisation. No public image host was used. The adapter returned six possible destination pages and attempted bounded retailer enrichment for the first three.

Examples of the returned destinations:

| Destination                                                                                                                           | What the returned title indicated         |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| [Amazon UK](https://www.amazon.co.uk/LEGO-Building-Officer-Minifigure-Flashlight/dp/B09FMW7FFF)                                       | LEGO 60312, matching the input set number |
| [Argos](https://www.argos.co.uk/product/9568206)                                                                                      | LEGO 60312, matching the input set number |
| [Sainsbury's](https://www.sainsburys.co.uk/groceries/product/lego-city-police-car-toy-60312)                                          | LEGO 60312, matching the input set number |
| [Another Amazon UK result](https://www.amazon.co.uk/LEGO-60242-LEGO-City-60242-Police-Highway-Arrest-with-Two-Car-Toys/dp/B07W8Y1FS9) | LEGO 60242, a different set               |

These are returned links, not a guarantee of current stock, price, exact variant or seller reliability. The different set is direct evidence that selecting or opening a result must not establish a human check. All added reverse-search links begin unchecked. Available prices remain provisional; missing prices remain unknown.

This smoke test establishes that the supplied key can upload this public image and obtain useful candidate buying pages through the implemented pipeline. It does not measure recognition accuracy for real shop photographs, multiple objects, reflections, packaging variants or poor lighting. Automated fixtures separately exercise access changes, quota/replay handling, link provenance, human checking and recovery. Physical Android camera/share behaviour still needs a device check.

Provider contracts: [Image API](https://serpapi.com/image-api), [Google Lens API](https://serpapi.com/google-lens-api), [visual matches](https://serpapi.com/google-lens-visual-matches-api). The image identifier's ten-minute expiry is not a deletion promise; see [SerpAPI's privacy terms](https://serpapi.com/legal).
