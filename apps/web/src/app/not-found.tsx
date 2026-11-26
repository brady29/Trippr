import Link from "next/link";
import { Flaps } from "@/components/shell";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-md px-4 py-20 text-center">
      <div className="flaps-outlined inline-block text-4xl" aria-hidden>
        <Flaps text="404" />
      </div>
      <h1 className="mt-5 text-lg font-semibold">That page has departed</h1>
      <p className="mt-1 text-sm text-ink-soft">The link may be old, or the trip or route may have been removed.</p>
      <Link
        href="/"
        className="mt-6 inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-medium text-on-accent hover:bg-accent-hover"
      >
        Back to my trips
      </Link>
    </main>
  );
}
