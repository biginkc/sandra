# BMH signing confirmation

Public URL: https://sandra.bmhgroupkc.com/signing-complete

The page is the supplied Claude Design export, unpacked into standalone HTML with its original inline fonts and logo. The source export in the user's main checkout is preserved. The page does not load React, an unpacker, analytics, external assets, or application authentication. Copy and destinations are unchanged. Export fixes add document language/title, convert SVG and hover attributes into standard HTML/CSS, give the footer link a 44px target, allow narrow-screen email wrapping, and darken footer text from #7A716A to #766D66 to meet AA contrast.

SANDRA's Dropbox Sign provider sends the SDK `signingRedirectUrl` property, serialized as `signing_redirect_url`, with the fixed public URL for new templated signature requests. No recipient, property, or request value participates in this URL. Incoming query strings on the confirmation route are discarded with a redirect. The document uses no-referrer and a CSP that permits only inline styles and data fonts/images.

Dropbox describes this field as the destination after signers successfully sign. This is per-signer navigation, not the server-side `signature_request_all_signed` callback. The page intentionally confirms only the current person's signature; final-PDF processing still waits for all signers. Existing sent requests are unchanged.

References:
- https://developers.hellosign.com/api/signature-request/send-with-template
- https://help.dropbox.com/integrations/add-branding-api-dropbox-sign

Verification:
- Provider tests cover the fixed redirect in both live and test modes with private fixture values kept out of the URL.
- Middleware tests cover unauthenticated access with no Supabase initialization/cookies, query removal, and protection of adjacent paths.
- Browser checks at 320, 390, and 1440px verify no horizontal overflow, all link targets at least 44px, loaded fonts, visible 3px keyboard focus, and no external requests or page errors.
- axe WCAG A/AA and 2.1 AA checks have no violations after the footer contrast fix.
- No additional signature requests were sent. The prior three-request test authorization is exhausted. Per-signer redirect behavior is supported by the provider documentation and request configuration, not a new live signing observation.
