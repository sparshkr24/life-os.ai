import express from "express";

const app = express();
app.use(express.json({ limit: "5mb" }));

const STARTED_AT = new Date().toISOString();

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "ai-life-os-server",
    version: "0.0.1",
    started_at: STARTED_AT,
    now: new Date().toISOString(),
  });
});

// Stubs for the five endpoints from the architecture doc.
// Real implementations land Sunday/Monday/Tuesday.
app.post("/sync", (_req, res) => res.json({ accepted_ids: [], stub: true }));
app.post("/chat", (_req, res) => res.json({ reply: "stub", stub: true }));
app.post("/tick", (_req, res) => res.json({ should_nudge: false, stub: true }));
app.post("/nightly", (_req, res) => res.json({ rebuilt: false, stub: true }));
app.get("/profile", (_req, res) => res.json({ stub: true }));

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`[ai-life-os-server] listening on http://${HOST}:${PORT}`);
});
