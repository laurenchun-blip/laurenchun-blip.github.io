# Adkom discovery prototype (Figma section 11.4.26)

Interactive build of the six North star frames in `[ADKOM] Agent-Native App POC` (node 67:4320).

Run it from `adkom-prototypes/` with the `adkom-prototypes` server in `.claude/launch.json`, then open
`/adkom-agent-native-app/prototype/index.html`. Add `?frame=1` to `?frame=6` to open a frame directly,
or use the round ▶ button at the bottom left (frames, sample requests, failure and loading states).

## What is real and what is mocked

| Piece | Here | North star |
| --- | --- | --- |
| Map | MapLibre GL JS 4.7.1, OpenFreeMap tiles restyled from the `map/*` tokens, basemap labels hidden | Google Maps |
| Places search | Fixture gazetteer of invented places (`js/fixtures.js`) | Google Places |
| Address matching | Fixture geocoder: 48 of 50 sample rows found, 2 need review | Google Geocoding |
| Listings and owners | About 280 invented listings, seeded so they are identical every run | Inventory port (BlipBot MCP or Django) |
| Chat | Scripted intents (`js/assistant.js`), no model | A model behind the same `reply()` interface |

Distance, radius, sort, coverage and totals are plain functions in `js/domain.js`. The chat and the controls
both call `applyAction()`, so a click and a message always give the same result, and Undo reverts either.

## Files

- `styles/tokens.css`: role tokens mirrored from Figma (the only place hex values live)
- `js/terms.js`: every user-facing noun, so the vocabulary can change in one place
- `js/domain.js`: pure functions (no DOM, no map library)
- `js/map.js`: the `MapPort` adapter
- `js/app.js`: screens and wiring
