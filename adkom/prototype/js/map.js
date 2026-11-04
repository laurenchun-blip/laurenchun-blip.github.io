// MapPort, MapLibre adapter. MOCKED basemap: OpenFreeMap (keyless), restyled from the map/* role tokens.
// Google Maps replaces this in the north star behind the same port. Components never call MapLibre directly.
import { circleRing } from './domain.js';
import { icon } from './icons.js';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}

export function createMapPort(container, { onSelectListing, onHoverListing, onSelectLocation, onLasso, streets = true } = {}) {
  const ml = window.maplibregl;
  const state = { ready: false, pending: null, markers: new Map(), clusterMarkers: new Map(), hoverId: null, failed: false, streets };

  if (!ml) {
    container.innerHTML = `<div class="map-fallback">${icon('map', 20)}<p>The map could not load. Listings and distances still work.</p></div>`;
    return stubPort();
  }

  const map = new ml.Map({
    container,
    style: STYLE_URL,
    center: [-104.95, 39.75],
    zoom: 11,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.addControl(new ml.AttributionControl({ compact: true, customAttribution: 'Prototype map, invented places' }), 'bottom-left');
  map.touchZoomRotate.disableRotation();
  map.boxZoom.disable(); // Shift+drag draws a lasso instead
  window.__adkomMap = map; // debugging only

  map.on('error', (e) => {
    if (!state.ready && !state.failed && /style|Failed to fetch/i.test(String(e?.error?.message || ''))) {
      state.failed = true;
      container.insertAdjacentHTML('beforeend', `<div class="map-fallback">${icon('map', 20)}<p>Map tiles could not load. Listings and distances still work.</p></div>`);
    }
  });

  map.on('load', () => {
    restyle(map, state.streets);
    addLayers(map);
    state.ready = true;
    if (state.pending) render(state.pending);
  });

  // Zoom control drawn to match Figma
  const zoom = document.createElement('div');
  zoom.className = 'map-zoom';
  zoom.innerHTML = `<button type="button" aria-label="Zoom in" data-z="in">${icon('plus', 16)}</button><button type="button" aria-label="Zoom out" data-z="out">${icon('minus', 16)}</button>`;
  zoom.addEventListener('click', (e) => {
    const b = e.target.closest('[data-z]');
    if (b) b.dataset.z === 'in' ? map.zoomIn() : map.zoomOut();
  });
  container.appendChild(zoom);

  // ---------- Lasso: draw around pins to select them ----------
  const tool = document.createElement('button');
  tool.type = 'button';
  tool.className = 'map-tool';
  tool.setAttribute('aria-pressed', 'false');
  tool.setAttribute('aria-label', 'Select signs by drawing around them');
  tool.title = 'Select an area (or Shift + drag)';
  tool.innerHTML = icon('lasso', 16);
  container.appendChild(tool);
  const hint = document.createElement('div');
  hint.className = 'lasso-hint';
  hint.hidden = true;
  hint.textContent = 'Draw around the signs to select them · Esc to cancel';
  container.appendChild(hint);
  const svgNS = 'http://www.w3.org/2000/svg';
  const overlay = document.createElementNS(svgNS, 'svg');
  overlay.setAttribute('class', 'lasso-layer');
  const path = document.createElementNS(svgNS, 'path');
  overlay.appendChild(path);
  container.appendChild(overlay);
  let lassoOn = false, pts = null;
  function setLasso(on) {
    lassoOn = on;
    tool.classList.toggle('is-on', on);
    tool.setAttribute('aria-pressed', String(on));
    container.classList.toggle('is-lasso', on);
    hint.hidden = !on;
    on ? map.dragPan.disable() : map.dragPan.enable();
  }
  tool.addEventListener('click', () => setLasso(!lassoOn));
  const local = (e) => { const r = container.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  container.addEventListener('pointerdown', (e) => {
    if (!(lassoOn || e.shiftKey) || e.button !== 0) return;
    if (e.target.closest('button, .radius-ctl, .sign-card, .map-legend, .maplibregl-ctrl')) return;
    map.dragPan.disable();
    pts = [local(e)];
    path.setAttribute('d', '');
    overlay.classList.add('is-drawing');
    try { container.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
    e.stopPropagation();
  }, true);
  container.addEventListener('pointermove', (e) => {
    if (!pts) return;
    const p = local(e), last = pts[pts.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 3) return;
    pts.push(p);
    path.setAttribute('d', `M${pts.map((q) => q.join(',')).join('L')}Z`);
  }, true);
  const finish = (cancel) => {
    if (!pts) return;
    const poly = pts;
    pts = null;
    state.justLassoed = Date.now();
    overlay.classList.remove('is-drawing');
    path.setAttribute('d', '');
    if (!lassoOn) map.dragPan.enable();
    setLasso(false);
    if (cancel || poly.length < 3) return;
    const inside = (x, y) => {
      let hit = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    };
    const ids = (state.lastPoints || []).filter((f) => { const q = map.project([f.lng, f.lat]); return inside(q.x, q.y); }).map((f) => f.id);
    onLasso && onLasso(ids);
  };
  container.addEventListener('pointerup', () => finish(false), true);
  container.addEventListener('pointercancel', () => finish(true), true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && (pts || lassoOn)) { e.stopPropagation(); if (pts) finish(true); else setLasso(false); } }, true);

  // Two looks: "plain" matches Figma (roads barely there, no labels).
  // "streets" draws roads with contrast and shows street names. Town and place names stay hidden either way,
  // so invented market names never clash with real ones. Street names use the basemap's Noto Sans glyphs.
  function restyle(m, streets) {
    const land = token('map-land'), water = token('map-water'), park = token('map-park');
    const road = token('map-road'), highway = token('map-highway'), building = token('map-building');
    const casing = token('map-road-casing'), minorS = token('map-road-street'), label = token('map-label');
    for (const layer of m.getStyle().layers) {
      const id = layer.id;
      try {
        if (layer.type === 'background') m.setPaintProperty(id, 'background-color', land);
        else if (layer.type === 'symbol') {
          const isStreet = /^highway-name-(minor|major|path)$/.test(id);
          m.setLayoutProperty(id, 'visibility', streets && isStreet ? 'visible' : 'none');
          if (isStreet) {
            m.setPaintProperty(id, 'text-color', label);
            m.setPaintProperty(id, 'text-halo-color', land);
            m.setPaintProperty(id, 'text-halo-width', 1.5);
          }
        }
        else if (/water/.test(id) && layer.type === 'fill') m.setPaintProperty(id, 'fill-color', water);
        else if (/water/.test(id) && layer.type === 'line') m.setPaintProperty(id, 'line-color', water);
        else if (/park|wood|grass|landcover/.test(id) && layer.type === 'fill') m.setPaintProperty(id, 'fill-color', park);
        else if (/landuse|residential/.test(id) && layer.type === 'fill') m.setPaintProperty(id, 'fill-color', land);
        else if (/building/.test(id) && layer.type === 'fill') m.setPaintProperty(id, 'fill-color', building);
        else if (/motorway|trunk/.test(id) && layer.type === 'line') m.setPaintProperty(id, 'line-color', streets ? (/casing/.test(id) ? casing : highway) : highway);
        else if (/major/.test(id) && layer.type === 'line') m.setPaintProperty(id, 'line-color', streets ? (/casing/.test(id) ? casing : road) : (/casing/.test(id) ? highway : road));
        else if (/minor|path/.test(id) && layer.type === 'line') m.setPaintProperty(id, 'line-color', streets ? minorS : road);
        else if (/rail|boundary|aeroway/.test(id)) m.setLayoutProperty(id, 'visibility', 'none');
      } catch (_) { /* some layers use expressions we leave alone */ }
    }
  }

  function addLayers(m) {
    const empty = { type: 'FeatureCollection', features: [] };
    const ring = token('ring-radius');
    m.addSource('rings', { type: 'geojson', data: empty });
    m.addSource('listings', { type: 'geojson', data: empty, promoteId: 'id' });
    m.addSource('outside', { type: 'geojson', data: empty });
    m.addSource('listings-clustered', { type: 'geojson', data: empty, cluster: true, clusterRadius: 44, clusterMaxZoom: 13 });

    m.addLayer({ id: 'ring-fill', type: 'fill', source: 'rings', paint: { 'fill-color': ['coalesce', ['get', 'color'], ring], 'fill-opacity': ['coalesce', ['get', 'fillOpacity'], 0.08] } });
    m.addLayer({ id: 'ring-line', type: 'line', source: 'rings', paint: { 'line-color': ['coalesce', ['get', 'color'], ring], 'line-width': 1.5, 'line-dasharray': [3, 2] } });

    // Clustered listings (coverage view)
    m.addLayer({ id: 'cl-points', type: 'circle', source: 'listings-clustered', filter: ['!', ['has', 'point_count']], paint: {
      'circle-radius': ['case', ['==', ['get', 'id'], state.selectedId || ''], 9, 6], 'circle-color': ['get', 'color'], 'circle-stroke-color': token('pin-ring'), 'circle-stroke-width': 2 } });
    m.on('click', 'cl-points', (e) => { if (Date.now() - (state.justLassoed || 0) < 400) return; onSelectListing && onSelectListing(e.features[0]?.properties.id); });
    m.on('mouseenter', 'cl-points', () => { m.getCanvas().style.cursor = 'pointer'; });
    m.on('mouseleave', 'cl-points', () => { m.getCanvas().style.cursor = ''; });

    // Listing pins
    m.addLayer({ id: 'pin-halo', type: 'circle', source: 'listings', filter: ['==', ['get', 'isNew'], true], paint: {
      'circle-radius': 12, 'circle-color': token('pin-new'), 'circle-opacity': 0.16 } });
    // Listings just outside the radius: small, gray, still clickable.
    m.addLayer({ id: 'out-pins', type: 'circle', source: 'outside', paint: {
      'circle-radius': ['case', ['==', ['get', 'id'], state.selectedId || ''], 8, 5], 'circle-color': token('pin-outside'), 'circle-opacity': 0.9,
      'circle-stroke-color': token('pin-ring'), 'circle-stroke-width': 1.5 } });
    m.on('click', 'out-pins', (e) => { if (Date.now() - (state.justLassoed || 0) < 400) return; onSelectListing && onSelectListing(e.features[0]?.properties.id); });
    m.on('mouseenter', 'out-pins', () => { m.getCanvas().style.cursor = 'pointer'; });
    m.on('mouseleave', 'out-pins', () => { m.getCanvas().style.cursor = ''; });
    // Selected sign: a soft ring under the pin (the sign card is open for it).
    m.addLayer({ id: 'pin-selected', type: 'circle', source: 'listings', filter: ['==', ['get', 'id'], ''], paint: {
      'circle-radius': 16, 'circle-color': token('action-primary'), 'circle-opacity': 0.18, 'circle-stroke-color': token('action-primary'), 'circle-stroke-width': 1.5 } });
    m.addLayer({ id: 'pins', type: 'circle', source: 'listings', paint: {
      'circle-radius': ['case', ['boolean', ['feature-state', 'selected'], false], 10, ['boolean', ['feature-state', 'hover'], false], 9, 7],
      'circle-color': ['get', 'color'],
      'circle-stroke-color': ['case', ['boolean', ['feature-state', 'checked'], false], token('action-primary'), token('pin-ring')],
      'circle-stroke-width': ['case', ['boolean', ['feature-state', 'checked'], false], 3.5, 2],
    } });

    m.on('mouseenter', 'pins', (e) => {
      m.getCanvas().style.cursor = 'pointer';
      const id = e.features[0]?.properties.id;
      setHover(id);
      onHoverListing && onHoverListing(id);
    });
    m.on('mouseleave', 'pins', () => {
      m.getCanvas().style.cursor = '';
      setHover(null);
      onHoverListing && onHoverListing(null);
    });
    m.on('click', 'pins', (e) => { if (Date.now() - (state.justLassoed || 0) < 400) return; onSelectListing && onSelectListing(e.features[0]?.properties.id); });
    m.on('moveend', updateClusters);
    m.on('sourcedata', (e) => { if (e.sourceId === 'listings-clustered' && e.isSourceLoaded) updateClusters(); });
  }

  function setHover(id) {
    if (!state.ready) return;
    if (state.hoverId) map.setFeatureState({ source: 'listings', id: state.hoverId }, { hover: false });
    state.hoverId = id;
    if (id) map.setFeatureState({ source: 'listings', id }, { hover: true });
  }

  function setChecked(ids) {
    state.checked = new Set(ids);
    if (!state.ready) return;
    for (const id of state.checkedShown || []) if (!state.checked.has(id)) { try { map.setFeatureState({ source: 'listings', id }, { checked: false }); } catch (_) {} }
    for (const id of state.checked) { try { map.setFeatureState({ source: 'listings', id }, { checked: true }); } catch (_) {} }
    state.checkedShown = new Set(state.checked);
  }

  function selectListing(id) {
    if (!state.ready) { state.selectedId = id; return; }
    if (state.selectedId) { try { map.setFeatureState({ source: 'listings', id: state.selectedId }, { selected: false }); } catch (_) {} }
    state.selectedId = id;
    if (id) { try { map.setFeatureState({ source: 'listings', id }, { selected: true }); } catch (_) {} }
    map.setFilter('pin-selected', ['==', ['get', 'id'], id || '']);
    map.setPaintProperty('cl-points', 'circle-radius', ['case', ['==', ['get', 'id'], id || ''], 9, 6]);
    map.setPaintProperty('out-pins', 'circle-radius', ['case', ['==', ['get', 'id'], id || ''], 8, 5]);
  }

  function updateClusters() {
    if (!state.ready) return;
    const seen = new Set();
    for (const f of map.querySourceFeatures('listings-clustered')) {
      if (!f.properties.cluster) continue;
      const id = f.properties.cluster_id;
      if (seen.has(id)) continue;
      seen.add(id);
      let mk = state.clusterMarkers.get(id);
      if (!mk) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'mk-cluster';
        el.textContent = f.properties.point_count;
        el.setAttribute('aria-label', `${f.properties.point_count} listings, zoom in`);
        el.addEventListener('click', () => map.easeTo({ center: f.geometry.coordinates, zoom: map.getZoom() + 2 }));
        mk = new ml.Marker({ element: el }).setLngLat(f.geometry.coordinates).addTo(map);
        state.clusterMarkers.set(id, mk);
      }
    }
    for (const [id, mk] of state.clusterMarkers) if (!seen.has(id)) { mk.remove(); state.clusterMarkers.delete(id); }
  }

  function clearClusters() {
    for (const mk of state.clusterMarkers.values()) mk.remove();
    state.clusterMarkers.clear();
  }

  // ---------- render ----------
  // model: { anchors, results, coverage, mode: 'listings' | 'coverage', proposalIds, radiusFor(anchorId), prevRadius,
  //          selectedLocationId, preview: place|null, fit: bool, showRingLabels }
  function render(model) {
    state.pending = model;
    if (!state.ready) return;
    const colors = { available: token('pin-available'), hold: token('pin-hold'), proposal: token('pin-proposal'), isNew: token('pin-new') };
    const pinColor = (r) => model.proposalIds.includes(r.listing.id) ? colors.proposal : r.isNew ? colors.isNew : colors[r.listing.status] || colors.available;
    const features = model.results.map((r) => ({
      type: 'Feature', id: r.listing.id,
      geometry: { type: 'Point', coordinates: [r.listing.position.lng, r.listing.position.lat] },
      properties: { id: r.listing.id, color: pinColor(r), isNew: !!r.isNew },
    }));
    const fc = { type: 'FeatureCollection', features };
    map.getSource('outside').setData({ type: 'FeatureCollection', features: (model.outside || []).map((r) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.listing.position.lng, r.listing.position.lat] }, properties: { id: r.listing.id } })) });
    state.lastPoints = model.results.map((r) => ({ id: r.listing.id, lng: r.listing.position.lng, lat: r.listing.position.lat }));
    if (model.mode === 'coverage') {
      map.getSource('listings').setData({ type: 'FeatureCollection', features: [] });
      map.getSource('listings-clustered').setData(fc);
    } else {
      clearClusters();
      map.getSource('listings-clustered').setData({ type: 'FeatureCollection', features: [] });
      map.getSource('listings').setData(fc);
    }
    if (state.selectedId) selectListing(state.selectedId);
    if (state.checked) { state.checkedShown = new Set(); setChecked([...state.checked]); }

    // Rings
    const ringFeatures = [];
    const labels = [];
    const warn = token('marker-gap');
    for (const a of model.anchors) {
      const r = model.radiusFor(a.id);
      const isPoi = a.role === 'point_of_interest';
      const selected = a.id === model.selectedLocationId;
      const expanded = model.overrides && model.overrides[a.id] != null;
      if (isPoi || selected || expanded) {
        ringFeatures.push(ringFeature(a.place.position, r, expanded && !selected ? { color: warn, fillOpacity: 0.05 } : {}));
        if (isPoi || selected) labels.push({ pos: a.place.position, r });
        if (isPoi && model.prevRadius && model.prevRadius < r) {
          ringFeatures.push(ringFeature(a.place.position, model.prevRadius, { fillOpacity: 0.0 }));
          labels.push({ pos: a.place.position, r: model.prevRadius });
        }
      }
    }
    map.getSource('rings').setData({ type: 'FeatureCollection', features: ringFeatures });

    // DOM markers: anchors, ring labels, preview
    const want = new Map();
    for (const a of model.anchors) {
      const cov = model.coverage?.find((c) => c.locationId === a.id);
      const gap = a.role === 'client_location' && cov && !cov.covered;
      const key = `a:${a.id}:${gap ? 'gap' : 'ok'}:${a.id === model.selectedLocationId ? 'sel' : ''}`;
      want.set(key, () => anchorMarker(a, gap, a.id === model.selectedLocationId));
    }
    if (model.showRingLabels !== false && labels.length <= 6) {
      labels.forEach((l, i) => want.set(`l:${i}:${l.pos.lat}:${l.r}`, () => ringLabel(l.pos, l.r)));
    }
    if (model.preview) want.set(`p:${model.preview.placeId}`, () => previewMarker(model.preview));

    for (const [k, mk] of state.markers) if (!want.has(k)) { mk.remove(); state.markers.delete(k); }
    for (const [k, make] of want) if (!state.markers.has(k)) state.markers.set(k, make().addTo(map));

    if (model.fit) fit(model);
  }

  function ringFeature(center, r, props = {}) {
    return { type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [circleRing(center, r)] } };
  }

  function anchorMarker(a, gap, selected) {
    const el = document.createElement('button');
    el.type = 'button';
    if (a.role === 'point_of_interest') {
      el.className = 'mk-poi';
      el.innerHTML = icon('flag', 14);
      el.setAttribute('aria-label', a.place.name);
      el.title = a.place.name;
    } else {
      el.className = `mk-store${gap ? ' is-gap' : ''}${selected ? ' is-selected' : ''}`;
      el.innerHTML = icon('store', 13);
      el.setAttribute('aria-label', `${a.place.name}${gap ? ', no listing nearby' : ''}`);
      el.title = a.place.name;
      el.addEventListener('click', () => onSelectLocation && onSelectLocation(a.id));
    }
    return new ml.Marker({ element: el }).setLngLat([a.place.position.lng, a.place.position.lat]);
  }

  function ringLabel(center, r) {
    const el = document.createElement('div');
    el.className = 'mk-ring-label';
    el.textContent = `${Math.round(r * 10) / 10} mi`;
    const lat = center.lat + (r / 69.0) * Math.cos(Math.PI / 4);
    const lng = center.lng + (r / (69.17 * Math.cos((center.lat * Math.PI) / 180))) * Math.sin(Math.PI / 4);
    return new ml.Marker({ element: el, anchor: 'bottom-left' }).setLngLat([lng, lat]);
  }

  function previewMarker(place) {
    const el = document.createElement('div');
    el.className = 'mk-preview';
    el.innerHTML = `<span class="mk-preview-label">${place.name}</span><span class="mk-preview-pin">${icon('mapPin', 14)}</span>`;
    return new ml.Marker({ element: el, anchor: 'bottom' }).setLngLat([place.position.lng, place.position.lat]);
  }

  function fit(model) {
    const pts = [];
    for (const a of model.anchors) {
      const r = model.radiusFor(a.id);
      const ring = circleRing(a.place.position, r, 8);
      pts.push(...ring);
    }
    if (model.preview) pts.push(...circleRing(model.preview.position, 0.8, 8));
    if (!pts.length) return;
    const lngs = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
    map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 36, duration: 600, maxZoom: 14.5 });
  }

  return {
    render,
    highlightListing: setHover,
    selectListing,
    setChecked,
    setStreets(on) { state.streets = on; if (state.ready) restyle(map, on); },
    flyTo(position, zoom = 13.5) { if (state.ready) map.easeTo({ center: [position.lng, position.lat], zoom, duration: 500 }); },
    resize() { map.resize(); },
  };
}

function stubPort() {
  return { render() {}, highlightListing() {}, selectListing() {}, setChecked() {}, flyTo() {}, resize() {}, setStreets() {} };
}
