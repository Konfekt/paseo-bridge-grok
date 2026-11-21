import { expect, test } from "vitest";
import {
  GROK_MIN_VERSION,
  GROK_TESTED_VERSION,
  grokSupport,
  parseGrokVersionOutput,
  paseoSupport,
  warnTentativeGrok,
  warnTentativePaseo,
} from "../src/versions.js";

test("Grok releases are verified up to the tested one and tentative beyond", () => {
  expect(grokSupport(GROK_MIN_VERSION)).toBe("verified");
  expect(grokSupport(GROK_TESTED_VERSION)).toBe("verified");
  expect(grokSupport("1.0.999")).toBe("tentative");
  expect(grokSupport("2.0.0")).toBe("tentative");
  expect(grokSupport("1.0.0")).toBe("unsupported");
  expect(grokSupport(`${GROK_MIN_VERSION}-beta`)).toBe("unsupported");
  expect(grokSupport("nonsense")).toBe("unsupported");
});

test("Paseo's tested minor line is verified and newer lines are tentative", () => {
  expect(paseoSupport("0.16.0")).toBe("verified");
  expect(paseoSupport("0.16.9")).toBe("verified");
  expect(paseoSupport("0.17.0")).toBe("tentative");
  expect(paseoSupport("0.15.9")).toBe("unsupported");
});

test("parses grok --version output", () => {
  expect(parseGrokVersionOutput("grok 1.0.92 (b06756fd6256)")).toBe("1.0.92");
  expect(parseGrokVersionOutput("grok v1.1.0-rc.1\n")).toBe("1.1.0-rc.1");
  expect(parseGrokVersionOutput("unknown")).toBeNull();
});

test("tentative versions warn once each", () => {
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  expect(warnTentativeGrok(GROK_TESTED_VERSION, warn)).toBeUndefined();
  warnTentativeGrok("7.7.7", warn);
  warnTentativeGrok("7.7.7", warn);
  warnTentativePaseo("0.99.0", warn);
  warnTentativePaseo(null, warn);
  expect(warnings).toHaveLength(2);
});

test("version constants match the manifest and the pinned Paseo packages", async () => {
  const { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile("paseo-plugin.json", "utf8")) as {
    requirements: { paseo: string };
  };
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
    dependencies: Record<string, string>;
  };
  const { PASEO_MIN_VERSION, PASEO_TESTED_VERSION } = await import("../src/versions.js");
  expect(manifest.requirements.paseo).toBe(`>=${PASEO_MIN_VERSION}`);
  for (const name of ["client", "plugin", "protocol", "server"])
    expect(pkg.dependencies[`@getpaseo/${name}`]).toBe(PASEO_TESTED_VERSION);
});
