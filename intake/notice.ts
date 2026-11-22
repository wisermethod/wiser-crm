import type { NewSubmission } from "./submissions.ts";

export interface NoticeSettings {
  NOTICE?: SendEmail;
  NOTICE_FROM?: string;
  NOTICE_FROM_NAME?: string;
  NOTICE_TO?: string;
  CRM_URL?: string;
}

type NoticeOutcome = "sent" | "none" | `failed:${string}`;

const retryable = new Set(["E_SENDER_DOMAIN_NOT_CONFIGURED", "E_EMAIL_SENDING_NOT_READY"]);
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function subject(received: Date): string {
  const date = `${received.getUTCDate()} ${months[received.getUTCMonth()]} ${received.getUTCFullYear()}`;
  return `New website enquiry, ${date} ${received.toISOString().slice(11, 16)} UTC`;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]/g, "");
}

function senderName(value?: string): string {
  if (typeof value !== "string" || /[\p{Cc}\u2028\u2029<>",;:@\\]/u.test(value)) return "Wiser CRM";
  const name = singleLine(value).trim();
  return name && [...name].length <= 60 ? name : "Wiser CRM";
}

function body(submission: NewSubmission, crmUrl?: string): string {
  const lines = [
    `New enquiry from ${singleLine(submission.page)}`,
    "",
    `Name:       ${singleLine(submission.firstName)} ${singleLine(submission.lastName)}`,
    `Work email: ${singleLine(submission.email)}`,
    `Company:    ${singleLine(submission.company)}`,
    `Phone:      ${singleLine(submission.phone)}`,
    "",
    "Message:",
    submission.message,
  ];
  if (crmUrl) {
    lines.push("", "This lead is saved. It appears in your CRM the",
      "next time the CRM is opened:", singleLine(crmUrl));
  }
  return lines.join("\n");
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string" && error.code) return error.code;
  return "unknown";
}

export async function sendNotice(
  { NOTICE: notice, NOTICE_FROM: from, NOTICE_FROM_NAME: fromName, NOTICE_TO: to, CRM_URL: crmUrl }: NoticeSettings,
  submission: NewSubmission,
  received: Date,
): Promise<NoticeOutcome> {
  if (!notice || !from || !to) return "none";

  const payload = {
    to,
    from: { email: from, name: senderName(fromName) },
    subject: subject(received),
    text: body(submission, crmUrl),
  };
  try {
    await notice.send(payload);
  } catch (error) {
    const code = errorCode(error);
    if (!retryable.has(code)) return `failed:${code}`;
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    try {
      await notice.send(payload);
    } catch (retryError) {
      return `failed:${errorCode(retryError)}`;
    }
  }
  return "sent";
}
