import { addWaitingPerson, isReadMethod, isRole, listPeople, mayWritePeople, plainEmail, removePerson, setPersonRole } from "../runtime/people/index.ts";
import type { PeopleDatabase, Role } from "../runtime/people/index.ts";

export const peoplePath = "/api/wiser/people";
const noStore = { "Cache-Control": "no-store" };
const bodyLimit = 1024;
const drainLimit = 64 * 1024;
const waitingTitle = "You're signed in, but not set up yet";
const waitingLine = "An owner of this CRM needs to give you a role. Ask them, then reload this page.";
type PersonCaller = { email: string; role: Role };
export type PeopleCaller = PersonCaller | "agent";

export function refusal(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status, headers: { ...noStore, "Content-Type": "application/json; charset=utf-8" },
  });
}

export function acceptsHtml(request: Request): boolean {
  return request.headers.get("Accept")?.split(",").some((entry) => {
    const [type, ...parameters] = entry.trim().toLowerCase().split(";");
    return type.trim() === "text/html" && !parameters.some((parameter) => /^q\s*=\s*0(?:\.0*)?$/.test(parameter.trim()));
  }) ?? false;
}

export async function waitForRole(
  request: Request, db: PeopleDatabase, email: string, shouldAdd: boolean,
): Promise<Response> {
  if (shouldAdd) await addWaitingPerson(db, email);
  if (isReadMethod(request.method) && acceptsHtml(request)) {
    return new Response(request.method === "HEAD" ? null : `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${waitingTitle}</title>
  <style>
    :root {
      color-scheme: light dark;
      --background: #fafaf9;
      --foreground: #303537;
      --muted-foreground: #555f62;
      --accent-brand: #177a6f;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --background: #232729;
        --foreground: #ebeeeb;
        --muted-foreground: #b2bfc0;
        --accent-brand: #7bc7b9;
      }
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: var(--background);
      color: var(--foreground);
      font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
    }
    main { padding: 48px 20px; text-align: center; }
    svg { display: block; margin: auto; color: var(--accent-brand); }
    h1 { font-size: 20px; font-weight: 560; margin: 14px 0 6px; }
    p { max-width: 42ch; margin: auto; color: var(--muted-foreground); }
  </style>
</head>
<body>
  <main>
    <svg aria-hidden="true" viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
      <rect x="3" y="3" width="18" height="18" rx="3"/>
      <circle cx="12" cy="10" r="2.6"/>
      <path d="M7.5 17.5a4.5 4.5 0 0 1 9 0"/>
    </svg>
    <h1>${waitingTitle}</h1>
    <p>${waitingLine}</p>
  </main>
</body>
</html>`, {
      status: 403,
      headers: { ...noStore, "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return refusal(403, waitingLine);
}

function pathEmail(segment: string): string | null {
  try {
    return segment.includes("/") ? null : plainEmail(decodeURIComponent(segment));
  } catch {
    return null;
  }
}

async function readRole(request: Request): Promise<Role | Response> {
  const type = request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return refusal(415, "Send a JSON body with a role.");
  if (Number(request.headers.get("Content-Length")) > bodyLimit) return refusal(413, "The body is too large.");
  if (!request.body) return refusal(400, "Send a JSON body with a role.");

  const bytes = new Uint8Array(bodyLimit);
  const reader = request.body.getReader();
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > bodyLimit) {
        // Discard a little more before answering, so a sender still writing a
        // slightly oversized body is not cut off mid-send, then stop reading.
        let extra = value.length;
        while (extra < drainLimit) {
          const rest = await reader.read();
          if (rest.done) break;
          extra += rest.value.length;
        }
        await reader.cancel();
        return refusal(413, "The body is too large.");
      }
      bytes.set(value, length);
      length += value.length;
    }
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    if (body && Object.keys(body).length === 1 && isRole(body.role)) return body.role;
  } catch {
    return refusal(400, "Send a JSON body with a role.");
  } finally {
    reader.releaseLock();
  }
  return refusal(400, "Choose an owner, member or viewer role.");
}

async function hasBody(request: Request): Promise<boolean> {
  if (!request.body) return false;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return false;
      if (value.length > 0) {
        await reader.cancel();
        return true;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function peopleResponse(
  request: Request, path: string, db: PeopleDatabase, firstOwner: string, you: PeopleCaller,
): Promise<Response> {
  if (path === peoplePath && isReadMethod(request.method)) {
    if (request.method === "HEAD") return new Response(null, {
      headers: { ...noStore, "Content-Type": "application/json; charset=utf-8" },
    });
    const people = (await listPeople(db)).filter(({ email }) => email !== firstOwner)
      .map((person) => ({ ...person, waiting: person.role === null }));
    return Response.json({
      you,
      people: [{ email: firstOwner, role: "owner", first_owner: true }, ...people],
    }, { headers: noStore });
  }

  if (isReadMethod(request.method)) return refusal(404, "This people route does not exist.");
  if (you === "agent" || !mayWritePeople(you.role)) return refusal(403, "Only an owner can change people.");
  if (path === peoplePath || (request.method !== "PUT" && request.method !== "DELETE")) {
    return refusal(405, "Use PUT or DELETE with a person’s email.");
  }

  const email = pathEmail(path.slice(peoplePath.length + 1));
  if (!email) return refusal(400, "Enter one email address.");
  if (email === firstOwner) return refusal(403, "The first owner is set when the CRM is installed. Ask Wiser to change it.");
  // An owner cannot lock themselves out or step down alone: another owner does that.
  if (email === you.email) return refusal(403, "You can't change your own access. Ask another owner.");

  if (request.method === "PUT") {
    const role = await readRole(request);
    if (role instanceof Response) return role;
    await setPersonRole(db, email, role, you.email);
  } else {
    if (await hasBody(request)) return refusal(400, "Send DELETE without a body.");
    await removePerson(db, email);
  }
  return new Response(null, { status: 204, headers: noStore });
}
