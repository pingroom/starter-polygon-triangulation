# PingRoom polygon triangulation

Collect an ordered outline's coordinates from a named editor. Code checks for a supported simple polygon, then divides valid outlines into triangles using exact integer arithmetic. Complete invalid outlines produce local findings. The starter does not inspect images, render previews or execute fabrication steps.

## Try it offline

Choose **Use this template**, clone your repository, and use Node.js 22 or later:

```sh
npm ci
npm test
npm run demo
```

The demo uses the pinned SDK with an in-memory transport. It covers a valid concave outline, invalid geometry and Unknown without credentials or network calls. The fixture is a harmless paper-arrow sketch described by coordinates.

## Define the outline

```sh
cp examples/outline.json outline.json
cp config.example.json config.json
npm run preview
```

Edit `outline.json` before starting. Supply a stable `outlineId`, title, `coordinateMeaning`, common `unit`, and 3–8 vertices with unique IDs and descriptive labels. List vertices in boundary order, clockwise or counterclockwise. The final vertex connects automatically to the first: do not repeat the starting point to close the ring.

Array order defines edges. Changing the starting vertex or reversing the list creates a new manifest, even for the same region. Internal winding normalization preserves your manifest and vertex IDs.

State the origin and measurement meaning. Coordinates lie on a flat mathematical plane, with x increasing rightward and y upward, in integer multiples of the declared unit. Convert downward-y coordinates upstream. Use the same source version, orientation, unit and origin throughout. Unit conversion, geographic projection and geodesy are outside this starter.

The editor opens the source in their existing workflow and reports the named corners. No source file, screenshot or attachment is fetched or sent. IDs and labels identify the intended source but cannot prove what the editor inspected. Use Unknown if the source or coordinate convention cannot be established.

## Connect and collect

```sh
npm run connect
npm run inspect
```

`connect` prints PingRoom installation and pairing links. Approve a standard private room containing the editor. Use `inspect` to find their member UUID, verify the person in the app, then set that exact UUID and a descriptive label in `config.json`. A name alone is not identity. Credentials remain in ignored `.pingroom/`.

For an existing connection, optionally copy `.env.example` to `.env` and set both `PINGROOM_TOKEN` and `PINGROOM_ROOM`. If either is present in the shell, both must come from the shell. Partial pairs never borrow credentials from another source.

```sh
npm start
# Editor replies to the pending Question; then run again:
npm start
npm run status
npm run report
npm run export
npm run export-mesh
```

Each invocation creates at most one direct text Question or reads the active one once. After recording an answer, run it again for the next vertex in declared order. At most eight Questions last 15 minutes each. Prompts include vertex position, ID, label, coordinate meaning, unit and axes.

Reply `x,y`, such as `-3,7`, or exactly `Unknown`. Coordinates must be integers between -10000 and 10000. Returned text must contain no plus signs, spaces, leading zeros, `-0`, decimals, exponents or unit suffixes. Validation cannot detect surrounding whitespace trimmed by PingRoom. Do not estimate unknown coordinates.

## Geometry and exports

Code rejects duplicate points, adjacent collinear corners, zero signed area and any nonadjacent edge crossing, touching or overlap. Adjacent collinear corners are unsupported even when they could be simplified. Supply one outer ring with no holes, extra rings or bridges.

For valid outlines, code normalizes an internal index list to counterclockwise order. An ear is a strictly convex corner whose triangle contains no other active vertex, including its boundary. At each step, the eligible ear with the smallest original array index is clipped. The final three vertices form the last triangle. See David Eberly's [Triangulation by Ear Clipping](https://www.geometrictools.com/Documentation/TriangulationByEarClipping.pdf), sections 1–2, for the underlying method.

Every orientation and area calculation uses `BigInt`. A valid n-vertex outline produces n−2 counterclockwise triangles with original IDs and integer coordinates. Twice-area values are exact decimal strings: `"1"` represents half a square unit. The consistency certificate checks positive triangle orientation, triangle count, total area, vertex use, boundary edges appearing once and internal edges appearing twice in opposite directions. It is not a signature or proof of unseen source accuracy.

`report` writes private `.polygon/report.json`, including partial evidence. `export` writes `.polygon/analysis.json` only when all coordinates are known and validly reported. A complete invalid outline is exportable with `analysis.valid: false`, explicit reasons and `mesh: null`. Its shoelace sum and sign are diagnostics; they must not be interpreted as a valid region's area or winding.

`export-mesh` writes `.polygon/mesh.json` only for a complete valid outline. Unknown, missing, expired, cancelled or invalid answer evidence withholds all geometry analysis. `sourceInspected: false` refers to application code, separately from the editor's work. No rendering, image editing or downstream execution follows either export.

Artifacts retain source metadata, attributed answers and policy. `manifestHash` binds ordered metadata; `sourceHash` also binds ordered coordinates and remains null until analysis is available. Local hashes detect changes relative to saved data; they do not authenticate history.

To adapt the starter, map your outline into `outline.json` and consume the reviewed mesh in your own workflow. Keep geometry in application code; version `POLICY` and start a new session if its rules change.

## Recovery and bounds

For `create_unknown`, keep state:

```sh
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

A lost response never triggers a replacement POST. No match in a bounded recent search does not prove creation failed. Recover only the original Question. Terminal failures remain recorded. Resolve pending/uncertain work before archiving `.polygon/` for a new session. Resolve or revoke uncertain pairing in Connected Agents before archiving its pending record.

Run/recover exits: `0` complete analysis, including invalid geometry; `2` Unknown/incomplete or a newly invalid, expired or cancelled answer; `3` ready/pending/interrupted; `4` uncertain creation; `1` setup, provenance or operational error. Offline status/report success exits `0`; inspect JSON status and validity.

Limits: 3–8 vertices; coordinates ±10000; title 40, coordinate meaning 100, unit 12 and vertex label 30 UTF-16 units; vertex IDs 16 characters. Metadata must be trimmed, well-formed single-line Unicode without control/format characters. Input/config/state/HTTP caps are 64 KiB/16 KiB/1 MiB/512 KiB; transport deadlines are five seconds.

Ignored private files/directories use `0600`/`0700`, atomic writes and local locks for one machine. Remove a stale lock only after confirming its owning process stopped. SDK `0.7.1` is pinned with a lockfile; `.npmrc` requests a 14-day minimum release age where npm supports it. MIT licensed; mock CI runs Node.js 22 and 24.
