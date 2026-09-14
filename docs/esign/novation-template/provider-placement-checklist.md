# Dropbox Sign placement checklist for the novation packet

Use one of the two clean PDFs in this directory. Keep the existing residential purchase template untouched. This checklist is for a draft template and does not authorize a signature request.

## Roles

- One-seller PDF: `Seller` at order 0 and `Buyer` at order 1.
- Two-seller PDF: `Seller` at order 0, `Seller 2` at order 1, and `Buyer` at order 2.
- Put a required signature field for every role on every document's signature section. Do not assign a Seller 2 field to Seller.
- Use required signer-entered printed-name fields beside each signature. On page 5, use signer-entered phone and email fields for each seller, since the two sellers may have different contacts. SANDRA's `seller_phone` and `seller_email` sender values represent the lead's primary seller and must not be copied into Seller 2's contact blanks.

## Sender fields

Use these exact names, all as sender text fields. Reuse a name when the same value appears more than once. `additional_terms` is optional. Every other named sender field is required.

| Page | Placement | Sender field |
| --- | --- | --- |
| 1 | Agreement date, property address, tract or parcel description | `agreement_date`, `property_address`, `legal_description` |
| 1 | Price, seller closing-cost cap, earnest-money holder and amount | `offer_price`, `seller_closing_cost_cap`, `earnest_money_holder`, `earnest_money` |
| 2 | Transfer-tax state, closing date, closing agent | `property_state`, `closing_date`, `closing_agent_name` |
| 3 | Due-diligence business days | `due_diligence_days` |
| 4 | Access days per week, hours per visit, offer expiration | `access_days_per_week`, `access_hours_per_visit`, `offer_expiration` |
| 5 | Additional deal stipulations, contract property, acceptance date | `additional_terms`, `property_address`, `acceptance_date` |
| 5 | Buyer printed name, buyer phone and email | `buyer_name`, `buyer_phone`, `buyer_email` |
| 5 | Primary seller phone and email, closing company, phone and address | `seller_phone`, `seller_email`, `closing_agent_name`, `closing_agent_phone`, `closing_agent_address` |
| 6 | Seller names, attorney in fact, property | `seller_name`, `attorney_in_fact`, `property_address` |
| 7 | Agreement date, buyer name, seller names, property | `agreement_date`, `buyer_name`, `seller_name`, `property_address` |
| 8 | Release date, Party 1 buyer, Party 2 seller names, original contract date, state | `release_date`, `buyer_name`, `seller_name`, `agreement_date`, `property_state` |

For two sellers, enter both full legal names in `seller_name` as they should appear in the contract's shared Seller references. Each seller still has a distinct signer role and printed-name field. Check that both names fit every shared blank, especially pages 6 to 8. Check `additional_terms` with both an empty value and a realistic multi-line stipulation. If the PDF space is too small, revise the source HTML and re-export before registering.

## Verification gate

1. Read back provider metadata and confirm exact role order, 26 unique sender field names, required flags, and required signature fields for every role on pages 5 through 8.
2. Confirm repeated values appear in every intended location in a provider preview. Metadata acceptance alone does not prove rendering.
3. Confirm the printed legal clauses with the owner or their legal reviewer. JT's lesson does not address several fixed terms listed in `../jt-novation-instructions-crosswalk.md`.
4. Register the verified provider template in SANDRA. It will then appear in the template selector by name.
5. A live end-to-end signature test needs fresh authorization because the earlier three-request test allowance has been exhausted. Do not send a new request under the earlier allowance.
