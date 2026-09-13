# BMH signing confirmation

Public URL: https://bmhgroupkc.com/signing-complete

The user explicitly requires the BMH marketing domain, not the CRM hostname. The standalone page lives in biginkc/BMH-Home as signing-complete.html, served at the clean URL by Vercel. No page or public authentication exemption is added to SANDRA.

SANDRA's Dropbox Sign provider sends the SDK signingRedirectUrl property, serialized as signing_redirect_url, with this fixed public URL for new templated signature requests. No recipient, property, or request value participates in the URL.

Dropbox describes the field as the destination after each signer successfully signs. It is independent of signature_request_all_signed callbacks. Existing sent requests and final-PDF processing are unchanged.

References:
- https://developers.hellosign.com/api/signature-request/send-with-template
- https://help.dropbox.com/integrations/add-branding-api-dropbox-sign

Provider tests cover the exact fixed URL in live and test modes with private fixture values. No additional signature requests were sent because the prior three-request authorization is exhausted. Per-signer behavior is verified against provider documentation and request configuration, not a new live signing observation.

## Invitation email

New requests use `BMH Group | Purchase agreement for [property address]` as their subject. Test mode adds `TEST | ` and an internal-test warning. The message identifies the persisted preparer, gives signing instructions, explains that the completed copy arrives once everyone has signed, and directs questions to acquisitions@bmhgroupkc.com.

Invitation copy contains no em dashes or semicolons. Display values are normalized only for the email, leaving contract merge values and stored history intact. Subjects are capped at 255 characters. Dropbox Sign still controls its email transport and hosted branding. This change does not add a custom From address, logo, or paid branding feature.

Maria can use the existing SANDRA purchase agreement flow. The invitation is generated automatically from the saved property and preparer. Previously sent invitations are not rewritten. Verification uses mocked provider dispatch, with no additional signature requests.
