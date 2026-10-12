import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col justify-center px-6">
      <h1 className="text-lg font-semibold">Not found</h1>
      <p className="mt-2 text-muted">
        That project, episode or shot doesn&apos;t exist, or it isn&apos;t yours to open.
      </p>
      <Link href="/" className="mt-4 text-accent underline-offset-2 hover:underline">
        Back to projects
      </Link>
    </main>
  );
}
