import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

describe("repository hygiene", () => {
  test("tracked files do not contain grave accent characters", () => {
    const root = process.cwd();
    const graveAccent = String.fromCharCode(96);
    const trackedFiles = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean);

    const offenders = trackedFiles.filter((file) => readFileSync(join(root, file), "utf8").includes(graveAccent));

    expect(offenders).toEqual([]);
  });
});
