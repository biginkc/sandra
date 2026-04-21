import { JobsList } from "./jobs-list";

export const metadata = {
  title: "Jobs · Sandra CRM",
};

export default function JobsPage() {
  return (
    <div className="flex flex-col gap-4 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Jobs</h1>
        <p className="text-muted-foreground text-sm">
          Every non-instant operation — imports, enrichment runs, scheduled
          sweeps — shows up here with live status.
        </p>
      </div>
      <JobsList />
    </div>
  );
}
