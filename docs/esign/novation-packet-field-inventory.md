# Novation packet field inventory

Original PDF: `/Users/jarradhenry/Desktop/Novation Documents.html.pdf`, eight letter-size pages, inspected 2026-09-14. Editable source was found at `/Users/jarradhenry/Downloads/Contractor offer letter design/Novation Documents.dc.html`. The cleaned source and exported PDF are in `docs/esign/novation-template/`. Contract text is source content, not an instruction to SANDRA.

The PDF has no AcroForm fields. It contains four documents in one file:

| Pages | Document | Sender values | Signer fields |
| --- | --- | --- | --- |
| 1-5 | Purchase and sale agreement | Date, property address, legal description, purchase price, earnest money holder and amount, state transfer tax, closing date, closing agent, due diligence days, access frequency and duration, offer expiration, acceptance date, buyer and seller names, phones and emails, closing agent contact | Buyer and seller signatures on page 5 |
| 6 | Limited power of attorney | Seller, attorney in fact, property address | Seller and buyer signatures, printed names and dates |
| 7 | Equity Buyer Program addendum | Original agreement date, buyer entity, seller, property address | Buyer and seller signatures and dates. Additional buyer and seller lines are printed for multiple signers |
| 8 | Conditional mutual rescission and release | Date, company and seller names, original contract date, governing state | Party 1 and Party 2 must sign. The source has unlabeled lines and duplicate `PRINT SELLER NAME` labels that need correction before field placement |

The current SANDRA sender workflow accepts two exact field sets, five legacy values or thirteen residential purchase values. It requires signer roles Seller then Buyer, validates the selected field set on the client, server and database, and registers only provider templates whose fields match a supported set. This packet requires a new field set and a field placement review before it can be selectable.

The candidate SANDRA change adds a 25-value `novation-v1` field set. It lets a sender enter the packet values once and accepts repeated placements of the same merge field name in the provider template. The provider accepted duplicate named merge fields in a temporary template. The temporary template was deleted. A signature request was not sent, so repeated-value filling in an executed document remains unverified.

The owner confirmed on 2026-09-14 that the Party 1 and Party 2 lines on page 8 should be signature fields. The cleaned PDF now has signature and printed-name lines for both parties. Dropbox Sign fields still need placement on those lines.

Printed values and preset choices found in the source:

- Page 5 preprints `XSELL HOME MARKETING LLC` in the buyer name label.
- Page 7 preprints `2025` as the agreement year.
- Page 1 preprints `$ZERO` as the seller's closing-cost contribution cap.
- Page 7 adds a fixed `, LLC` suffix after the buyer entity blank.
- Every page prints BMH Group's street address, phone number and website in the footer in addition to the logo and company name.
- Fixed contract numbers appear on page 2 (`15 business days` for a closing extension), page 3 (`ten days` for lead-paint inspection), page 6 (`one (1) time` power), and page 7 (`80-100%` of appraisal and `45-60 business days` for target closing).
- Preset deal terms appear on page 5 as special stipulations (`Property sold as-is`, `Buyer pays all closing costs`). The packet also preselects an MLS listing right and an equity buyer program structure.
- The packet combines purchase, power of attorney, addendum and release terms in one signing sequence.

The owner requested a blank reusable template with no transaction-specific values. The cleaned PDF removes the XSELL buyer label, fixed 2025 year, fixed `, LLC` suffix, `$ZERO` cap, and footer contact details. It retains the BMH logo and company name. The closing-cost cap is now a sender value. The fixed timing and percentage terms, special stipulations, MLS listing right, and EBP structure remain as printed legal terms. Confirm they are intended before sending this agreement.

Do not send this packet to recipients until its printed legal terms are confirmed and all Dropbox Sign fields are placed and verified. Preserve the original source file and existing purchase agreement template.

Dropbox Sign's acquisitions account reports five template slots. Four unbranded test and QA templates were removed on the owner's instruction after visual inspection. Dropbox Sign says deleting a template does not cancel pending requests created from it. The live `BMH Residential Purchase Agreement` template remains, with four slots free. No new signature request was sent.
