import { sendNotice, type NoticeSettings } from "./notice.ts";
import { cleanIntake, recordNoticeOutcome, type NewSubmission } from "./submissions.ts";
import { saveWithinThrottle, type ThrottleSettings } from "./throttle.ts";

interface Environment extends NoticeSettings, ThrottleSettings {
  INTAKE_DB?: D1Database;
  INTAKE_ORIGIN?: string;
  INTAKE_RETURN_URL?: string;
}

const bodyLimit = 16_384;
const controls = /\p{Cc}/gu;

function reply(status: number, body: string | null, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");
  return new Response(body, { status, headers: responseHeaders });
}

async function readBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get("Content-Length")) > bodyLimit) return null;
  if (!request.body) return "";
  const buffer = new Uint8Array(bodyLimit);
  const reader = request.body.getReader();
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return new TextDecoder().decode(buffer.subarray(0, length));
      if (length + value.byteLength > bodyLimit) {
        void reader.cancel().catch(() => {});
        return null;
      }
      buffer.set(value, length);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

function trimAndCap(value: string, limit: number): string {
  return Array.from(value.trim()).slice(0, limit).join("").trimEnd();
}

function shortField(fields: URLSearchParams, name: string): string {
  return trimAndCap((fields.get(name) ?? "").replace(controls, ""), 200);
}

function referringPage(referer: string | null, origin: string): string {
  if (!referer) return "";
  try {
    const url = new URL(referer);
    return url.origin === origin ? url.pathname : "";
  } catch {
    return "";
  }
}

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    if (new URL(request.url).pathname !== "/submit") return reply(404, "Not found.");
    if (request.method !== "POST") return reply(405, "Method not allowed.", { Allow: "POST" });

    const { INTAKE_DB: db, INTAKE_ORIGIN: origin, INTAKE_RETURN_URL: returnUrl } = env;
    if (!db) return reply(503, "Intake unavailable.");

    try {
      if (!origin || !returnUrl) return reply(503, "Intake unavailable.");
      if (request.headers.get("Origin") !== origin || origin === "null") return reply(403, "Origin refused.");
      const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
      if (mediaType !== "application/x-www-form-urlencoded") return reply(415, "Unsupported form type.");

      const body = await readBody(request);
      if (body === null) return reply(413, "Form is too large.");
      const fields = new URLSearchParams(body);
      // Build the response before saving so invalid configuration cannot
      // accept a submission and then fail to redirect it.
      const success = reply(303, null, { Location: returnUrl });
      if (fields.getAll("website").some((value) => value !== "")) return success;

      const firstName = shortField(fields, "first_name");
      const email = shortField(fields, "email");
      const rawEmail = (fields.get("email") ?? "").trim();
      const message = trimAndCap((fields.get("message") ?? "")
        .replace(controls, (character) => character === "\n" || character === "\t" ? character : ""), 5_000);
      const validEmail = /^[^@\s\p{Cc}]+@[^@\s\p{Cc}]+$/u;
      if (!firstName || !message || !validEmail.test(rawEmail) || !validEmail.test(email)) {
        return reply(400, "Invalid form.");
      }

      const received = new Date();
      const submission: NewSubmission = {
        id: crypto.randomUUID(),
        page: referringPage(request.headers.get("Referer"), origin),
        firstName,
        lastName: shortField(fields, "last_name"),
        email,
        company: shortField(fields, "company"),
        phone: shortField(fields, "phone"),
        message,
      };
      const saved = await saveWithinThrottle(db, env, submission, received, request.headers.get("CF-Connecting-IP"));
      if (!saved) return reply(429, "Too many submissions.");

      const outcome = await sendNotice(env, submission, received);
      // The lead is durable. An outcome write failure must not invite a visitor
      // retry after their lead was saved and the notice was already attempted.
      await db.prepare(recordNoticeOutcome).bind(outcome, submission.id).run().catch(() => {});
      return success;
    } catch {
      return reply(503, "Intake unavailable.");
    } finally {
      await cleanIntake(db, new Date()).catch(() => {});
    }
  },
};
