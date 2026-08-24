# Google Maps lead imagery

Sandra's lead-detail hero uses an official static Google Street View image. A server-only metadata lookup checks coverage by stored coordinates or validated complete address. The image request uses that same location and omits `heading`, allowing Google to aim the camera toward the property automatically. If Street View cannot resolve or the image fails to load, Sandra uses a static aerial satellite image; if neither image resolves, the normal flat lead header is shown.

## Required environment values

| Variable                          | Exposure                 | Restriction                                                                                                  |
| --------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `GOOGLE_MAPS_STATIC_KEY`          | Signed browser image URL | Street View Static and Maps Static APIs only; restrict to Sandra production, explicit previews, and localhost |
| `GOOGLE_STREET_VIEW_METADATA_KEY` | Server only              | Street View Static API only; never prefix with `NEXT_PUBLIC_`                                                |
| `GOOGLE_MAPS_URL_SIGNING_SECRET`  | Server only              | Same-project URL-signing secret for metadata and image requests; never expose in browser code or logs       |

Add all three values to Vercel production, preview, and development environments. Configure the browser key with these HTTP referrers for this rollout:

- `https://sandra.bmhgroupkc.com/*`
- `https://sandra-jarrad-5416s-projects.vercel.app/*`
- `https://sandra-git-main-jarrad-5416s-projects.vercel.app/*`
- `http://localhost:3000/*`
- `http://127.0.0.1:3000/*`

Do not use a blanket `*.vercel.app` referrer. Add a future Sandra branch alias explicitly before accepting that preview. Google bakes its logo, copyright, and provider attribution into static imagery; never crop, filter, proxy, cache, or obscure that attribution.

The raw image uses Google's recommended `strict-origin-when-cross-origin` referrer policy so website restrictions receive Sandra's origin without leaking the lead-detail path. It points directly to Google's signed URL; do not pass it through Next Image optimization or an application proxy. Metadata requests are free and consume no image quota. Each Static Street View or Maps Static image load consumes its respective SKU allowance; both currently include 10,000 monthly requests at no charge. Sandra signs metadata and image URLs with the project signing secret and fails flat rather than emitting unsigned imagery when required configuration is missing. The secret and metadata key must never be returned to the browser. After signed production images are verified, set unsigned-request quota to zero for both static APIs.

No database migration is required. Sandra already loads `properties.lat` and `properties.lon` with the lead record.
