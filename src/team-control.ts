import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { TEAM_BINDING_NAMESPACE } from "./team.ts";

const MAX_BODY = 64 * 1024;
export interface TeamControlRequest {
  action: "inspect" | "catalog" | "change" | "delegate";
  params: unknown;
}
export interface TeamControlResponse {
  text: string;
  details?: unknown;
}
export class TeamControlBridge {
  private server?: Server;
  private port?: number;
  private readonly actors = new Map<string, string>();
  private readonly handle: (
    actorId: string,
    request: TeamControlRequest,
  ) => Promise<TeamControlResponse>;
  constructor(
    handle: (
      actorId: string,
      request: TeamControlRequest,
    ) => Promise<TeamControlResponse>,
  ) {
    this.handle = handle;
  }
  async issue(actorId: string): Promise<{
    namespace: typeof TEAM_BINDING_NAMESPACE;
    value: { url: string; token: string };
    revoke: () => void;
  }> {
    await this.start();
    const token = randomBytes(32).toString("hex");
    this.actors.set(token, actorId);
    return {
      namespace: TEAM_BINDING_NAMESPACE,
      value: { url: `http://127.0.0.1:${this.port}`, token },
      revoke: () => this.actors.delete(token),
    };
  }
  async close(): Promise<void> {
    this.actors.clear();
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  private async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => {
      void this.receive(request, response).catch(() => {
        if (!response.headersSent)
          response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ ok: false, error: "Team control failed." }),
        );
      });
    });
    this.server.requestTimeout = 20_000;
    this.server.headersTimeout = 5_000;
    const server = this.server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Team control did not bind a private TCP port.");
    this.port = address.port;
  }
  private async receive(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    response.setHeader("content-type", "application/json");
    if (request.method !== "POST") {
      response.writeHead(405);
      response.end(JSON.stringify({ ok: false, error: "Method not allowed." }));
      return;
    }
    const authorization = request.headers.authorization;
    const supplied = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    const token = [...this.actors.keys()].find(
      (candidate) =>
        supplied.length === candidate.length &&
        timingSafeEqual(Buffer.from(supplied), Buffer.from(candidate)),
    );
    const actorId = token ? this.actors.get(token) : undefined;
    if (!actorId) {
      response.writeHead(401);
      response.end(
        JSON.stringify({
          ok: false,
          error: "Team control authorization failed.",
        }),
      );
      return;
    }
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_BODY) {
        response.writeHead(413);
        response.end(
          JSON.stringify({
            ok: false,
            error: "Team control request is too large.",
          }),
        );
        request.destroy();
        return;
      }
      chunks.push(buffer);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400);
      response.end(
        JSON.stringify({
          ok: false,
          error: "Team control request is invalid.",
        }),
      );
      return;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !["inspect", "catalog", "change", "delegate"].includes(
        String((parsed as Record<string, unknown>).action),
      )
    ) {
      response.writeHead(400);
      response.end(
        JSON.stringify({ ok: false, error: "Team control action is invalid." }),
      );
      return;
    }
    try {
      const result = await this.handle(actorId, parsed as TeamControlRequest);
      response.writeHead(200);
      response.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      response.writeHead(403);
      response.end(
        JSON.stringify({
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "Team control rejected the request.",
        }),
      );
    }
  }
}
