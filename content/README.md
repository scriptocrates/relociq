# Relociq content layer

Single source of truth for guide content. The site (`index.html`) is GENERATED from this — never hand-edit guide steps in the HTML.

## Structure
- `frameworks/<key>.json` — a destination's shared immigration spine (e.g. `DE-skilled-worker`). Each step has a stable `id`. Edit here to change content shared across every corridor using this framework.
- `deltas/<corridor>.json` — origin-specific adjustments layered on a framework. Operations: `override` (change fields of a shared step), `insert` (add an origin-only step, e.g. China's APS), `replace` (swap a whole step).
- `standalone/<corridor>.json` — corridors kept verbatim (e.g. `IN-DE`, the gold-standard hand-written guide, and the 15 single-corridor destinations not yet deduped).

## Build
From repo root:
```
node build/build-site.js index.html      # regenerate stepsData from content layer
node build/validate-site.js index.html   # integrity checks — must pass before commit
```
Then commit and push; GitHub Pages deploys.

## Provenance / correction workflow
Every framework and delta carries `last_reviewed`, `source_url`, `status`. When content is found wrong: fix the one file, bump `last_reviewed`, set `status` appropriately, rebuild, commit. This is the job a future research/content agent inherits.

## Migration status
- DE-skilled-worker: 12 corridors deduped (11 deltas + IN-DE standalone). PROVEN byte-perfect.
- Remaining frameworks (CA, ES, AE, AU, GB, NL, FR, PT, IE, EU-FoM, temp-protection) and 15 standalones: NOT yet migrated — still served from the flat stepsData baked into index.html. Migrate framework-by-framework with deliberate canonical-content normalisation (see notes).
