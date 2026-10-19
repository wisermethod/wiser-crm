export interface CredentialBinding {
  fetch: typeof fetch;
}

export interface ConnectionsEnv {
  CREDENTIALS?: CredentialBinding;
}

export interface GenericClient {
  run(action: string, args: Record<string, unknown>): Promise<unknown>;
  get(path: string, options?: { query?: Record<string, unknown> }): Promise<unknown>;
}

export async function describe(
  _env: ConnectionsEnv,
  _context: undefined,
  services: readonly { service: string; as: "integration" }[],
): Promise<{ id: string; connected: false }[]> {
  return services.map(({ service }) => ({ id: service, connected: false }));
}

export function connect(service: string, _env: ConnectionsEnv): GenericClient {
  const unavailable = async (): Promise<never> => {
    throw new Error(`${service} is not connected.`);
  };
  return { run: unavailable, get: unavailable };
}
