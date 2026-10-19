import { exportJWK, exportPKCS8, generateKeyPair, SignJWT } from "jose";

// This Node-only CLI shares the Worker's typecheck, which intentionally has no
// full Node ambient types. Declare just the built-in calls used here.
declare const process: {
  argv: string[];
  getBuiltinModule(name: "fs"): {
    existsSync(path: string): boolean;
    realpathSync: { native(path: string): string };
    mkdirSync(path: string, options: { recursive: boolean; mode: number }): unknown;
    writeFileSync(path: string, data: string, options: { mode: number; flag: string }): void;
  };
  getBuiltinModule(name: "path"): {
    resolve(...parts: string[]): string;
    dirname(path: string): string;
    basename(path: string): string;
    relative(from: string, to: string): string;
    isAbsolute(path: string): boolean;
    sep: string;
  };
  getBuiltinModule(name: "url"): { fileURLToPath(url: URL): string };
};

const fs = process.getBuiltinModule("fs");
const path = process.getBuiltinModule("path");
const directory = process.argv[2];
if (!directory || process.argv.length !== 3) throw new Error("Usage: node worker/dev/mint.ts <directory>");

// Resolve existing ancestors before making anything, including symlinked
// parents of a destination that does not exist yet.
let ancestor = path.resolve(directory);
const missing: string[] = [];
while (!fs.existsSync(ancestor)) {
  missing.unshift(path.basename(ancestor));
  ancestor = path.dirname(ancestor);
}
// The native call returns the spelling stored on disk, and the comparison
// ignores case, so another spelling of the workspace on a case-insensitive
// volume cannot pass for a path outside it.
const destination = path.resolve(fs.realpathSync.native(ancestor), ...missing);
const repository = fs.realpathSync.native(process.getBuiltinModule("url").fileURLToPath(new URL("../../", import.meta.url)));
const workspace = path.dirname(repository);
const relative = path.relative(workspace.toLowerCase(), destination.toLowerCase());
if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
  throw new Error("Keys and tokens must stay outside the repository and its build workspace.");
}

fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
const kid = crypto.randomUUID();
const jwks = { keys: [{ ...await exportJWK(publicKey), kid, alg: "RS256", use: "sig" }] };
fs.writeFileSync(path.resolve(destination, "private-key.pem"), await exportPKCS8(privateKey), { mode: 0o600, flag: "wx" });
fs.writeFileSync(path.resolve(destination, "jwks.json"), JSON.stringify(jwks), { mode: 0o600, flag: "wx" });

const issuedAt = Math.floor(Date.now() / 1000);
async function mint(claims: { sub: string; email?: string; common_name?: string }): Promise<string> {
  return new SignJWT({ ...claims, type: "app" })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer("https://local.cloudflareaccess.com")
    .setAudience("local")
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 8 * 60 * 60)
    .sign(privateKey);
}

// Redirect stdout to a file outside the workspace; never put it in a run log.
console.log(JSON.stringify({
  person: await mint({ sub: "local-person", email: "person@example.test" }),
  agent: await mint({ sub: "", common_name: "local-agent" }),
}));
