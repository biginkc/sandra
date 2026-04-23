import { CreateSequenceForm } from "./form";

export default function NewSequencePage() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">New sequence</h1>
        <p className="text-muted-foreground text-sm">
          Name it and describe what it&apos;s for. You&apos;ll add steps on the next screen.
        </p>
      </div>
      <CreateSequenceForm />
    </div>
  );
}
