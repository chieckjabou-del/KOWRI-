import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

export function ScreenContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#fcfcfb] pb-24">
      <main className="page-enter mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 pt-5">{children}</main>
    </div>
  );
}

export function SectionIntro({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
}) {
  return (
    <section className="premium-card rounded-3xl px-5 py-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-black tracking-tight text-black sm:text-2xl">{title}</h1>
          <p className="mt-1 text-sm text-gray-500">{subtitle}</p>
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
    </section>
  );
}

export function SkeletonCard({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("premium-card rounded-3xl px-5 py-5", className)}>
      <Skeleton className="skeleton-shimmer h-4 w-32 rounded-full" />
      <div className="mt-4 space-y-2.5">
        {Array.from({ length: rows }).map((_, idx) => (
          <Skeleton
            key={`row-${idx}`}
            className={cn(
              "skeleton-shimmer h-11 rounded-xl",
              idx === rows - 1 ? "w-2/3" : "w-full",
            )}
          />
        ))}
      </div>
    </div>
  );
}

export function EmptyHint({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-200 bg-white/70 px-5 py-6 text-center">
      <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-xl bg-gray-100 text-gray-500">
        <Sparkles className="h-4 w-4" />
      </div>
      <p className="mt-3 text-sm font-semibold text-black">{title}</p>
      <p className="mx-auto mt-1 max-w-xs text-xs text-gray-500">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

