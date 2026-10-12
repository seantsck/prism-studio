import { LogOut } from "lucide-react";
import { signOut } from "@/server/auth-actions";
import type { AppUser } from "@/server/auth";

/** Account line + sign-out (server action; works without client JS). Hidden in demo mode. */
export function UserMenu({ user }: { user: AppUser }) {
  if (user.kind === "local") {
    return <div className="text-[10.5px] text-faint">Demo mode · local data</div>;
  }
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="min-w-0 truncate text-[10.5px] text-muted" title={user.email ?? user.id}>
        {user.email ?? "Signed in"}
      </span>
      <form action={signOut}>
        <button
          type="submit"
          className="inline-flex items-center gap-1 text-[10.5px] text-muted hover:text-fg"
          aria-label="Sign out"
        >
          <LogOut className="h-3 w-3" /> Sign out
        </button>
      </form>
    </div>
  );
}
