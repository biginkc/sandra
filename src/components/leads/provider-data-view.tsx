import { formatDollars } from "@/lib/calculators/closr-v1";
import type { ProviderData } from "@/lib/comps/provider-data";

const STATUS_COPY: Record<ProviderData["salesStatus"], string> = {
  ok: "ATTOM returned nearby sale records. Check property similarity and disclosed prices before using them as comps.",
  minimum_not_met: "ATTOM did not find the minimum number of sales matching the search criteria.",
  not_entitled: "This ATTOM key does not have access to comparable sales.",
  none: "ATTOM returned no comparable sales for this search.",
  unmapped: "ATTOM returned a response, but Sandra could not read any comparable sale records. These comps are not verified.",
  unavailable: "Comparable sale details are unavailable from this response.",
};

export function ProviderDataView({ data }: { data: ProviderData | null | undefined }) {
  if (!data) return <p className="text-muted-foreground text-sm">Source property details are unavailable.</p>;
  return (
    <div className="space-y-3" data-testid="attom-provider-data">
      <p className="text-sm" data-testid="attom-sales-status">{STATUS_COPY[data.salesStatus]}</p>
      {data.search ? <p className="text-muted-foreground text-xs">Search: {data.search}</p> : null}
      {data.sales.length ? (
        <div className="overflow-x-auto">
          <p className="text-muted-foreground mb-2 text-xs">{data.sales.length} returned sale records. Undisclosed prices are excluded from priced-comp calculations.</p>
          <table className="w-full text-left text-xs" data-testid="attom-source-sales">
            <caption className="sr-only">ATTOM nearby sale records</caption>
            <thead><tr>{["Address", "Sale date", "Sale price", "Sq ft", "Beds / baths", "Year", "Distance"].map((label) => <th key={label} scope="col" className="pr-3 pb-2 font-medium">{label}</th>)}</tr></thead>
            <tbody>{data.sales.map((sale, i) => (
              <tr key={`${sale.providerId ?? sale.address}-${sale.saleDate}-${i}`}>
                <td className="min-w-44 py-2 pr-3">{sale.address}</td>
                <td className="whitespace-nowrap pr-3">{sale.saleDate}</td>
                <td className="whitespace-nowrap pr-3">{sale.salePrice === null ? "Not disclosed" : formatDollars(sale.salePrice)}</td>
                <td className="pr-3">{sale.sqft?.toLocaleString("en-US") ?? "Unknown"}</td>
                <td className="whitespace-nowrap pr-3">{sale.beds ?? "?"} / {sale.baths ?? "?"}</td>
                <td className="pr-3">{sale.yearBuilt ?? "Unknown"}</td>
                <td className="whitespace-nowrap">{sale.distanceMiles === null ? "Unknown" : `${sale.distanceMiles.toFixed(2)} mi`}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : null}
      <details open className="rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-medium">ATTOM property data</summary>
        <dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2" data-testid="attom-property-facts">
          {data.facts.map(({label,value}) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="break-words font-medium">{label.endsWith("value") || label.endsWith("amount") ? formatDollars(Number(value)) : value}</dd></div>)}
        </dl>
      </details>
    </div>
  );
}
