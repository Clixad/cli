/**
 * What this package says about its own license, in the four places it says it.
 *
 * `LICENSE` is the Apache License 2.0 exactly as the Apache Software Foundation
 * publishes it, appendix and all: GitHub and npm identify a license by its
 * text, and an edited copy is read as "other". The copyright line belongs in
 * `NOTICE`, which section 4 (d) of the License requires a redistributor to
 * keep, rather than in the license text.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_DIR } from "./helpers/paths.ts";

const read = (file: string) => readFileSync(join(CLI_DIR, file));

/** SHA-256 of https://www.apache.org/licenses/LICENSE-2.0.txt. */
const APACHE_2_0_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";

describe("the license", () => {
  it("is the Apache License 2.0 text, byte for byte", () => {
    expect(createHash("sha256").update(read("LICENSE")).digest("hex")).toBe(APACHE_2_0_SHA256);
  });

  it("is what package.json declares, so npm shows the same thing", () => {
    expect((JSON.parse(read("package.json").toString("utf8")) as { license: string }).license).toBe("Apache-2.0");
  });

  it("names the copyright holder in NOTICE and in the README", () => {
    expect(read("NOTICE").toString("utf8")).toContain("Copyright 2026 Florian Rappold");
    expect(read("README.md").toString("utf8")).toContain("Copyright 2026 Florian Rappold. Licensed under the [Apache License 2.0](LICENSE)");
  });
});
