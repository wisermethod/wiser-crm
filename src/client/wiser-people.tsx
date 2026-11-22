import { useEffect, useState, type FormEvent } from "react";
import { roles, type Role } from "../../runtime/people";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";

export const peoplePagePath = "/settings/people";
const apiPath = "/api/wiser/people";

interface Person {
  email: string;
  role: Role | null;
  first_owner?: boolean;
}

interface PeopleList {
  you: { email: string; role: Role } | "agent";
  people: Person[];
}

async function readPeople(signal?: AbortSignal): Promise<PeopleList> {
  const response = await fetch(apiPath, { signal });
  if (!response.ok) throw new Error("Could not load people.");
  return response.json();
}

function RoleSelect({ label, value, disabled, onChange }: {
  label: string;
  value: Role | "";
  disabled: boolean;
  onChange: (role: Role) => void;
}) {
  return (
    <select
      aria-label={label}
      className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as Role)}
    >
      {value === "" && <option value="" disabled>Waiting</option>}
      {roles.map((role) => <option key={role} value={role}>{role}</option>)}
    </select>
  );
}

export function WiserPeople() {
  const [list, setList] = useState<PeopleList>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [email, setEmail] = useState("");
  const [newRole, setNewRole] = useState<Role>("viewer");
  const owner = list?.you !== "agent" && list?.you.role === "owner";

  useEffect(() => {
    const abort = new AbortController();
    void readPeople(abort.signal).then(setList, () => {
      if (!abort.signal.aborted) setError("Could not load people.");
    });
    return () => abort.abort();
  }, []);

  async function change(address: string, role?: Role): Promise<boolean> {
    setPending(true);
    setError("");
    try {
      const response = await fetch(`${apiPath}/${encodeURIComponent(address)}`, role === undefined
        ? { method: "DELETE" }
        : { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }) });
      if (!response.ok) {
        const body = await response.json<{ error?: string }>();
        setError(body.error ?? "Could not save the change.");
        return false;
      }
      setList(await readPeople());
      return true;
    } catch {
      setError("Could not refresh the people list.");
      return false;
    } finally {
      setPending(false);
    }
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await change(email, newRole)) setEmail("");
  }

  return (
    <section className="overflow-auto p-6" aria-labelledby="wiser-people-title">
      <h1 id="wiser-people-title" className="text-xl font-semibold">People</h1>
      <p className="mb-4 mt-1 text-sm text-muted-foreground">Ask Wiser to add someone to sign-in. Set what they can do here.</p>
      {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
      {!list && !error && <p role="status">Loading people…</p>}
      {owner && (
        <form className="mb-4 flex flex-wrap items-end gap-2" onSubmit={add}>
          <label className="grid gap-1 text-sm">
            Email
            <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={pending} />
          </label>
          <RoleSelect label="New person’s role" value={newRole} onChange={setNewRole} disabled={pending} />
          <Button type="submit" disabled={pending}>Set role</Button>
        </form>
      )}
      {list && (
        <ul className="divide-y divide-border" aria-label="People and roles">
          {list.people.map((person) => (
            <li key={person.email} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <span className="min-w-0 flex-1 break-all">{person.email}</span>
              {owner && !person.first_owner ? (
                <>
                  <RoleSelect label={`Role for ${person.email}`} value={person.role ?? ""} disabled={pending}
                    onChange={(role) => void change(person.email, role)} />
                  <Button type="button" variant="outline" disabled={pending} aria-label={`Remove ${person.email}`}
                    onClick={() => void change(person.email)}>Remove</Button>
                </>
              ) : <span>{person.first_owner ? "First owner" : person.role ?? "Waiting"}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
