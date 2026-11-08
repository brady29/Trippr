import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-md px-4 py-20 text-center">
      <div className="font-mono text-5xl font-semibold">404</div>
      <p className="mt-3 text-ink-soft">That page has departed.</p>
      <Link href="/" className="mt-6 inline-block text-sm font-medium text-sky hover:underline">
        Back to my trips
      </Link>
    </main>
  );
}
