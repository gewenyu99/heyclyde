import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { activity } from "../server/activity.ts";

test("recall, user feedback and approvals stay in the origin chat; double spawn creates one local quest run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clyde-chat-test-"));
  const previous = { ...process.env };
  Object.assign(process.env, { CLYDE_HOME: dir, CLYDE_CONFIG_DIR: dir, PASEO_HOME: dir });
  const quest = {
    id: 123,
    title: "Document setup",
    brief: "Clarify setup.",
    done_when: "The setup is documented.",
    priority: "normal",
  };
  const votes = [];
  let feedbackReply="Logged.";
  const calls = [], runs = new Map(), timeline = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const arg = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    const send = (body) => res.end(JSON.stringify(body));
    if (req.url === "/mcp") {
      const tool = arg.params?.name;
      if (arg.method === "initialize") {
        res.setHeader("mcp-session-id", "mock-session");
        return send({ result: {} });
      }
      calls.push(tool);
      if(tool==="list_quests"&&arg.params.arguments.show==="board"){
        return send({result:{content:[{text:JSON.stringify({quests:[{...quest,state:"claimed",project:"other/repo",claimed_by:"other"}],after:null})}]}});
      }
      if(tool==="feedback")votes.push(arg.params.arguments);
      return send({ result: { content: [{ text:tool==="feedback"?feedbackReply:"OK" }], _meta: { "clyde/card": tool==="recall"?{retrieval_id:"task-retrieval",items:[{id:"note",title:"Recall on launch",body:"Visible evidence"}]}:{ quests: [quest] } } } });
    }
    if (req.method === "GET"){
      if(req.url==="/runs")return send([...runs.values()]);
      const run=runs.get(req.url.split("/").at(-1));if(run)return send(run);
      res.statusCode=404;return send({error:"No run"});
    }
    if (req.url === "/runs") {
      const id = "r-" + arg.assignment;
      if (!runs.has(id)) {
        runs.set(id, {
          id,
          title: quest.title,
          status: "asking",
          asks: [{ key: "plan", kind: "approve", question: "Approve the design?" }],
          stages: [],
        });
      }
      return send(runs.get(id));
    }
    const id = req.url.split("/")[2], run = runs.get(id);
    assert.equal(arg.askKey, "plan");
    run.asks[0].answer = arg.text;
    return send(run);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  for (
    const [file, value] of Object.entries({
      url: "http://127.0.0.1:" + port,
      token: "fixture",
      "server-id": "host",
      "daemon.json": JSON.stringify({ port, token: "fixture" }),
    })
  ) writeFileSync(join(dir, file), value);
  const handlers = new Map(), plugin = { handle: (rpc, fn) => handlers.set(rpc.name, fn) };
  const row = { id: "owner", role: "Docs", provider: "codex", project: "test/repo", cwd: dir };
  const api = {
    agents: {
      ref: (id) => ({
        timeline: {
          append: async (item) => {
            timeline.push({ id, item });
          },
        },
      }),
    },
  };
  const act = activity(plugin, (id) => id === row.id ? row : undefined);
  const invoke = (name, args) => handlers.get("clyde." + name)(args, { paseo: api });
  try {
    await act.memory(
      "owner",
      "recall",
      { retrieval_id: "retrieval-1", items: [{ id: "note", title: "A decision" }] },
      api,
      {},
    );
    assert.equal(timeline[0].id, "owner");
    assert.equal(timeline[0].item.data.notes[0].title, "A decision");
    await act.memory("owner","feedback",null,api,{retrieval_id:"retrieval-1",entries:[{entry_id:"note",verdict:"used"}]},"Logged.");
    assert.deepEqual(timeline.at(-1).item.data.used,["note"]);
    await invoke("feedback", {
      agent: "owner",
      retrieval: "retrieval-1",
      verdict:"helpful",
    });
    assert.deepEqual(votes[0],{retrieval_id:"retrieval-1",card_vote:true,verdict:"helpful"});
    await invoke("feedback",{agent:"owner",retrieval:"retrieval-1",verdict:"nothing_useful"});
    assert.deepEqual(votes[1],{retrieval_id:"retrieval-1",card_vote:true,verdict:"nothing_useful"});
    assert.equal(timeline.at(-1).item.data.choice,"nothing_useful");
    assert.equal(timeline.at(-1).item.data.rated, true);
    assert.equal(timeline.at(-1).item.data.notes[0].title,"A decision");
    feedbackReply="Already logged for retrieval-1.";
    const pending=await invoke("feedback",{agent:"owner",retrieval:"retrieval-1",verdict:"helpful"});
    assert.equal(pending.pendingSync,true);
    assert.deepEqual(await invoke("recall-rating",{agent:"owner",retrieval:"retrieval-1"}),{choice:"helpful",pendingSync:true,used:["note"]});
    const shared=await invoke("shared-quests",{});
    assert.equal(shared.legacy,false);
    assert.equal(shared.quests[0].state,"claimed");
    assert.equal(shared.quests[0].project,"other/repo");
    assert.deepEqual(await invoke("quests", { agent: "owner" }), [quest]);
    const first = await invoke("spawn-quest", { agent: "owner", quest: 123 });
    const replay = await invoke("spawn-quest", { agent: "owner", quest: 123 });
    assert.equal(first.id, replay.id);
    assert.equal(runs.size, 1);
    assert.equal(calls.filter(c=>c==="recall").length,1);
    assert.ok(timeline.some(t=>t.item.data.kind==="recall" && t.item.data.notes[0]?.body==="Visible evidence"));
    assert.equal(calls.filter((c) => c === "claim_quest").length, 1);
    await assert.rejects(invoke("respond", { agent: "other", run: first.id, key: "plan", text: "approved" }));
    await invoke("respond", { agent: "owner", run: first.id, key: "plan", text: "approved" });
    assert.equal(timeline.at(-1).item.data.answer, "approved");
  } finally {
    act.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    for (const k of ["CLYDE_HOME", "CLYDE_CONFIG_DIR", "PASEO_HOME"]) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
    }
  }
});

test("activity stops retrying Unknown agent origins and still records result notes for done runs", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "clyde-dead-origin-"));
  const previous = { ...process.env };
  Object.assign(process.env, { CLYDE_HOME: dir, CLYDE_CONFIG_DIR: dir, PASEO_HOME: dir });
  const remembered = [];
  let appendCalls = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const arg = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (req.url === "/mcp") {
      if (arg.method === "initialize") {
        res.setHeader("mcp-session-id", "mock-dead-origin");
        return res.end(JSON.stringify({ result: {} }));
      }
      if (arg.params?.name === "remember") {
        remembered.push(arg.params.arguments);
        return res.end(JSON.stringify({ result: { content: [{ text: "Remembered note-123." }] } }));
      }
      return res.end(JSON.stringify({ result: { content: [{ text: "OK" }] } }));
    }
    if (req.method === "GET" && req.url === "/runs") {
      return res.end(JSON.stringify([{
        id: "r-done-dead",
        title: "Done with archived origin",
        status: "done",
        asks: [{ key: "plan:1", kind: "approve", question: "Approve?" }],
        stages: [{ summary: "Finished cleanly" }],
      }]));
    }
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  for (
    const [file, value] of Object.entries({
      url: "http://127.0.0.1:" + port,
      token: "fixture",
      "server-id": "host",
      "daemon.json": JSON.stringify({ port, token: "fixture" }),
      "chat-runs.json": JSON.stringify({ "r-done-dead": { agent: "dead-agent" } }),
    })
  ) writeFileSync(join(dir, file), value);

  t.mock.timers.enable({ apis: ["setInterval"] });
  const row = { id: "dead-agent", role: "Dev", provider: "codex", project: "test/repo", cwd: dir };
  const api = {
    agents: {
      ref: () => ({
        timeline: {
          append: async () => {
            appendCalls++;
            throw new Error("DaemonRpcError: Request failed: Unknown agent 'dead-agent'");
          },
        },
      }),
    },
  };
  const act = activity({ handle: () => {} }, (id) => id === row.id ? row : undefined);
  act.bind(api);
  try {
    t.mock.timers.tick(4000);
    for (let i = 0; i < 40 && remembered.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(remembered.length, 1, "done run still records its result note when origin timeline is gone");
    assert.equal(appendCalls, 1, "first poll observes Unknown agent once");

    t.mock.timers.tick(4000);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(appendCalls, 1, "subsequent polls do not spam timeline.append for dead origin");
  } finally {
    act.close();
    t.mock.timers.reset();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    for (const k of ["CLYDE_HOME", "CLYDE_CONFIG_DIR", "PASEO_HOME"]) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
    }
  }
});
