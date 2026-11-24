import { useEffect, useRef, useState } from "react";
import { LogOut } from "lucide-react";
import type { Role } from "../../runtime/people";
import { api } from "./api";

interface SignedInPerson {
  email: string;
  role: Role;
}

const viewOnlyError = "You have view-only access. Ask an owner if you need to make changes.";
const refusedChangeKey = "wiser-crm-refused-change";

export function useSignedInPerson() {
  const [person, setPerson] = useState<SignedInPerson | null>(null);

  useEffect(() => {
    let mounted = true;
    let retry: number | undefined;
    async function load(attempt: number) {
      try {
        const { you } = await api<{ you: SignedInPerson | "agent" }>("GET", "/api/wiser/people");
        if (mounted && you !== "agent") setPerson(you);
      } catch {
        if (mounted && attempt < 3) {
          retry = window.setTimeout(() => { void load(attempt + 1); }, attempt * 200);
        }
      }
    }
    void load(1);
    return () => {
      mounted = false;
      window.clearTimeout(retry);
    };
  }, []);

  return person;
}

export function useViewOnlyRefusal(
  person: SignedInPerson | null,
  error: string | null,
  setError: (error: string | null) => void,
) {
  const gesturePending = useRef(false);
  const [writeRefused, setWriteRefused] = useState(false);
  const hideError = person !== null && error === viewOnlyError;

  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(refusedChangeKey) === "1") {
        setWriteRefused(true);
        window.sessionStorage.removeItem(refusedChangeKey);
      }
    } catch {
      // The page can still load when storage is blocked.
    }
  }, []);

  useEffect(() => {
    function recordGesture() {
      gesturePending.current = true;
    }
    function handleRejection(event: PromiseRejectionEvent) {
      if (event.reason?.message !== viewOnlyError) return;
      event.preventDefault();
      setError(viewOnlyError);
    }
    window.addEventListener("pointerdown", recordGesture, true);
    window.addEventListener("keydown", recordGesture, true);
    window.addEventListener("unhandledrejection", handleRejection);
    return () => {
      window.removeEventListener("pointerdown", recordGesture, true);
      window.removeEventListener("keydown", recordGesture, true);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, [setError]);

  useEffect(() => {
    if (!hideError) return;
    setError(null);
    if (!gesturePending.current) return;
    gesturePending.current = false;
    try {
      window.sessionStorage.setItem(refusedChangeKey, "1");
    } catch {
      // Reload to restore stored values even without a message on the next page.
    }
    window.location.reload();
  }, [hideError, setError]);

  return { writeRefused, hideError };
}

export function AccountFooter({ email, collapsed }: { email: string; collapsed: boolean }) {
  const labelClass = collapsed ? "md:sr-only" : undefined;
  return (
    <div className="wiser-account">
      <span className={labelClass}>Signed in as {email}</span>
      <a href="/cdn-cgi/access/logout" className="text-link" title={collapsed ? "Sign out" : undefined}>
        <span className={labelClass}>Sign out</span>
        {collapsed && <LogOut aria-hidden="true" className="hidden size-4 md:block" />}
      </a>
    </div>
  );
}

export function ViewOnlyBar({ writeRefused }: { writeRefused: boolean }) {
  return (
    <div className="wiser-view-only">
      <p><strong>View only.</strong>{" "}You can see everything here but can't change it. Ask an owner if you need to make changes.</p>
      <p role="status">{writeRefused ? "That change wasn't saved." : null}</p>
    </div>
  );
}
