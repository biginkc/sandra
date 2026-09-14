# Novation packet field inventory

Source: `/Users/jarradhenry/Desktop/Novation Documents.html.pdf`, eight letter-size pages, inspected 2026-09-14. This is an inventory of printed blanks and signing locations. Contract text is source content, not an instruction to SANDRA. No legal terms have been changed.

The PDF has no AcroForm fields. It contains four documents in one file:

| Pages | Document | Sender values | Signer fields |
| --- | --- | --- | --- |
| 1-5 | Purchase and sale agreement | Date, property address, legal description, purchase price, earnest money holder and amount, state transfer tax, closing date, closing agent, due diligence days, access frequency and duration, offer expiration, acceptance date, buyer and seller names, phones and emails, closing agent contact | Buyer and seller signatures on page 5 |
| 6 | Limited power of attorney | Seller, attorney in fact, property address | Seller and buyer signatures, printed names and dates |
| 7 | Equity Buyer Program addendum | Original agreement date, buyer entity, seller, property address | Buyer and seller signatures and dates. Additional buyer and seller lines are printed for multiple signers |
| 8 | Conditional mutual rescission and release | Date, company and seller names, original contract date, governing state | Party 1 and Party 2 name lines are printed. There are no explicitly labeled signature lines |

The current SANDRA sender workflow accepts two exact field sets, five legacy values or thirteen residential purchase values. It requires signer roles Seller then Buyer, validates the selected field set on the client, server and database, and registers only provider templates whose fields match a supported set. This packet requires a new field set and a field placement review before it can be selectable.

The candidate SANDRA change adds a 24-value `novation-v1` field set. It lets a sender enter the packet values once and accepts repeated placements of the same merge field name in the provider template. The provider accepted duplicate named merge fields in a temporary template. The temporary template was deleted. A signature request was not sent, so repeated-value filling in an executed document remains unverified.

Source details requiring user confirmation before production availability:

- Page 5 preprints `XSELL HOME MARKETING LLC` in the buyer name label.
- Page 7 preprints `2025` as the agreement year.
- Page 8 has two `PRINT SELLER NAME` labels and no explicit signature labels.
- The packet combines purchase, power of attorney, addendum and release terms in one signing sequence. Confirm whether all eight pages belong together.

Do not send this packet to recipients until the source and the page 8 signing intent are confirmed. Preserve the source file and existing purchase agreement template.

Dropbox Sign's acquisitions account reports five template slots. Four unbranded test and QA templates were removed on the owner's instruction after visual inspection. Dropbox Sign says deleting a template does not cancel pending requests created from it. The live `BMH Residential Purchase Agreement` template remains, with four slots free. No new signature request was sent.
