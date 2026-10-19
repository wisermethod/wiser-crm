import { OpenAPIHono, type RouteConfig, type RouteHandler } from "@hono/zod-openapi";
import type { Context, Env } from "hono";
import { initDB } from "../db/index.js";

export { createRoute, z } from "@hono/zod-openapi";
export { caller, user, withIdentity, type Identity } from "./identity.js";

type DatabaseEnv = Env & { Bindings: { DB: D1Database } };
type AppInfo = { title: string; version: string; description: string };
const methods = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);

// The app's handlers return payloads its own helpers type as unknown, so a
// route's request is checked against its schema and its response is not.
export type App<E extends Env> = Omit<OpenAPIHono<E>, "openapi"> & {
  openapi<R extends RouteConfig>(
    route: R,
    handler: (c: Parameters<RouteHandler<R, E>>[0]) => Response | Promise<Response>,
  ): App<E>;
};

export function createApp<E extends DatabaseEnv>(info: AppInfo): App<E> {
  const app = new OpenAPIHono<E>();
  app.use("*", (c, next) => initDB(c.env.DB, next));

  const document = () => {
    const doc = app.getOpenAPIDocument({ openapi: "3.0.0", info });
    // Plain Hono routes have no schemas; include their paths in discovery too.
    for (const route of app.routes) {
      const method = route.method.toLowerCase();
      if (!methods.has(method)) continue;
      const path = route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
      const item = doc.paths[path] ??= {};
      if (!(method in item)) {
        Object.assign(item, { [method]: { summary: `${route.method} ${path}`, responses: { "200": { description: "Success" } } } });
      }
    }
    return doc;
  };

  app.get("/api/openapi.json", (c) => c.json(document()));
  app.get("/llms.txt", (c) => {
    const doc = document();
    const lines = [info.title, info.description, ""];
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(item ?? {})) {
        if (methods.has(method)) lines.push(`${method.toUpperCase()} ${path} - ${operation.summary ?? ""}`);
      }
    }
    return c.text(lines.join("\n") + "\n");
  });
  return app as unknown as App<E>;
}

export function widgets<E extends Env>(app: App<E>, fn: (c: Context<E>) => object | Promise<object>): void {
  app.get("/api/widgets", async (c) => c.json(await fn(c)));
}
