# Save ideas from shops

Paste a product link into **Add an idea**. Available shop details fill empty fields. If a shop blocks the lookup, use the free **Save gift** browser bookmark to copy details from the product page you have open.

## Add the browser button

Open **Add an idea → Save from a shop page** in Family gifts.

- On a computer, drag **Save gift** to your browser's bookmarks bar.
- On Android Chrome, bookmark any page and rename the bookmark **Save gift**. In Family gifts, select **Copy bookmark code**, edit the bookmark's URL, and paste the copied code. Chrome may require you to select the bookmark from the address-bar suggestions rather than type the code directly.

The button points to the Family gifts address where you created it. Add it again if you change the app's address. On a phone, use an app address the phone can reach; `localhost` points to the phone itself.

## Capture a product

1. Open the product page in your usual browser. Let the page finish loading and complete any shop checks yourself.
2. Choose the **Save gift** bookmark. In Android Chrome, type **Save gift** in the address bar and select the bookmark suggestion.
3. Review the captured details in Family gifts. Choose **Adopt with my signed-in account**, select any lists, and choose **Save idea**.

The capture is kept as an unbound device draft before the page address is cleared. It joins your catalogue only after you adopt and save it. You can edit any field. If a photo cannot be copied, retry it or add your own.

The button reads product metadata and product fields. It does not read cookies, passwords, form inputs, or account details. The product payload travels in the app URL fragment, which browsers do not send in the HTTP request. Photos use the app's existing public-image importer. Retailer HTML and scripts are not uploaded.

Prices are snapshots. A from-price or ambiguous offer stays out of the GBP estimate. Foreign prices retain their published currency. Missing fields stay blank for you to complete.

## Live checks on 7 November 2026

These are checks of the linked products from this development environment, not a guarantee for every page or future retailer change. For passing links, the image was downloaded and decoded as well as extracted from the page.

| Shop            | Checked product                                                                                                                                                                                               | Direct link result                                                       | Free alternative   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------ |
| Smyths          | [Supplied Nintendo console](https://www.smythstoys.com/uk/en-gb/gaming-and-tech/nintendo-switch-2/nintendo-switch-2-consoles/nintendo-switch-2-the-legend-of-zelda-40th-anniversary-edition-console/p/266502) | HTTP 403 before product content                                          | Save gift bookmark |
| The Entertainer | [LEGO Stitch and Scrump 43296](https://www.thetoyshop.com/construction-toys/building-blocks/LEGO-Disney-Stitch-And-Scrump-Construction-Set-43296/p/582531)                                                    | Title, description, image and £50.00 GBP                                 | Save gift bookmark |
| Argos           | [LEGO Concorde 10318](https://www.argos.co.uk/product/3376913)                                                                                                                                                | HTTP 403 before product content                                          | Save gift bookmark |
| LEGO UK         | [Police Car 60312](https://www.lego.com/en-gb/product/police-car-60312)                                                                                                                                       | Title, description, image and £8.99 GBP                                  | Save gift bookmark |
| Hamleys         | [LEGO Stitch 43249](https://www.hamleys.com/legor-disney-stitch-buildable-kids-toy-playset-43249)                                                                                                             | HTTP 403 before product content                                          | Save gift bookmark |
| The Works       | [Doctor role-play set](https://www.theworks.co.uk/p/role-play-toys/playworks-pretend-and-play-doctor-role-play-set/5052089328631.html)                                                                        | Title, image and £7.00 GBP; no description published in product metadata | Save gift bookmark |
| Currys          | [Nintendo Switch 2](https://www.currys.co.uk/products/nintendo-switch-2-10281815.html)                                                                                                                        | HTTP 403 before product content                                          | Save gift bookmark |
| Etsy            | [Wooden train listing](https://www.etsy.com/uk/listing/1395933334/montessori-wooden-train-stacking-sorting)                                                                                                   | HTTP 403 and a site challenge                                            | Save gift bookmark |
| John Lewis      | [Cinderella castle 43283](https://www.johnlewis.com/lego-disney-43283-cinderella-animal-friends-castle-building-toy/p115349819)                                                                               | Title, description, image and £18.74 GBP                                 | Save gift bookmark |

Fresh automated browsers and ordinary request-header changes did not remove the five access blocks. Search-result prices were not imported because they could be stale or refer to another currency or variant. No paid service or retailer account credentials are configured for this feature.

Browser tests use representative shop pages to verify capture, photo transfer, review and saving across these nine URL patterns. The actual phone bookmark setup and capture from a shop that is blocked here still need checking in your normal browser. If a browser or a site's policy prevents bookmark scripts, keep using the link, manual details and photo fields.
