# crush — user stories

Living document. Stories describe **what the user wants to accomplish**, not implementation. Each story should be testable end-to-end through the voice interface.

---

## US-1: Run distance calculator

**As a** user who just went for a run,  
**I want to** tell Crush my route and have it help me figure out the distance,  
**so that** I can track my runs without a GPS watch or phone app.

### Happy path

1. User says: "Hey, I just went for a run. Can you help me work out how far it was?"
2. Crush asks where they ran (starting point, route landmarks, end point).
3. Crush brings a **map pane into the scene** showing the area.
4. User describes waypoints ("I went down the high street, turned left at the park, along the river...").
5. Crush plots the waypoints on the map, connecting them into a route.
6. Crush computes the distance along the route and tells the user.
7. Route + distance are saved (profile or workspace file) for future reference.

### What makes this a good Crush story

- It's **not a chatbot conversation** — it produces a visible artifact in the scene (map + route).
- It uses multiple capabilities: voice intake → geocoding API → map rendering → distance calculation.
- The user and Crush **co-pilot** the task: Crush brings the map, user describes the route, Crush plots and computes.
- Natural follow-ups: "actually I went further, past the bridge" → re-plot. "How does that compare to last week?" → pull history.

### Implementation sketch

- New pane type: `MapPane` — renders a map tile layer (Leaflet or Mapbox GL) into a texture or HTML overlay.
- Geocoding: Nominatim (free) or Mapbox geocoding API to convert place descriptions → lat/lng.
- Route plotting: polyline on the map from waypoints.
- Distance: haversine between waypoints, or use a routing API (OSRM, Mapbox Directions) for road-following distance.
- Tool: `create_pane` with `pane_type: 'map'` + new tools like `add_map_marker`, `plot_route`, `compute_route_distance`.

### Effort estimate

- **Map pane type**: 2-3 days (Leaflet in an OffscreenCanvas or CSS2DRenderer overlay, texture upload to Three.js)
- **Geocoding integration**: 0.5 day (Nominatim is free, no API key needed)
- **Route plotting + distance tools**: 1 day
- **FOH prompt + tool wiring**: 0.5 day
- **Total: ~4-5 days**

---

## US-2: Consultative research (general)

**As a** user with a complex goal,  
**I want** Crush to probe, research in rounds, and build up a picture iteratively,  
**so that** I get genuinely useful results, not a generic one-shot search dump.

*(See ADR-010 for the consultative behavior pattern.)*

---

## US-3: (template for future stories)

**As a** ...,  
**I want to** ...,  
**so that** ...
