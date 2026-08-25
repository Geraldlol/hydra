import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";

describe("webview preview server security contract", () => {
  test("does not expose exception details in HTTP responses", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "scripts", "preview-webview.mjs"), "utf8");
    const handlerStart = source.indexOf("http.createServer(async (request, response) => {");
    const handlerEnd = source.indexOf("server.listen(", handlerStart);
    assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);

    const handler = source.slice(handlerStart, handlerEnd);
    assert.match(handler, /catch \{[\s\S]*Internal Server Error/);
    assert.doesNotMatch(handler, /error instanceof Error|String\(error\)|\.stack/);
  });
});
