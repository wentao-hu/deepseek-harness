/**
 * Desktop notification plugin, node half.
 *
 * Pure browser-surface plugin: this empty apply exists so the package can be a
 * Loader row, and the browser half ships through `exports["./client"]`,
 * discovered from the `dsh.client` declaration in package.json.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply() {}
