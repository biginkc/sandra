# CLOSR offer calculator

## Who can use it

Active Acquisitions group members can open **Calculators**, create calculations, and save revisions. Active owners retain calculator access even without the Acquisitions designation. Non-owner access still requires the organization's calculator workflow to be enabled. Any active teammate who can access the lead can read its saved calculations and timeline entries.

## Calculate an offer

1. Open the lead's **Calculations** section and choose **New calculation** to attach that lead automatically. From the **Calculators** navigation item, use **Attach a lead** and search an address or seller name.
2. In **Novation**, enter the property's true as-is market value, desired profit and nine itemized expenses. As-is value is different from renovated after-repair value.
3. Listing percentage starts locked at 90%. Click its lock icon to edit it, then relock. Commission stays 4% of as-is value, even when the listing percentage changes.
4. In **Wholesale**, enter ARV and investor rehab. The rehab reference table is a guide; novation buyer-requested repairs are a separate input.
5. Compare the yellow results. Program amounts and wholesale fee tiers are negotiation anchors. They do not compute complete seller net proceeds.
6. Record the selected approach, program or fee tier, proposed offer, negotiated terms and seller motivation. The proposed offer is a separate decision; selecting an anchor does not send an offer.
7. **Save to lead** creates a completed snapshot and timeline entry. You must attach a lead first. A retry preserves your entries and avoids duplicating an already committed save.
8. Reopen a saved version from the lead to see its original inputs and results. Acquisitions members can create a new version; earlier versions remain intact.

Blank numeric inputs count as zero and produce a notice. Check missing as-is value and ARV before relying on the comparison.

## Worksheet math

No intermediate rounding is applied. Dollar displays show two decimal places.

| Result | Formula |
|---|---|
| Commission | As-is value × 4% |
| Listing price | As-is value × listing percentage (90% by default) |
| Equity Protection | Listing price − commission − nine itemized expenses − desired profit |
| Family Placement | Equity Protection × 85% |
| Secure Close | Equity Protection × 75% |
| Rapid Relief | Equity Protection × 67% |
| Investor price | ARV × 70% − rehab |
| Seller offer, $40,000 fee | Investor price − $40,000 |
| Seller offer, $30,000 fee | Investor price − $30,000 |
| Seller offer, $20,000 fee | Investor price − $20,000 |
| Seller offer, $10,000 fee | Investor price − $10,000 |

The original workbook's broken, unused B16 is excluded. Itemized expenses means the nine entered expenses and excludes commission. The implementation preserves the source worksheet's arithmetic evaluation order, including its investor-price reference chain.

## Common mistakes

- Using renovated comps for the as-is value.
- Combining buyer-requested repairs with wholesale investor rehab.
- Treating an anchor, listing price, investor price and seller net proceeds as the same amount.
- Assuming commission is calculated on listing price; this worksheet calculates it on as-is value.
- Assuming a saved calculation sends an offer or changes the lead to Offer Sent. It does neither.
