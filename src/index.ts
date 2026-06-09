import { Hono } from "hono";

// Extend auto-generated bindings with secrets (not auto-typed by wrangler)
type AppBindings = CloudflareBindings & {
  TOGGLE_AUTH_TOKEN: string;
};

const DEEPSEEK_HOST = "api.deepseek.com";

// Headers that should NOT be forwarded to DeepSeek
const HEADERS_TO_STRIP = new Set([
  "host",
  "cf-connecting-ip",
  "cf-ray",
  "cf-visitor",
  "cf-ipcountry",
  "cf-worker",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
  "content-length", // rebuilt when body is modified
]);

const app = new Hono<{ Bindings: AppBindings }>();

// --- Helpers ---

async function getForceSubagentThinking(
  env: AppBindings,
): Promise<boolean> {
  try {
    const stored = await env.CCPROXY_KV.get("forceSubagentThinking");
    if (stored !== null && stored !== undefined) {
      return stored === "true";
    }
  } catch {
    console.error("[ccproxy] KV read failed, falling back to env var");
  }
  return env.FORCE_SUBAGENT_THINKING === "true";
}

function isSubagent(headers: Headers): boolean {
  return !!headers.get("x-claude-code-agent-id");
}

function buildForwardHeaders(request: Request): Headers {
  const forwardHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (!HEADERS_TO_STRIP.has(key.toLowerCase())) {
      forwardHeaders.set(key, value);
    }
  }
  forwardHeaders.set("host", DEEPSEEK_HOST);
  return forwardHeaders;
}

async function proxyToDeepSeek(
  path: string,
  body: Record<string, unknown>,
  request: Request,
): Promise<Response> {
  const forwardHeaders = buildForwardHeaders(request);
  const serialized = JSON.stringify(body);
  forwardHeaders.set("content-length", String(new TextEncoder().encode(serialized).length));

  const upstreamResponse = await fetch(`https://${DEEPSEEK_HOST}${path}`, {
    method: "POST",
    headers: forwardHeaders,
    body: serialized,
  });
  return new Response(upstreamResponse.body, upstreamResponse);
}

// --- Auth Middleware ---

async function bearerAuth(
  c: import("hono").Context<{ Bindings: AppBindings }>,
  next: () => Promise<void>,
) {
  const authHeader = c.req.header("Authorization");
  const token = c.env.TOGGLE_AUTH_TOKEN;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const providedToken = authHeader.slice(7);
  if (providedToken !== token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
}

// --- Routes ---

// Health check (preserved from original scaffold)
app.get("/message", (c) => {
  return c.text("Hello Hono!");
});

// GET /status — return current toggle state (no auth required)
app.get("/status", async (c) => {
  try {
    const force = await getForceSubagentThinking(c.env);
    return c.json({ forceSubagentThinking: force });
  } catch {
    return c.json({ error: "KV unavailable" }, 503);
  }
});

// GET /toggle — flip toggle state (auth required)
app.get("/toggle", bearerAuth, async (c) => {
  try {
    const current = await getForceSubagentThinking(c.env);
    const next = !current;
    await c.env.CCPROXY_KV.put("forceSubagentThinking", String(next));
    console.log(`[ccproxy] TOGGLE: ${current} → ${next}`);
    return c.json({ forceSubagentThinking: next });
  } catch {
    return c.json({ error: "KV unavailable" }, 503);
  }
});

// POST /force-subagent-thinking — explicitly set toggle state (auth required)
app.post("/force-subagent-thinking", bearerAuth, async (c) => {
  let body: { force: boolean };
  try {
    body = await c.req.json<{ force: boolean }>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body.force !== "boolean") {
    return c.json({ error: "Missing or invalid 'force' field (must be boolean)" }, 400);
  }

  try {
    await c.env.CCPROXY_KV.put("forceSubagentThinking", String(body.force));
    console.log(`[ccproxy] SET: forceSubagentThinking = ${body.force}`);
    return c.json({ forceSubagentThinking: body.force });
  } catch {
    return c.json({ error: "KV unavailable" }, 503);
  }
});

// POST /anthropic/* — proxy Anthropic API requests to DeepSeek
app.post("/anthropic/*", async (c) => {
  const clientPath = c.req.path;
  const sub = isSubagent(c.req.raw.headers);
  const agentId = c.req.header("x-claude-code-agent-id") || "-";

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // count_tokens path — passthrough, no manipulation
  if (clientPath.includes("count_tokens")) {
    console.log(`[ccproxy] Token Count — passthrough`);
    return proxyToDeepSeek(clientPath, body, c.req.raw);
  }

  const thinking = body.thinking as { type?: string } | undefined;
  const model = (body.model as string) || "-";
  const messages = body.messages as unknown[] | undefined;
  const msgCount = messages?.length ?? 0;
  const thinkingType = thinking?.type || "MISSING";

  console.log(
    `[ccproxy] [${sub ? "SUB" : "MAIN"}] agent=${agentId.substring(0, 10)} model=${model} msgs=${msgCount} thinking=${thinkingType}`,
  );

  // Guard: absent, non-object, or missing .type → passthrough
  if (!thinking || typeof thinking !== "object" || !("type" in thinking) || typeof thinking.type !== "string") {
    console.log(`[ccproxy] through (no thinking object)`);
    return proxyToDeepSeek(clientPath, body, c.req.raw);
  }

  // Apply thinking override
  if (thinkingType === "enabled" || thinkingType === "adaptive") {
    console.log(`[ccproxy] → through`);
  } else {
    const forceSubagentThinking = await getForceSubagentThinking(c.env);

    if (forceSubagentThinking && sub) {
      console.log(`[ccproxy] ⚡ disabled→enabled`);
      body.thinking = { type: "enabled" };
    } else {
      console.log(`[ccproxy] ✂ disabled + strip`);
      body.thinking = { type: "disabled" };
      delete body.output_config;
    }
  }

  return proxyToDeepSeek(clientPath, body, c.req.raw);
});

// --- Error Handler ---

app.onError((err, c) => {
  console.error("[ccproxy] Unhandled error:", err.message);
  return c.json(
    {
      error: "Internal Server Error",
      message: err.message,
    },
    500,
  );
});

export default app;
