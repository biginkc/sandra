# BMH signing confirmation

Public URL: https://bmhgroupkc.com/signing-complete

The user explicitly requires the BMH marketing domain, not the CRM hostname. The standalone page lives in biginkc/BMH-Home as signing-complete.html, served at the clean URL by Vercel. No page or public authentication exemption is added to SANDRA.

SANDRA's Dropbox Sign provider sends the SDK signingRedirectUrl property, serialized as signing_redirect_url, with this fixed public URL for new templated signature requests. No recipient, property, or request value participates in the URL.

Dropbox describes the field as the destination after each signer successfully signs. It is independent of signature_request_all_signed callbacks. Existing sent requests and final-PDF processing are unchanged.

References:
- https://developers.hellosign.com/api/signature-request/send-with-template
- https://help.dropbox.com/integrations/add-branding-api-dropbox-sign

Provider tests cover the exact fixed URL in live and test modes with private fixture values. No additional signature requests were sent because the prior three-request authorization is exhausted. Per-signer behavior is verified against provider documentation and request configuration, not a new live signing observation.
