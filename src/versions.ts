/** Oldest Grok Build release this bridge accepts; older releases are rejected. */
export const GROK_MIN_VERSION = "1.0.60";
/** Newest verified Grok Build release. Grok Build ships every release as a patch, so only
 * releases up to this exact version count as verified. */
export const GROK_TESTED_VERSION = "1.0.92";
/** Oldest Paseo host the manifest admits (`paseo-plugin.json`). */
export const PASEO_MIN_VERSION = "0.16.0";
/** Newest verified Paseo host; patch releases of this minor line count as verified too. */
export const PASEO_TESTED_VERSION = "0.16.2";

/**
 * `verified`: within the tested range. `tentative`: newer than the tested range, or a
 * pre-release at or above the minimum; accepted with a warning. `unsupported`: rejected.
 */
export type Support = "verified" | "tentative" | "unsupported";

type Core = readonly [number, number, number];

interface Release {
  core: Core;
  prerelease: boolean;
}

export function parseRelease(version: string): Release | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] !== undefined,
  };
}

function compareCores(left: Core, right: Core): number {
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function support(version: string, minimum: string, testedTop: Core): Support {
  const release = parseRelease(version);
  const min = parseRelease(minimum);
  if (!release || !min) return "unsupported";
  const versusMin = compareCores(release.core, min.core);
  // Semver orders a pre-release before its release, so 1.0.60-alpha is below the minimum.
  if (versusMin < 0 || (versusMin === 0 && release.prerelease)) return "unsupported";
  if (release.prerelease) return "tentative";
  return compareCores(release.core, testedTop) <= 0 ? "verified" : "tentative";
}

function testedCore(version: string): Core {
  const release = parseRelease(version);
  if (!release) throw new Error(`Invalid tested version ${version}`);
  return release.core;
}

export function grokSupport(version: string): Support {
  return support(version, GROK_MIN_VERSION, testedCore(GROK_TESTED_VERSION));
}

export function paseoSupport(version: string): Support {
  const [major, minor] = testedCore(PASEO_TESTED_VERSION);
  return support(version, PASEO_MIN_VERSION, [major, minor, Number.MAX_SAFE_INTEGER]);
}

/** Extract the release from `grok --version` output, e.g. `grok 1.0.92 (b06756fd6256)`. */
export function parseGrokVersionOutput(output: string): string | null {
  const match = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=\s|$|\))/m.exec(output.trim());
  return match?.[1] ?? null;
}

export function grokVersionRequirement(found: string | null): string {
  return `Grok Build ${GROK_MIN_VERSION} or newer is required; found ${found || "no version output"}`;
}

function tentativeReason(version: string, range: string): string {
  return parseRelease(version)?.prerelease
    ? `is a pre-release (tested range ${range})`
    : `is newer than the tested range (${range})`;
}

const warned = new Set<string>();

/** Warn once per component and version, so periodic work does not flood the plugin log. */
function warnOnce(key: string, message: string, warn: (message: string) => void): string {
  if (!warned.has(key)) {
    warned.add(key);
    warn(message);
  }
  return message;
}

export function warnTentativeGrok(
  version: string,
  warn: (message: string) => void = (message) => console.warn(message),
): string | undefined {
  if (grokSupport(version) !== "tentative") return undefined;
  const range = `${GROK_MIN_VERSION} to ${GROK_TESTED_VERSION}`;
  return warnOnce(
    `grok\0${version}`,
    `Grok Build ${version} ${tentativeReason(version, range)}; continuing tentatively. Report problems and pin a tested release if attached sessions misbehave.`,
    warn,
  );
}

/**
 * Paseo itself enforces the manifest minimum, so only newer or pre-release hosts matter here.
 * An unknown host version is not warned about.
 */
export function warnTentativePaseo(
  version: string | null | undefined,
  warn: (message: string) => void = (message) => console.warn(message),
): string | undefined {
  if (!version || paseoSupport(version) !== "tentative") return undefined;
  const range = `${PASEO_MIN_VERSION} to ${PASEO_TESTED_VERSION.replace(/\.\d+$/, ".x")}`;
  return warnOnce(
    `paseo\0${version}`,
    `Paseo host ${version} ${tentativeReason(version, range)}; continuing tentatively. Report problems and pin a tested release if discovery or attachments misbehave.`,
    warn,
  );
}
