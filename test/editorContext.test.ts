import { describe, test } from "node:test";
import { strict as assert } from "node:assert";
import { renderEditorContextAttachment, truncateEditorContext } from "../src/editorContext";

describe("editor context attachments", () => {
  test("truncates large editor context with original size retained", () => {
    const result = truncateEditorContext("abcdef", 3);
    assert.deepEqual(result, { text: "abc", truncated: true, originalChars: 6 });
  });

  test("renders selected editor context with file and range", () => {
    const rendered = renderEditorContextAttachment({
      label: "src/panel.ts",
      languageId: "typescript",
      selected: true,
      startLine: 4,
      endLine: 7,
      text: "const x = 1;",
      originalChars: 12,
      truncated: false,
    });

    assert.match(rendered, /Source: selected text/);
    assert.match(rendered, /File: src\/panel\.ts/);
    assert.match(rendered, /Range: lines 4-7/);
    assert.match(rendered, /```typescript\nconst x = 1;\n```/);
  });
});
