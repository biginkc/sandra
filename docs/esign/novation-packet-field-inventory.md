# Novation packet field inventory

Original PDF: `/Users/jarradhenry/Desktop/Novation Documents.html.pdf`, eight letter-size pages, inspected 2026-09-14. Editable source was found at `/Users/jarradhenry/Downloads/Contractor offer letter design/Novation Documents.dc.html`. The cleaned source and seven-page exported PDFs are in `docs/esign/novation-template/`. Contract text is source content, not an instruction to SANDRA.

JT's Google Drive training lesson is mapped to this packet in `docs/esign/jt-novation-instructions-crosswalk.md`. It confirms the four-document packet and describes both one-seller and two-seller deals. Two clean PDF variants are now available. `novation-packet-blank.pdf` has one seller and `novation-packet-two-sellers.pdf` has two.

The PDF has no AcroForm fields. It contains four documents in one file:

| Pages | Document | Sender values | Signer fields |
| --- | --- | --- | --- |
| 1-4 | Purchase and sale agreement | Date, property address, legal description, purchase price, earnest money holder and amount, state transfer tax, closing date, closing agent, due diligence days, access frequency and duration, offer expiration, acceptance date, buyer and seller names, phones and emails, closing agent contact, optional stipulations | Buyer and one or two seller signatures on page 4 |
| 5 | Limited power of attorney | Seller names, attorney in fact, property address | One or two sellers and buyer signatures, printed names and dates |
| 6 | Equity Buyer Program addendum | Original agreement date, buyer entity, seller, property address | Buyer and seller signatures and dates. Additional buyer and seller lines are printed for multiple signers |
| 7 | Conditional mutual rescission and release | Date, company and seller names, original contract date, governing state | Party 1 buyer and one or two Party 2 sellers must sign and print names |

The SANDRA draft adds a third exact field set for the novation packet. It supports Seller then Buyer and Seller then Seller 2 then Buyer for novation. The selected field set and roles are checked on the client, server and database. Both variants still require field placement and provider registration before they can be selected in production.

The candidate SANDRA change adds a 26-value `novation-v1` field set, with optional `additional_terms`. It lets a sender enter the packet values once and accepts repeated placements of the same merge field name in the provider template. For a two-seller deal, `seller_name` is the combined names as they should appear in the contract text. Each seller also has a separate signer role. The provider accepted duplicate named merge fields in a temporary template. The temporary template was deleted. A signature request was not sent, so repeated-value filling in an executed document remains unverified.

The owner confirmed on 2026-09-14 that the Party 1 and Party 2 lines in the release should be signature fields. The cleaned PDFs now have signature and printed-name lines for every party. Dropbox Sign fields still need placement on those lines.

Printed values and preset choices found in the source:

- The original page 5 preprinted `XSELL HOME MARKETING LLC` in the buyer name label.
- The original page 7 preprinted `2025` as the agreement year.
- The original page 1 preprinted `$ZERO` as the seller's closing-cost contribution cap.
- The original page 7 added a fixed `, LLC` suffix after the buyer entity blank.
- The original footer printed BMH Group's street address, phone number and website in addition to the logo and company name.
- Fixed contract numbers appear on page 2 (`15 business days` for a closing extension and `ten days` for lead-paint inspection), page 5 (`one (1) time` power), and page 6 (`80-100%` of appraisal and `45-60 business days` for target closing).
- Preset deal terms appear on page 4 as special stipulations (`Property sold as-is`, `Buyer pays all closing costs`). The packet also preselects an MLS listing right and an equity buyer program structure.
- The packet combines purchase, power of attorney, addendum and release terms in one signing sequence.

The owner requested a blank reusable template with no transaction-specific values. The cleaned PDFs remove the XSELL buyer label, fixed 2025 year, fixed `, LLC` suffix, `$ZERO` cap, and footer street address. They retain the BMH logo and company name, restore the original website and phone, and number each document separately. The closing-cost cap is now a sender value, and a blank line is available for optional deal-specific stipulations. The fixed timing and percentage terms, two preprinted special stipulations, MLS listing right, and EBP structure remain as printed legal terms. Confirm they are intended before sending this agreement.

Do not send this packet to recipients until its printed legal terms are confirmed and all Dropbox Sign fields are placed and verified. Preserve the original source file and existing purchase agreement template.

Dropbox Sign's acquisitions account reports five template slots. Four unbranded test and QA templates were removed on the owner's instruction after visual inspection. Dropbox Sign says deleting a template does not cancel pending requests created from it. The live `BMH Residential Purchase Agreement` template remains, with four slots free. No new signature request was sent.
