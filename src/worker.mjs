import { env } from "cloudflare:workers";
import { httpServerHandler } from "cloudflare:node";


// Make Worker vars/secrets available to legacy Node packages through process.env.
for (const [key, value] of Object.entries(env)) {
  if (typeof value === "string") process.env[key] = value;
}

const backend = await import("../server.mjs");
const legacy = backend.default || backend;
const port = Number(legacy.PORT || 10000);
const expressHandler = httpServerHandler({ port });

export default {
  async fetch(request, workerEnv, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        await legacy.ensureDatabaseReady();
      } catch (error) {
        console.error("Database initialization failed:", error);
        return Response.json(
          {
            error: "Database connection failed",
            detail: String(error?.message || error)
          },
          { status: 503 }
        );
      }

      return expressHandler.fetch(request, workerEnv, ctx);
    }

    return workerEnv.ASSETS.fetch(request);
  }
};
