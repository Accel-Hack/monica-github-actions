import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

const SCRIPT = fileURLToPath(new URL("./upload.sh", import.meta.url));
const MAP = {
  version: 3,
  file: "index-BkX9a2Qz.js",
  sources: ["../src/main.ts"],
  sourcesContent: ["const secret = 1;"],
  names: [],
  mappings: "AAAA",
};
const { sourcesContent, ...MAP_WITHOUT_SOURCES } = MAP;

let server;
let origin;
let uploads;
let tokenRequests;
let respond;
const roots = [];

before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, origin);
      if (url.pathname === "/token") {
        tokenRequests.push({ authorization: req.headers.authorization, query: url.search });
        res.end(JSON.stringify({ value: `oidc-for:${url.searchParams.get("audience")}` }));
        return;
      }
      uploads.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      const [status, text] = respond();
      res.writeHead(status).end(text);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  for (const root of roots) rmSync(root, { recursive: true });
});
beforeEach(() => {
  uploads = [];
  tokenRequests = [];
  respond = () => [204, ""];
});

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "upload-sourcemaps-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

async function run(env) {
  try {
    const { stdout } = await promisify(execFile)("bash", [SCRIPT], {
      env: {
        PATH: process.env.PATH,
        MONICA_PROJECT: "my-app",
        MONICA_RELEASE: "1.0.0+build/7",
        URL_PREFIX: "/",
        INGEST_URL: `${origin}/`,
        ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/token?api-version=2.0`,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
        GITHUB_REPOSITORY: "o/r",
        ...env,
      },
    });
    return { code: 0, stdout };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout };
  }
}

test("uploads each map gzipped, without sourcesContent, under its URL-encoded runtime path", async () => {
  const root = fixture({
    "dist/assets/index-BkX9a2Qz.js.map": JSON.stringify(MAP),
    "dist/assets/a b+c.js.map": JSON.stringify(MAP),
    "dist/assets/index-BkX9a2Qz.js": "console.log(1)",
  });
  const { code, stdout } = await run({ MAPS_PATH: join(root, "dist") });

  assert.equal(code, 0, stdout);
  assert.deepEqual(uploads.map((upload) => upload.url).sort(), [
    "/v1/sourcemaps?project=my-app&release=1.0.0%2Bbuild%2F7&file=%2Fassets%2Fa%20b%2Bc.js",
    "/v1/sourcemaps?project=my-app&release=1.0.0%2Bbuild%2F7&file=%2Fassets%2Findex-BkX9a2Qz.js",
  ]);
  for (const upload of uploads) {
    assert.equal(upload.method, "PUT");
    assert.equal(upload.headers.authorization, `Bearer oidc-for:${origin}`);
    assert.equal(upload.headers["content-type"], "application/json");
    assert.equal(upload.headers["content-encoding"], "gzip");
    assert.deepEqual(JSON.parse(gunzipSync(upload.body)), MAP_WITHOUT_SOURCES);
  }
  assert.equal(tokenRequests.length, 2);
  for (const request of tokenRequests) {
    assert.equal(request.authorization, "bearer request-token");
    assert.equal(request.query, `?api-version=2.0&audience=${encodeURIComponent(origin)}`);
  }
  assert.equal(stdout.match(/^uploaded /gm).length, 2);
  assert.doesNotMatch(stdout, /oidc-for|request-token/);
});

test("joins a url-prefix without a trailing slash and accepts a path with one", async () => {
  const root = fixture({ "out/index.js.map": JSON.stringify(MAP) });
  await run({ MAPS_PATH: `${join(root, "out")}/`, URL_PREFIX: "/worker" });
  assert.equal(new URL(uploads[0].url, origin).searchParams.get("file"), "/worker/index.js");
});

test("a non-2xx response fails the run and prints the body and the repository hint for 403", async () => {
  respond = () => [403, "repository o/r is not linked to project my-app"];
  const root = fixture({ "dist/a.js.map": JSON.stringify(MAP) });
  const { code, stdout } = await run({ MAPS_PATH: join(root, "dist") });

  assert.equal(code, 1);
  assert.match(stdout, /repository o\/r is not linked to project my-app/);
  assert.match(stdout, /::error::PUT \/a\.js .* returned 403; is o\/r selected in the GitHub section/);
  assert.doesNotMatch(stdout, /oidc-for|request-token/);
});

test("fails when no map is found", async () => {
  const root = fixture({ "dist/index.js": "" });
  const { code, stdout } = await run({ MAPS_PATH: join(root, "dist") });

  assert.equal(code, 1);
  assert.match(stdout, /::error::no \*\.map files under/);
});

test("fails without the OIDC request variables and sends nothing", async () => {
  const root = fixture({ "dist/a.js.map": JSON.stringify(MAP) });
  const { code, stdout } = await run({ MAPS_PATH: join(root, "dist"), ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" });

  assert.equal(code, 1);
  assert.match(stdout, /id-token: write/);
  assert.equal(uploads.length + tokenRequests.length, 0);
});
