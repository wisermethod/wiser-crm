import { useEffect, useRef, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { roles, type Role } from "../../runtime/people";
import { Button } from "./components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { useCrm } from "./context";

export const peoplePagePath = "/settings/people";
const apiPath = "/api/wiser/people";
const roleNames: Record<Role, string> = { owner: "Owner", member: "Member", viewer: "Viewer" };

interface Person {
  email: string;
  role: Role | null;
  first_owner?: boolean;
  added_by?: string;
}

interface PeopleList {
  you: { email: string; role: Role } | "agent";
  people: Person[];
}

function requestFailed(): never {
  throw new Error("Request failed");
}

async function peopleRequest(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(path, init).catch(requestFailed);
  if (!response.ok) {
    const body = await response.json<{ error?: string }>().catch(() => null);
    throw new Error(body?.error || "Request failed");
  }
  return response;
}

async function readPeople(signal?: AbortSignal): Promise<PeopleList> {
  return (await peopleRequest(apiPath, { signal })).json<PeopleList>().catch(requestFailed);
}

function RoleSelect({ id, label, value, disabled, onChange }: {
  id?: string;
  label?: string;
  value: Role | "";
  disabled: boolean;
  onChange: (role: Role) => void;
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger id={id} aria-label={label} className={id ? undefined : "h-7 w-32 gap-1 px-2.5"}>
        <SelectValue placeholder="Choose a role" />
      </SelectTrigger>
      <SelectContent>
        {roles.map((role) => <SelectItem key={role} value={role}>{roleNames[role]}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function WiserPeople() {
  const { setError } = useCrm();
  const [list, setList] = useState<PeopleList | null>();
  const [pending, setPending] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [newRole, setNewRole] = useState<Role>("member");
  const addButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement | null>(null);
  const you = list?.you === "agent" ? undefined : list?.you;
  const owner = you?.role === "owner";
  const active = list?.people.filter((person) => person.role !== null) ?? [];
  const waiting = owner && list ? list.people.filter((person) => person.role === null) : [];
  const count = active.length + waiting.length;

  useEffect(() => {
    const abort = new AbortController();
    void readPeople(abort.signal).then(setList, (error: unknown) => {
      if (abort.signal.aborted) return;
      setList(null);
      setError(error instanceof Error ? error.message : "Request failed");
    });
    return () => abort.abort();
  }, [setError]);

  async function change(address: string, role?: Role): Promise<boolean> {
    setPending(true);
    setError(null);
    try {
      await peopleRequest(`${apiPath}/${encodeURIComponent(address)}`, role === undefined
        ? { method: "DELETE" }
        : { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      // A refusal can mean the caller's own access changed since the list was
      // read. Read it again so the screen shows what is true now.
      try {
        setList(await readPeople());
      } catch {
        window.location.reload();
        return false;
      } finally {
        setPending(false);
      }
      setError(message);
      return false;
    }
    try {
      setList(await readPeople());
      return true;
    } catch {
      // The change was saved and the list can no longer be read, as when the
      // caller's own access changed. Load the page again and show what is true now.
      window.location.reload();
      return true;
    } finally {
      setPending(false);
    }
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (await change(email, newRole)) {
      setEmail("");
      setNewRole("member");
    }
    setAdding(false);
  }

  function row(person: Person) {
    // An owner changes other people. Their own row is another owner's to change.
    const editable = owner && !person.first_owner && person.email !== you?.email;
    return (
      <TableRow key={person.email} className="hover:bg-transparent">
        <TableCell className="h-10 pl-4 lg:pl-6">
          <span className="flex items-center gap-2" title={person.email}>
            <span aria-hidden="true" className="grid size-5 shrink-0 place-items-center rounded-full bg-[var(--accent-tint)] text-[9px] font-semibold text-[var(--accent-text)]">
              {person.email.slice(0, 2).toUpperCase()}
            </span>
            <span className="truncate">{person.email}</span>
          </span>
        </TableCell>
        <TableCell className="h-10">
          {editable ? (
            <RoleSelect label={`Role for ${person.email}`} value={person.role ?? ""} disabled={pending}
              onChange={(role) => void change(person.email, role)} />
          ) : (
            <span className="flex items-center gap-2">
              {person.role && (
                <span className={person.role === "owner"
                  ? "rounded-md bg-[var(--accent-tint)] px-2 text-xs font-medium text-[var(--accent-text)]"
                  : "rounded-md bg-secondary px-2 text-xs font-medium text-muted-foreground"}>
                  {roleNames[person.role]}
                </span>
              )}
              {person.first_owner && <span className="text-[13px] text-muted-foreground">First owner</span>}
              {you?.email === person.email && <span className="text-[13px] text-muted-foreground">You</span>}
            </span>
          )}
        </TableCell>
        {owner && (
          <>
            <TableCell className="hidden h-10 text-muted-foreground sm:table-cell" title={person.added_by}>
              {person.first_owner ? "Set at install" : person.role === null ? "Signed in, no role yet" : person.added_by}
            </TableCell>
            <TableCell className="h-10 pr-4 text-right lg:pr-6">
              {editable && (
                <Button type="button" variant="outline" className="shadow-edge px-2.5" disabled={pending}
                  aria-label={`Remove ${person.email}`} onClick={(event) => {
                    removeButton.current = event.currentTarget;
                    setRemoving(person.email);
                  }}>
                  Remove
                </Button>
              )}
            </TableCell>
          </>
        )}
      </TableRow>
    );
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-labelledby="wiser-people-title">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4 lg:px-6">
        <div className="flex items-baseline gap-2.5">
          <h1 id="wiser-people-title" className="text-[1.375rem] font-semibold tracking-[-0.01em]">People</h1>
          {list && (
            <span className="tabular text-[0.8125rem] text-muted-foreground">
              {count === 1 ? "1 person" : `${count} people`}
            </span>
          )}
        </div>
        {owner && (
          <Dialog open={adding} onOpenChange={(open) => { if (!pending) setAdding(open); }}>
            <DialogTrigger asChild>
              <Button ref={addButton} type="button" size="sm" disabled={pending}>
                <Plus aria-hidden="true" className="size-4" />
                Add person
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-[min(440px,calc(100%-2rem))]">
              <DialogHeader><DialogTitle>Add person</DialogTitle></DialogHeader>
              <form onSubmit={add} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="wiser-person-email">Email</Label>
                  <Input id="wiser-person-email" inputMode="email" autoComplete="email" required disabled={pending}
                    value={email} onChange={(event) => setEmail(event.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="wiser-person-role">Role</Label>
                  <RoleSelect id="wiser-person-role" value={newRole} disabled={pending} onChange={setNewRole} />
                </div>
                <DialogDescription>
                  {`This sets what they can do. To let a new person sign in, ask Wiser: "Add ${email || "jane@example.com"} to my CRM."`}
                </DialogDescription>
                <DialogFooter>
                  <DialogClose asChild><Button type="button" variant="outline" disabled={pending}>Cancel</Button></DialogClose>
                  <Button type="submit" className="px-3" disabled={pending || !email}>Add person</Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </header>

      {list === undefined && <p role="status" className="m-auto text-sm text-muted-foreground">Loading…</p>}
      {list && (
        <div className="min-h-0 flex-1 overflow-auto">
          <p className="border-b border-rule px-4 pb-3 pt-3.5 text-[13px] text-muted-foreground lg:px-6">
            Everyone who can use this CRM, and what each person can do.
            {!owner && " Only an owner can change this list."}
          </p>
          <Table grid className={owner ? "min-w-[26rem]" : "min-w-[18rem]"} aria-labelledby="wiser-people-title">
            {owner && <colgroup><col className="w-[38%] sm:w-[36%]" /><col className="w-[34%] sm:w-[26%]" /><col className="hidden sm:table-column" /><col className="w-28" /></colgroup>}
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className="pl-4 lg:pl-6">Email</TableHead>
                <TableHead scope="col">Role</TableHead>
                {owner && <><TableHead scope="col" className="hidden sm:table-cell">Added by</TableHead><TableHead aria-hidden="true" /></>}
              </TableRow>
            </TableHeader>
            <TableBody className="[&_tr:last-child]:border-b">{active.map(row)}</TableBody>
            {waiting.length > 0 && (
              <TableBody className="[&_tr:last-child]:border-b" aria-labelledby="wiser-waiting-title">
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={4} className="h-auto whitespace-normal pb-2 pl-4 pt-4 lg:pl-6">
                    <h2 id="wiser-waiting-title" className="font-medium">Waiting for a role</h2>
                    <p className="mt-0.5 text-[13px] text-muted-foreground">These people can sign in but see nothing until you give them a role.</p>
                  </TableCell>
                </TableRow>
                {waiting.map(row)}
              </TableBody>
            )}
          </Table>
        </div>
      )}

      <Dialog open={removing !== null} onOpenChange={(open) => { if (!open && !pending) setRemoving(null); }}>
        <DialogContent className="max-w-[min(440px,calc(100%-2rem))]" onCloseAutoFocus={(event) => {
          event.preventDefault();
          (removeButton.current?.isConnected ? removeButton.current : addButton.current)?.focus();
        }}>
          <DialogHeader>
            <DialogTitle className="break-all">{`Remove ${removing}?`}</DialogTitle>
            <DialogDescription>They lose access straight away.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild><Button type="button" variant="outline" disabled={pending}>Cancel</Button></DialogClose>
            <Button type="button" variant="destructive" className="px-3" disabled={pending} onClick={async () => {
              if (!removing || pending) return;
              await change(removing);
              setRemoving(null);
            }}>Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
