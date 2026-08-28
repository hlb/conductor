import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("CLI accepts --silent as a global --quiet alias", () => {
  const result = spawnSync(process.execPath, ["src/cli.js", "kktix", "event", "--silent"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /kktix event 命令需要一個活動 slug/);
  assert.doesNotMatch(result.stderr, /Unknown option/);
});
