export const MINIMUM_CLAUDE_VERSION = Object.freeze([2, 1, 325]);
export const MINIMUM_CODEX_VERSION = Object.freeze([0, 171, 0]);

/** Compare the numeric release triple printed by either upstream CLI. */
export function versionAtLeast(version, minimum) {
  const parts = typeof version === 'string'
    ? version.match(/(\d+)\.(\d+)\.(\d+)/u)?.slice(1).map(Number)
    : version;
  if (!Array.isArray(parts) || parts.length !== 3 || !parts.every(Number.isSafeInteger)) {
    return false;
  }
  for (let i = 0; i < minimum.length; i += 1) {
    if (parts[i] !== minimum[i]) return parts[i] > minimum[i];
  }
  return true;
}
