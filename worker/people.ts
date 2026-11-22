import { addWaitingPerson, isReadMethod, isRole, listPeople, mayWritePeople, plainEmail, removePerson, setPersonRole } from "../runtime/people/index.ts";
import type { PeopleDatabase, Role } from "../runtime/people/index.ts";

export const peoplePath = "/api/wiser/people";
const noStore = { "Cache-Control": "no-store" };
const bodyLimit = 1024;
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
<html lang="en"><meta charset="utf-8"><title>Waiting for access</title>
<main><h1>Waiting for access</h1><p>Ask an owner to set your role.</p></main></html>`, {
      status: 403,
      headers: { ...noStore, "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return refusal(403, "Ask an owner to set your role.");
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
      if (length + value.length > bodyLimit) return refusal(413, "The body is too large.");
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
      if (value.length > 0) return true;
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
  if (email === firstOwner) return refusal(403, "The first owner is set at install.");

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
