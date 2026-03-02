/**
 * Version constant - single source of truth
 * This file is auto-updated by scripts/release.sh
 * @constant {string} VERSION - The current CLI version
 * @example
 * console.log(VERSION); // '0.3.0'
 */
export const VERSION = '0.3.0';

/**
 * Get version info for CLI output
 * @returns {string} Formatted version string with v prefix
 */
export function getVersion(): string {
  return `v${VERSION}`;
}
