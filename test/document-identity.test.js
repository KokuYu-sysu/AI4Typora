import assert from "node:assert/strict";

import {
  getCurrentDocumentIdentity,
  hashDocumentPath,
  normalizeWindowsDocumentPath,
} from "../src/document-identity.js";

assert.equal(
  normalizeWindowsDocumentPath("C:/Users/Alice/Documents/../Notes/FILE.md"),
  "c:\\users\\alice\\notes\\file.md",
);
assert.equal(normalizeWindowsDocumentPath("c:\\研究\\论文.md"), "c:\\研究\\论文.md");
assert.equal(hashDocumentPath("c:\\docs\\one.md"), hashDocumentPath("C:\\DOCS\\ONE.MD"));
assert.notEqual(hashDocumentPath("c:\\docs\\one.md"), hashDocumentPath("c:\\docs\\two.md"));
assert.match(hashDocumentPath("c:\\docs\\one.md"), /^[a-f0-9]{64}$/);

{
  const identity = getCurrentDocumentIdentity({
    File: { filePath: "C:/Docs/Article.md" },
  });
  assert.deepEqual(identity, {
    persistable: true,
    key: `doc_${hashDocumentPath("c:\\docs\\article.md")}`,
    path: "c:\\docs\\article.md",
    label: "article.md",
  });
}

{
  const identity = getCurrentDocumentIdentity({
    File: { bundle: { filePath: "D:\\Notes\\Draft.md" } },
  });
  assert.equal(identity.persistable, true);
  assert.equal(identity.path, "d:\\notes\\draft.md");
  assert.equal(identity.label, "draft.md");
}

{
  const identity = getCurrentDocumentIdentity({
    location: { href: "file:///C:/Docs/%E7%A0%94%E7%A9%B6.md" },
  });
  assert.equal(identity.persistable, true);
  assert.equal(identity.path, "c:\\docs\\研究.md");
}

assert.deepEqual(getCurrentDocumentIdentity({ File: {} }), {
  persistable: false,
  key: "",
  path: "",
  label: "Untitled",
});

console.log("document identity tests passed");
