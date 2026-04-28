import { Download, MessageSquare, Repeat } from "lucide-react";
import Link from "next/link";

export function QuickActions() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <Action
        href="/import"
        label="Import a list"
        icon={Download}
        variant="outline"
      />
      <Action
        href="/sequences/new"
        label="Start a sequence"
        icon={Repeat}
        variant="solid"
      />
      <Action
        href="/messages"
        label="View messages"
        icon={MessageSquare}
        variant="outline"
      />
    </div>
  );
}

type ActionProps = {
  href: string;
  label: string;
  icon: typeof Download;
  variant: "solid" | "outline";
};

function Action({ href, label, icon: Icon, variant }: ActionProps) {
  const base =
    "flex h-14 items-center justify-center gap-3 rounded-full px-6 text-sm font-bold transition-colors";
  const solid = "bg-foreground text-background hover:opacity-90";
  const outline =
    "border-border border-2 text-foreground hover:bg-foreground hover:text-background";
  return (
    <Link href={href} className={`${base} ${variant === "solid" ? solid : outline}`}>
      <Icon className="size-4" aria-hidden />
      {label}
    </Link>
  );
}
