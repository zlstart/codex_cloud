import assert from "node:assert/strict";
import test from "node:test";
import { resolveArtifactLink } from "../src/lib/artifactLinks.ts";

const files = [
  {
    id: "u",
    kind: "upload",
    name: "销售 数据.csv",
    url: "/api/files/u/content",
  },
  {
    id: "o",
    kind: "output",
    name: "销售 数据.csv",
    url: "/api/files/o/content",
  },
  { id: "a", kind: "output", name: "report.md", url: "/api/files/a/content" },
  { id: "b", kind: "output", name: "report.md", url: "/api/files/b/content" },
];

test("workspace links distinguish uploads and outputs, including encoded filenames", () => {
  assert.equal(
    resolveArtifactLink("/workspace/uploads/销售%20数据.csv", files)?.id,
    "u",
  );
  assert.equal(
    resolveArtifactLink("sandbox:/workspace/outputs/销售%20数据.csv", files)
      ?.id,
    "o",
  );
  assert.equal(
    resolveArtifactLink("sandbox:/mnt/data/销售%20数据.csv", files)?.id,
    "o",
  );
  assert.equal(resolveArtifactLink("/api/files/u/content", files)?.id, "u");
});

test("ambiguous, external, malformed and traversal-like links never select an arbitrary file", () => {
  for (const link of [
    "销售 数据.csv",
    "outputs/report.md",
    "https://example.com/outputs/销售%20数据.csv",
    "outputs/%2e%2e/uploads/销售%20数据.csv",
    "outputs/bad%",
    "outputs/..\\销售 数据.csv",
  ]) {
    assert.equal(resolveArtifactLink(link, files), undefined, link);
  }
});
