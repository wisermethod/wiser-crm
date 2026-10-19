export async function verifyDelivery(
  _raw: string,
  _signature: { signature: string | null; timestamp: string | null; keyId: string | null },
): Promise<boolean> {
  return false;
}

export async function enqueueJob(
  _env: object,
  _job: { targetUrl: string; payload: unknown; runAt: Date; idempotencyKey: string; maxAttempts: number },
): Promise<{ id: string }> {
  throw new Error("The job queue is not available.");
}

export async function cancelJob(_env: object, _id: string): Promise<void> {}
