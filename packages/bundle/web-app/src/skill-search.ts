/**
 * Public type surface for the fork's runtime-loaded skill-search preset.
 *
 * The executable stays at `presets/skill-search.mjs` so patch compositions can
 * load it directly. This declaration file keeps Typert from treating that
 * JavaScript resource as an untyped source export.
 */
export declare const name: string
export declare const inject: readonly string[]
export declare function apply(ctx: unknown): void
