# Google Maps lead imagery

Sandra's lead-detail hero uses an official interactive Google Street View embed. A server-only metadata lookup checks coverage and calculates the heading toward the stored property coordinates. If Street View cannot resolve, Sandra automatically uses an aerial satellite embed; if neither coordinates nor a complete address can resolve, the normal flat lead header is shown.

## Required environment values

| Variable                          | Exposure           | Restriction                                                                                 |
| --------------------------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| `GOOGLE_MAPS_EMBED_KEY`           | Browser iframe URL | Maps Embed API only; restrict to Sandra production, Vercel preview, and localhost referrers |
| `GOOGLE_STREET_VIEW_METADATA_KEY` | Server only        | Street View Static API only; never prefix with `NEXT_PUBLIC_`                               |
| `GOOGLE_MAPS_URL_SIGNING_SECRET`  | Server only        | URL-signing secret for metadata requests; never expose in browser code or logs              |

Add all three values to Vercel production, preview, and development environments. Configure the browser key with these HTTP referrers for this rollout:

- `https://sandra.bmhgroupkc.com/*`
- `https://sandra-git-codex-sandra-lead-detail-v2-jarrad-5416s-projects.vercel.app/*`
- `http://localhost:3000/*`
- `http://127.0.0.1:3000/*`

Do not use a blanket `*.vercel.app` referrer. Add a future Sandra branch alias explicitly before accepting that preview. Keep Google controls and attribution visible; do not place overlays in the bottom attribution zone.

The iframe uses Google's recommended `strict-origin-when-cross-origin` referrer policy so website restrictions receive Sandra's origin without leaking the lead-detail path. Metadata requests are free and consume no Street View image quota. Sandra signs every server-side metadata request with the project signing secret; when the secret is missing, the resolver fails closed to aerial imagery instead of sending an unsigned request. The secret and metadata key must never be returned to the browser. In Google Cloud, set the Street View Static API's unsigned-request quota to zero after signed metadata has been verified.

No database migration is required. Sandra already loads `properties.lat` and `properties.lon` with the lead record.
