import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const bot = fileURLToPath(new URL("../src/bot.mjs", import.meta.url));
const prefix = "repos/alveusgg/alveusgg";

test("CLI dry run, create, deduplicate, update, and stale-head checks with mocked GitHub", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "preview-bot-test-"));
  try {
    const repo = path.join(directory, "repo");
    await mkdir(path.join(repo, "apps/website/src/pages"), { recursive: true });
    await writeFile(path.join(repo, "apps/website/src/pages/about.tsx"), "export default function Page() {}\n");
    const git = (args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    git(["init", "--quiet"]); git(["add", "."]);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"]);
    const sha = git(["rev-parse", "HEAD"]).trim();
    const statePath = path.join(directory, "state.json");
    let state = { sha, deployment: 1, comments: [], writes: [], reads: [], headReads: 0 };
    await writeFile(statePath, JSON.stringify(state));
    const fake = path.join(directory, "gh");
    await writeFile(fake, `#!/usr/bin/env node
      const fs = require('node:fs');
      const state = JSON.parse(fs.readFileSync(process.env.GH_FIXTURE, 'utf8'));
      const endpoint = process.argv[3];
      const method = process.argv[process.argv.indexOf('--method') + 1];
      const prefix = ${JSON.stringify(prefix)};
      let result;
      if (method !== 'GET') {
        const body = JSON.parse(fs.readFileSync(0, 'utf8'));
        state.writes.push({endpoint, method, body});
        const comment = {id: 42, user: {login: 'test-user'}, body: body.body, html_url: 'https://github.com/example/comment/42'};
        state.comments = [comment]; result = comment;
      } else {
        state.reads.push(endpoint);
        if (endpoint === 'user') result = {login: 'test-user'};
        else if (endpoint === prefix + '/pulls/2468') {
          state.headReads++;
          const head = state.stale && state.headReads > 1 ? 'b'.repeat(40) : state.sha;
          result = {number: 2468, state: 'open', title: 'About page', user: {login:'someone-else'}, head: {sha:head}};
        } else if (endpoint.includes('/deployments?')) result = [{id:state.deployment, creator:{login:'vercel[bot]'}, production_environment:false, environment:'Preview'}];
        else if (endpoint.includes('/statuses?')) result = [{state:'success', environment_url:'https://alveusgg-website-example-alveus.vercel.app'}];
        else if (endpoint.includes('/comments?')) result = state.comments;
        else if (endpoint.endsWith('/files?per_page=100')) result = [{filename:'apps/website/src/pages/about.tsx', patch:'+ changed'}];
        else throw new Error('Unexpected mock endpoint: ' + endpoint);
      }
      fs.writeFileSync(process.env.GH_FIXTURE, JSON.stringify(state));
      process.stdout.write(JSON.stringify(process.argv.includes('--slurp') ? [result] : result));
    `);
    await chmod(fake, 0o755);
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, GH_FIXTURE: statePath, OPENAI_API_KEY: "", PR_AUTHOR: "" };
    const run = (extra = []) => execFileSync(process.execPath, [bot, "--pr", "2468", "--repo-dir", repo, "--no-ai", ...extra],
      { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const read = async () => JSON.parse(await readFile(statePath, "utf8"));
    assert.match(run(), /dry run/);
    assert.equal((await read()).writes.length, 0);
    run(["--write"]);
    state = await read();
    assert.equal(state.writes.length, 1);
    assert.equal(state.writes[0].method, "POST");
    assert.match(state.writes[0].body.body, /\/about/);
    run(["--write"]);
    state = await read();
    assert.equal(state.writes.length, 1, "Unchanged deployments must not post again");
    state.deployment = 2;
    await writeFile(statePath, JSON.stringify(state));
    run(["--write"]);
    state = await read();
    assert.equal(state.writes.length, 2);
    assert.equal(state.writes[1].method, "PATCH");
    assert.equal(state.writes[1].endpoint, `${prefix}/issues/comments/42`);
    state.stale = true; state.headReads = 0;
    await writeFile(statePath, JSON.stringify(state));
    run(["--write", "--force"]);
    assert.equal((await read()).writes.length, 2, "A superseded PR head must not post");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
