# JT novation paperwork lesson crosswalk

Source: [What Paperwork Do You Need For Novation? transcript](https://drive.google.com/file/d/1IEZxVj_sDCtf6zorHArn5ApxOG9hn_0A/view?usp=drivesdk), a five-minute training video transcript stored in Google Drive. A second library copy has materially the same transcript. Compared with `docs/esign/novation-template/novation-packet-blank.pdf` on 2026-09-14. The lesson describes one operator's process and explicitly disclaims legal advice. It is guidance for mapping fields, not authority to rewrite legal terms.

## What the lesson says to fill for each deal

| Time | Packet location | Per-deal values or action |
| --- | --- | --- |
| 00:00-00:28 | Whole packet | Use the purchase agreement, limited power of attorney, EBP addendum, and conditional rescission and release. The BMH packet contains all four. |
| 00:44-01:13 | Purchase agreement, pages 1-2 | Offer date, property address, parcel ID, purchase price, title company or closing agent, earnest money, property state, closing date, and closing agent again. |
| 01:03-01:37 | Closing and inspection, pages 2-3 | For his novation process he suggests a closing window of at least 60 days. His examples use 45 business days of inspection for a 60-day closing and 60 days for a 90-day closing. These are per-deal choices, not values to print on the master PDF. The 60-day example is not an exact two-thirds calculation. |
| 01:39-01:52 | Access, page 3 | He starts with three access days per week and one hour per visit, but says the seller can request different terms. Keep both values blank in the master PDF. |
| 01:54-02:17 | Offer and special stipulations, pages 3-4 | He puts the offer expiration on the next day and adds transaction-specific stipulations such as debt payoff or post-closing occupancy when needed. Keep expiration and additional stipulations fillable. |
| 02:17-02:41 | Acceptance and signatures, page 4 | Enter the acceptance date, buyer information, seller one and seller two names and signatures, and title company contact information. |
| 02:41-03:00 | Limited power of attorney, page 5 | Enter the attorney-in-fact name, seller names, and property address. Seller one, seller two, and buyer sign. |
| 03:02-03:42 | EBP addendum, page 6 | Repeat the agreement date, full buyer legal name, seller names, and property address. He says the buyer may be an LLC or an individual, then buyer and seller or sellers sign. No fixed `, LLC` suffix belongs in the master PDF. |
| 03:51-04:50 | Conditional rescission, page 7 | Enter signing date, buyer or company name, seller names, original agreement date, and property state. Buyer and seller or sellers sign and print names. He expects all packet documents to be signed together. |

## Current gaps to resolve before registration

- The draft now includes separate one-seller and two-seller PDFs and SANDRA supports both signer role layouts. Neither PDF has Dropbox Sign fields placed yet. Verify each signature and printed-name placement in every document before registration.
- The sender field is named `legal_description`, while the lesson says to enter parcel ID in the purchase agreement description area. The draft UI labels it `Parcel ID / legal description` for novation. Confirm the entry has sufficient space in the rendered packet.
- The cleaned PDFs now provide a blank additional-stipulations line and the sender UI has an optional `additional_terms` value. Its provider field placement and behavior still need verification.
- The seller closing-cost contribution cap is now blank and fillable. The lesson does not say what amount to use.
- The lesson does not discuss the printed 15-business-day extension, ten-day lead-paint inspection, one-time power language, 80-100% appraisal statement, 45-60-business-day EBP target, as-is term, buyer-pays-all-closing-costs term, or MLS/listing authorization. It cannot decide whether those legal terms should remain, change, or become fillable.
- The lesson's suggested 60-day closing window and the printed EBP target of 45-60 **business** days use different time units. Do not equate them or silently make one a default for the other.

Do not send the novation packet until repeated field placements, optional stipulations, signer assignments, and the printed legal terms are resolved and verified. Registration can be used as a non-sending verification step after Dropbox Sign fields are placed.
