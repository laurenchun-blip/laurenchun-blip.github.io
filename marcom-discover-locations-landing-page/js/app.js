// Discover Locations — map + page wiring.
(function () {
  const { loadCoverage, loadStates, buildIndex, Enrichment, STATIC_STATS } = window.DiscoverData;

  const LOWER_48 = [[-124.9, 24.3], [-66.8, 49.5]];
  const FIG = 'assets/figma/';
  const mqMobile = window.matchMedia('(max-width: 760px)');
  const isMobile = () => mqMobile.matches;

  // States without inventory, including those that ban billboards, are "No coverage yet" (grey, as in the Figma).
  const DENSITY = { high: '#7e0449', medium: '#d86085', low: '#dd9cb3', none: '#cecece' };
  // Desaturated ramp from the "Pins on Density Map – Desaturated" component (892:34198). Used in Pins mode and for
  // every state that isn't selected, so the selected state is the only one left in full density colour.
  const MUTED = { high: '#bea4b3', medium: '#d1afba', low: '#e0cad2', none: '#cecece' };

  let idx = null;
  let map = null;
  let mode = 'density';
  let selectedState = null;
  let hoveredState = null;
  let panelStack = [];
  const stateBounds = new Map(); // state name -> bbox of its outline (not of its signs)
  // A state click frames the whole state, but never closer than this — small states (RI, DE, CT)
  // stay regional instead of jumping to street level.
  const STATE_MAX_ZOOM = 6;

  const $ = sel => document.querySelector(sel);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => n.toLocaleString('en-US');

  // ---------------------------------------------------------------- boot
  async function init() {
    wireStaticUI();
    try {
      const [{ fc, source, enriched }, statesFC] = await Promise.all([loadCoverage(), loadStates()]);
      idx = buildIndex(fc);
      bindNumbers(source, enriched);
      renderTopMarkets();
      renderStateGrid();
      initMap(statesFC);
    } catch (e) {
      console.error(e);
      $('#map-loading').innerHTML = 'Couldn’t load sign locations. Refresh to try again.';
    }
  }

  function bindNumbers(source, enriched) {
    const total = idx.totalSigns;
    const floorTo = total >= 1000 ? Math.floor(total / 100) * 100 : total;
    const values = {
      boardsPlus: fmt(floorTo) + '+',
      boardsShort: (Math.floor(total / 100) / 10).toFixed(1).replace(/\.0$/, '') + 'K+',
      statesLive: String(idx.statesLive),
      ...STATIC_STATS
    };
    document.querySelectorAll('[data-bind]').forEach(el => {
      const v = values[el.dataset.bind];
      if (v != null) el.textContent = v;
    });
    const all = [...idx.signs.values()];
    const withDetail = all.filter(sg => sg.size || sg.address).length;
    const withViews = all.filter(sg => sg.views).length;
    const where = { live: 'live Blip inventory', inventory: 'live Blip inventory (detail feed only)', snapshot: 'saved snapshot of Blip inventory' }[source];
    // Kept out of the page so it reads like the real product; here for whoever is debugging the data.
    console.info(`[discover] Sign data: ${where} · ${fmt(total)} signs at exact coordinates` +
      (enriched ? ` · detail for ${fmt(withDetail)}, daily views for ${fmt(withViews)}` : ' · no sign detail'));
  }

  // ---------------------------------------------------------------- map
  function initMap(statesFC) {
    for (const f of statesFC.features) {
      const name = f.properties.name;
      const s = idx.states.get(name);
      f.properties.tier = s ? s.tier : 'none';
      f.properties.count = s ? s.count : 0;
      stateBounds.set(name, geomBbox(f.geometry));
    }

    map = new maplibregl.Map({
      container: 'map',
      style: 'https://tiles.openfreemap.org/styles/positron',
      bounds: LOWER_48,
      fitBoundsOptions: { padding: fitPadding() },
      minZoom: 1.5,
      // Keeps Alaska out (north edge) — they live in the overview insets, never as giant Mercator shapes.
      // The south edge is loose on purpose: framing Florida or Texas above the mobile sheet centres the map well
      // south of them, and a tight edge clamped them behind the sheet.
      maxBounds: [[-140, -5], [-50, 55]],
      maxZoom: 17,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      renderWorldCopies: false,
      cooperativeGestures: true,
      attributionControl: { compact: true }
    });
    map.touchZoomRotate.disableRotation();

    map.on('load', () => {
      addImages();
      streetLevelBackground();

      // Mask the basemap at country scale so the national view reads like the Figma (flat states on #fafafa),
      // then fade it out as you zoom so streets show up around the pins.
      map.addSource('mask', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] } } });
      map.addLayer({ id: 'mask', type: 'fill', source: 'mask', paint: { 'fill-color': '#fafafa', 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 4.8, 1, 6.4, 0] } });

      map.addSource('states', { type: 'geojson', data: statesFC, promoteId: 'name' });
      map.addLayer({ id: 'states-fill', type: 'fill', source: 'states', paint: { 'fill-color': fillColor(), 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5, 1, 7, 0.32, 10, 0.1, 12, 0] } });
      map.addLayer({ id: 'states-line', type: 'line', source: 'states', paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.9, 7, 1.6] } });
      map.addLayer({ id: 'states-hover', type: 'line', source: 'states', paint: { 'line-color': '#b80067', 'line-width': 1.6, 'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 1, 0] } });
      map.addLayer({ id: 'states-selected', type: 'line', source: 'states', paint: { 'line-color': '#fb0060', 'line-width': 2.4, 'line-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 1, 0] } });

      // Two cluster tiers: coarse groups while zoomed out (state/region views) so the map isn't covered in
      // 1–2 sign markers, then the finer grouping from city zoom in, breaking down to single pins at street level.
      addSignLayers('signs-coarse', '-coarse', 90, CLUSTER_TIER_ZOOM);
      addSignLayers('signs', '', 38, 11);
      map.addSource('selected-sign', { type: 'geojson', data: emptyFC() });
      map.addLayer({ id: 'pin-selected', type: 'symbol', source: 'selected-sign', layout: { 'icon-image': 'pin-selected', 'icon-anchor': 'bottom', 'icon-allow-overlap': true } });

      applyMode();
      wireMapEvents();
      const attrib = document.querySelector('.maplibregl-ctrl-attrib');
      if (attrib) attrib.classList.remove('maplibregl-compact-show');
      map.on('zoomend', maybeReturnToOverview);
      initOverview(statesFC);
      $('#map-loading').classList.add('is-done');
      handleDeepLink();
    });
  }

  // At street level the basemap's near-white base makes roads and pins hard to read, so fade it to #DDE2EA
  // between city and street zoom. Country and state views keep the original colour.
  const STREET_BG = '#DDE2EA';
  function streetLevelBackground() {
    const bg = map.getStyle().layers.find(l => l.type === 'background');
    if (!bg) return;
    const base = map.getPaintProperty(bg.id, 'background-color');
    const from = typeof base === 'string' ? base : '#f2f3f0';
    map.setPaintProperty(bg.id, 'background-color', ['interpolate', ['linear'], ['zoom'], 10, from, 12, STREET_BG]);
  }

  const CLUSTER_TIER_ZOOM = 9; // below this, the coarse tier shows; from here in, the fine tier

  function addSignLayers(source, suffix, radius, maxZoom) {
    map.addSource(source, { type: 'geojson', data: idx.signsGeoJSON, cluster: true, clusterRadius: radius, clusterMaxZoom: maxZoom });
    map.addLayer({
      id: 'clusters' + suffix, type: 'circle', source, filter: ['has', 'point_count'],
      paint: {
        'circle-color': '#fb0060', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
        'circle-radius': ['step', ['get', 'point_count'], 10, 10, 12, 50, 15, 200, 19]
      }
    });
    map.addLayer({
      id: 'cluster-count' + suffix, type: 'symbol', source, filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Bold'], 'text-size': 10.5, 'text-allow-overlap': true },
      paint: { 'text-color': '#ffffff' }
    });
    map.addLayer({
      id: 'pins' + suffix, type: 'symbol', source, filter: ['!', ['has', 'point_count']],
      layout: { 'icon-image': 'pin', 'icon-anchor': 'bottom', 'icon-allow-overlap': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.7, 10, 0.85, 14, 1] }
    });
  }

  function fillColor() {
    const ramp = pal => ['match', ['get', 'tier'], 'high', pal.high, 'medium', pal.medium, 'low', pal.low, pal.none];
    if (mode === 'density' && !selectedState) return ramp(DENSITY);
    return ['case', ['boolean', ['feature-state', 'selected'], false], ramp(DENSITY), ramp(MUTED)];
  }

  function applyMode() {
    if (!map || !map.getLayer('states-fill')) return;
    map.setPaintProperty('states-fill', 'fill-color', fillColor());
    // Density mode keeps the country view clean; pins/clusters arrive once you're into a state.
    const minZ = mode === 'pins' ? 0 : 4.6;
    ['clusters', 'cluster-count', 'pins'].forEach(id => {
      map.setLayerZoomRange(id + '-coarse', minZ, CLUSTER_TIER_ZOOM);
      map.setLayerZoomRange(id, Math.max(minZ, CLUSTER_TIER_ZOOM), 24);
    });
    $('#legend').classList.toggle('is-pins', mode === 'pins'); // same density legend, muted swatches in Pins mode
    document.querySelectorAll('.mode-toggle button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
    renderOverview();
  }

  function addImages() {
    const dpr = 2;
    const pin = (w, h, fill) => {
      const c = document.createElement('canvas');
      c.width = w * dpr; c.height = h * dpr;
      const g = c.getContext('2d');
      g.scale(dpr * w / 22, dpr * h / 28);
      const p = new Path2D('M11 27s9-8.6 9-15.5A9 9 0 0 0 2 11.5C2 18.4 11 27 11 27Z');
      g.shadowColor = 'rgba(0,0,0,.25)'; g.shadowBlur = 3; g.shadowOffsetY = 1;
      g.fillStyle = fill; g.fill(p);
      g.shadowColor = 'transparent';
      g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke(p);
      g.beginPath(); g.arc(11, 11.5, 3.4, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
      return { width: c.width, height: c.height, data: g.getImageData(0, 0, c.width, c.height).data };
    };
    map.addImage('pin', pin(18, 23, '#fb0060'), { pixelRatio: dpr });
    map.addImage('pin-selected', pin(28, 36, '#b80067'), { pixelRatio: dpr });
  }

  function wireMapEvents() {
    const tip = $('#map-tip');
    const hitLayers = ['pins', 'pins-coarse', 'clusters', 'clusters-coarse', 'states-fill'];
    const isPin = f => f.layer.id.startsWith('pins');
    const isCluster = f => f.layer.id.startsWith('clusters');

    map.on('mousemove', e => {
      const f = map.queryRenderedFeatures(e.point, { layers: hitLayers })[0];
      const live = f && (f.layer.id !== 'states-fill' || f.properties.count > 0);
      setHoverState(live && f.layer.id === 'states-fill' ? f.properties.name : null);
      map.getCanvas().style.cursor = live ? 'pointer' : '';
      if (!f) { tip.hidden = true; return; }
      if (isPin(f)) {
        tip.innerHTML = `<b>${esc(f.properties.name)}</b><span>${esc(f.properties.city)}, ${f.properties.abbr}</span>`;
      } else if (isCluster(f)) {
        tip.innerHTML = `<b>${fmt(f.properties.point_count)} boards</b><span>Click to zoom in</span>`;
      } else {
        const p = f.properties;
        tip.innerHTML = `<b>${esc(p.name)}</b><span>${p.count ? fmt(p.count) + ' boards' : 'No coverage yet'}</span>`;
      }
      tip.hidden = false;
      tip.style.left = e.originalEvent.clientX + 'px';
      tip.style.top = e.originalEvent.clientY + 'px';
    });
    map.getCanvas().addEventListener('mouseleave', () => { tip.hidden = true; setHoverState(null); });

    map.on('click', e => {
      tip.hidden = true;
      const f = map.queryRenderedFeatures(e.point, { layers: hitLayers })[0];
      if (!f) return;
      if (isPin(f)) return openSign(f.properties.signId, { fly: true });
      if (isCluster(f)) {
        map.getSource(f.source).getClusterExpansionZoom(f.properties.cluster_id).then(z => {
          map.easeTo({ center: f.geometry.coordinates, zoom: Math.min(z + 0.3, 16), padding: fitPadding() });
        });
        return;
      }
      if (f.properties.count > 0) openState(f.properties.name, { fly: true });
    });
  }

  function setHoverState(name) {
    if (hoveredState === name) return;
    if (hoveredState) map.setFeatureState({ source: 'states', id: hoveredState }, { hover: false });
    hoveredState = name;
    if (name) map.setFeatureState({ source: 'states', id: name }, { hover: true });
  }

  function setSelectedState(name) {
    if (selectedState) map.setFeatureState({ source: 'states', id: selectedState }, { selected: false });
    selectedState = name;
    if (name) map.setFeatureState({ source: 'states', id: name }, { selected: true });
    if (map.getLayer('states-fill')) map.setPaintProperty('states-fill', 'fill-color', fillColor());
    renderOverview();
  }

  function setSelectedSign(sign) {
    map.getSource('selected-sign').setData(sign ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [sign.lng, sign.lat] }, properties: {} }] } : emptyFC());
  }

  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

  // ---------------------------------------------------------------- overview (Albers USA)
  // The country view is drawn with d3's Albers USA projection — Alaska and Hawaii as insets, like the Figma.
  // Clicking or zooming in hands off to MapLibre (real geography, streets, pins); zooming back out returns here.
  let view = 'overview';
  let ov = null;
  let handoffAt = 0;

  function initOverview(statesFC) {
    const el = $('#overview');
    const svg = d3.select(el).append('svg').attr('role', 'img').attr('aria-label', 'US map of Blip billboard coverage by state');
    const g = svg.append('g').attr('class', 'ov-zoom');
    g.append('g').attr('class', 'ov-states');
    g.append('g').attr('class', 'ov-marks');
    const projection = d3.geoAlbersUsa();
    ov = { el, svg, g, projection, path: d3.geoPath(projection), features: statesFC.features.filter(f => f.properties.name !== 'Puerto Rico').map(rewindForD3) };

    // Pinch (ctrl+wheel on trackpads) or double-click hands off to the street map at that spot.
    el.addEventListener('wheel', e => {
      if (!(e.ctrlKey || e.metaKey) || e.deltaY >= 0) return;
      e.preventDefault();
      zoomIntoPoint(e);
    }, { passive: false });
    el.addEventListener('dblclick', e => { e.preventDefault(); zoomIntoPoint(e); });

    new ResizeObserver(() => renderOverview()).observe(el);
    renderOverview();
    updateZoomButtons();
  }

  // GeoJSON rings are counter-clockwise; d3 reads that as "the whole globe minus the state". Flip any that come out inverted.
  function rewindForD3(f) {
    const flip = poly => poly.map(ring => ring.slice().reverse());
    const g = f.geometry;
    const fixed = g.type === 'Polygon'
      ? { type: 'Polygon', coordinates: d3.geoArea(g) > 2 * Math.PI ? flip(g.coordinates) : g.coordinates }
      : { type: 'MultiPolygon', coordinates: g.coordinates.map(p => d3.geoArea({ type: 'Polygon', coordinates: p }) > 2 * Math.PI ? flip(p) : p) };
    return { ...f, geometry: fixed };
  }

  function zoomIntoPoint(e) {
    const r = ov.el.getBoundingClientRect();
    const ll = ov.projection.invert([e.clientX - r.left, e.clientY - r.top]);
    if (!ll || ll[0] < -130 || ll[1] > 52) return; // inside an inset or off-map
    enterDetail([ll[0] - 4, ll[1] - 3, ll[0] + 4, ll[1] + 3], 7);
  }

  function overviewFill(d) {
    const t = d.properties.tier;
    if (mode === 'density' && !selectedState) return DENSITY[t];
    return d.properties.name === selectedState ? DENSITY[t] : MUTED[t];
  }

  function renderOverview() {
    if (!ov || view !== 'overview') return;
    const w = ov.el.clientWidth, h = ov.el.clientHeight;
    if (!w || !h) return;
    const panelRoom = !$('#panel').hidden && !isMobile() ? 288 : 0;
    const pad = isMobile() ? 14 : 30;
    ov.projection.fitExtent([[pad, pad], [w - pad - panelRoom, h - pad]], { type: 'FeatureCollection', features: ov.features });
    ov.svg.attr('width', w).attr('height', h).attr('viewBox', `0 0 ${w} ${h}`);

    ov.g.select('.ov-states').selectAll('path')
      .data(ov.features, d => d.properties.name)
      .join(enter => enter.append('path')
        .on('mouseenter', (e, d) => { if (d.properties.count) d3.select(e.currentTarget).raise(); })
        .on('mousemove', (e, d) => showTip(e, stateTip(d.properties)))
        .on('mouseleave', () => { $('#map-tip').hidden = true; })
        .on('click', (e, d) => { if (!d.properties.count) return; $('#map-tip').hidden = true; openState(d.properties.name); }))
      .attr('d', ov.path)
      .classed('is-empty', d => !d.properties.count)
      .attr('fill', overviewFill)
      .classed('is-selected', d => d.properties.name === selectedState);
    ov.g.select('.ov-states .is-selected').raise();
    renderOverviewClusters();
  }

  // Pins mode at country scale: signs binned on a screen grid, same pink count bubbles as the street map.
  function renderOverviewClusters() {
    const layer = ov.g.select('.ov-marks');
    if (mode !== 'pins') { layer.selectAll('*').remove(); return; }
    const cell = isMobile() ? 52 : 72; // coarse at country scale, matching the zoomed-out tier on the street map
    const bins = new Map();
    for (const s of idx.signs.values()) {
      const p = ov.projection([s.lng, s.lat]);
      if (!p) continue;
      const k = Math.floor(p[0] / cell) + ':' + Math.floor(p[1] / cell);
      let b = bins.get(k);
      if (!b) bins.set(k, b = { x: 0, y: 0, n: 0, bbox: [Infinity, Infinity, -Infinity, -Infinity] });
      b.x += p[0]; b.y += p[1]; b.n++;
      b.bbox = [Math.min(b.bbox[0], s.lng), Math.min(b.bbox[1], s.lat), Math.max(b.bbox[2], s.lng), Math.max(b.bbox[3], s.lat)];
    }
    const data = [...bins.values()].map(b => ({ ...b, x: b.x / b.n, y: b.y / b.n }));
    const radius = n => n >= 200 ? 19 : n >= 50 ? 15 : n >= 10 ? 12 : n > 1 ? 10 : 6;
    const groups = layer.selectAll('g.ov-cluster').data(data)
      .join(enter => { const g = enter.append('g').attr('class', 'ov-cluster'); g.append('circle'); g.append('text'); return g; })
      .attr('transform', d => `translate(${d.x},${d.y})`)
      .on('mousemove', (e, d) => showTip(e, `<b>${fmt(d.n)} board${d.n > 1 ? 's' : ''}</b><span>Click to zoom in</span>`))
      .on('mouseleave', () => { $('#map-tip').hidden = true; })
      .on('click', (e, d) => { e.stopPropagation(); $('#map-tip').hidden = true; enterDetail(d.bbox, 12); });
    groups.select('circle').attr('r', d => radius(d.n));
    groups.select('text').text(d => d.n === 1 ? '' : d.n >= 1000 ? (d.n / 1000).toFixed(1) + 'k' : d.n);
  }

  function stateTip(p) {
    return `<b>${esc(p.name)}</b><span>${p.count ? fmt(p.count) + ' boards' : 'No coverage yet'}</span>`;
  }

  function showTip(e, html) {
    const tip = $('#map-tip');
    tip.innerHTML = html;
    tip.hidden = false;
    tip.style.left = e.clientX + 'px';
    tip.style.top = e.clientY + 'px';
  }

  // The "shift": the overview zooms toward the target while the street map, already framed on it, fades in underneath.
  function enterDetail(b, maxZoom) {
    view = 'detail';
    handoffAt = Date.now();
    const single = b[0] === b[2] && b[1] === b[3];
    if (single) map.jumpTo({ center: [b[0], b[1]], zoom: maxZoom || 13, padding: fitPadding() });
    else map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: fitPadding(), maxZoom: maxZoom || 12, duration: 0 });

    const w = ov.el.clientWidth, h = ov.el.clientHeight;
    const p0 = ov.projection([b[0], b[3]]), p1 = ov.projection([b[2], b[1]]);
    const g = ov.g.node();
    if (p0 && p1) {
      const cx = (p0[0] + p1[0]) / 2, cy = (p0[1] + p1[1]) / 2;
      const k = Math.min(8, 0.8 * Math.min(w / Math.max(p1[0] - p0[0], 1), h / Math.max(p1[1] - p0[1], 1)));
      g.style.transform = `translate(${w / 2 - cx * k}px, ${h / 2 - cy * k}px) scale(${k})`;
    }
    ov.el.classList.add('is-leaving');
    $('#map-tip').hidden = true;
    setTimeout(() => {
      if (view !== 'detail') return;
      ov.el.hidden = true;
      ov.el.classList.remove('is-leaving');
      g.style.transition = 'none';
      g.style.transform = '';
      g.getBoundingClientRect();
      g.style.transition = '';
    }, 520);
    updateZoomButtons();
  }

  function enterOverview() {
    if (view === 'overview') return;
    view = 'overview';
    setSelectedSign(null);
    // City and sign panels don't mean much at country scale — step back to the state.
    if (panelStack.length > 1) openState(panelStack[0].id, { fly: false });
    ov.el.hidden = false;
    ov.el.classList.add('is-entering');
    renderOverview();
    requestAnimationFrame(() => requestAnimationFrame(() => ov.el.classList.remove('is-entering')));
    map.fitBounds(LOWER_48, { padding: fitPadding(), duration: 0 });
    updateZoomButtons();
  }

  // Zoom-out past this returns to the overview: the lower-48 fit, ignoring any open panel, plus a margin.
  // Measuring with the panel's padding put the threshold below what maxBounds allows, so you could never get back.
  function overviewZoom() {
    const pad = isMobile() ? 20 : 36;
    const cam = map.cameraForBounds(LOWER_48, { padding: pad });
    return (cam ? cam.zoom : 3) + 0.35;
  }

  function maybeReturnToOverview() {
    if (view !== 'detail' || Date.now() - handoffAt < 700) return;
    if (map.getZoom() <= overviewZoom()) enterOverview();
  }

  function updateZoomButtons() {
    $('#zoom-out').disabled = view === 'overview';
  }

  function fitPadding() {
    const panelOpen = !$('#panel').hidden;
    if (isMobile()) return { top: 24, left: 20, right: 20, bottom: panelOpen ? sheetOverlap() + 20 : 24 };
    return { top: 36, left: 36, bottom: 36, right: panelOpen ? 308 : 36 };
  }

  // How much of the map the bottom sheet covers once the map is scrolled to the top of the screen
  // (renderPanel does that scroll), so the fit doesn't depend on where the scroll is mid-animation.
  function sheetOverlap() {
    const frameH = $('.map-frame').offsetHeight;
    const frameTop = isFullscreen() ? $('.map-frame').getBoundingClientRect().top : 0;
    const sheetTop = innerHeight - $('#panel').offsetHeight;
    const overlap = frameTop + frameH - sheetTop;
    return Math.max(0, Math.min(overlap, frameH - 120));
  }

  function fitBbox(b, maxZoom) {
    if (view === 'overview') return enterDetail(b, maxZoom);
    const single = b[0] === b[2] && b[1] === b[3];
    if (single) return map.easeTo({ center: [b[0], b[1]], zoom: maxZoom || 13, padding: fitPadding(), duration: 900 });
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: fitPadding(), maxZoom: maxZoom || 12, duration: 900 });
  }

  function resetView() {
    closePanel();
    enterOverview();
  }

  // ---------------------------------------------------------------- panel
  // Only states with inventory open. No-coverage states aren't interactive until another source can describe them.
  function openState(name, opts = {}) {
    const s = idx.states.get(name);
    if (!s) return;
    setSelectedSign(null);
    setSelectedState(name);
    panelStack = [{ type: 'state', id: name }];
    renderPanel(stateView(name, s));
    if (opts.fly !== false) {
      const b = stateBounds.get(name);
      if (b) fitBbox(b, STATE_MAX_ZOOM);
    }
    Enrichment.state(name).then(d => { if (d && current('state', name)) renderPanel(stateView(name, s, d)); });
  }

  function openCity(key, opts = {}) {
    const c = idx.cities.get(key);
    if (!c) return;
    setSelectedSign(null);
    setSelectedState(c.state);
    panelStack = [{ type: 'state', id: c.state }, { type: 'city', id: key }];
    renderPanel(cityView(c));
    if (opts.fly !== false) fitBbox(c.bbox, 13);
    Enrichment.city(key).then(d => { if (d && current('city', key)) renderPanel(cityView(c, d)); });
  }

  function openSign(id, opts = {}) {
    const sg = idx.signs.get(id);
    if (!sg) return;
    setSelectedState(sg.state);
    setSelectedSign(sg);
    panelStack = [{ type: 'state', id: sg.state }, { type: 'city', id: sg.cityKey }, { type: 'sign', id }];
    renderPanel(signView(sg));
    if (view === 'overview') enterDetail([sg.lng, sg.lat, sg.lng, sg.lat], 14);
    else if (opts.fly) map.easeTo({ center: [sg.lng, sg.lat], zoom: Math.max(map.getZoom(), 14), padding: fitPadding(), duration: 900 });
    Enrichment.sign(id).then(d => { if (d && current('sign', id)) renderPanel(signView(sg, d)); });
  }

  function current(type, id) { const top = panelStack[panelStack.length - 1]; return top && top.type === type && top.id === id; }

  function closePanel() {
    const p = $('#panel');
    p.hidden = true; p.innerHTML = '';
    panelStack = [];
    $('#map-tip').hidden = true;
    setSelectedState(null);
    setSelectedSign(null);
  }

  function renderPanel(html) {
    const p = $('#panel');
    const wasHidden = p.hidden;
    p.innerHTML = html;
    p.hidden = false;
    p.classList.remove('is-collapsed');
    p.querySelector('.panel__scroll').scrollTop = 0;
    if (wasHidden && isMobile() && !isFullscreen()) {
      // Bring the map to the top of the screen so the sheet sits below it, like the mobile mocks.
      const top = $('.map-frame').getBoundingClientRect().top + scrollY;
      scrollTo({ top, behavior: 'smooth' });
    }
    renderOverview(); // the desktop panel docks over the map, so the overview refits beside it
  }

  const close = `<button type="button" class="panel__close" data-act="close" aria-label="Close"><img src="${FIG}panel/close.svg" alt=""></button>`;
  const handle = `<button type="button" class="panel__handle" data-act="collapse" aria-label="Collapse panel"></button>`;
  const metric = (value, label) => value == null
    ? `<div class="metric"><b class="is-pending">—</b><span>${label}</span></div>`
    : `<div class="metric"><b class="${value.length > 8 ? 'is-long' : ''}">${esc(value)}</b><span>${label}</span></div>`;
  // 2,943,025 → 2.9M · 129,604 → 130K · 8,400 → 8.4K · 950 → 950
  const compact = n => n == null ? null
    : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
    : n >= 1e4 ? Math.round(n / 1e3) + 'K'
    : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'
    : fmt(Math.round(n));
  const avgViews = o => o.viewsN ? compact(o.viewsSum / o.viewsN) : null;
  // Sign-up and login go to the live marketplace; the guide pages don't exist in this prototype yet.
  const REGISTER_URL = 'https://marketplace.blipbillboards.com/register';
  const ctas = guide => `<div class="panel__ctas"><a class="cta cta--fill" href="${REGISTER_URL}">Start Advertising</a><a class="cta cta--line" href="#">${esc(guide)} Advertising Guide</a></div>`;
  const countBlock = n => `<span class="count"><b>${fmt(n)}</b><small>boards</small></span><span class="chev"><img src="${FIG}imgIcon.svg" alt=""></span>`;

  function stateView(name, s, d = {}) {
    const cities = idx.citiesByState(name);
    const first = 6; // top cities; the rest are on the map
    return `${handle}<div class="panel__scroll">
      <div class="panel__pad">
        <div class="panel__title-row"><h3 class="panel__title">${esc(name)}</h3>${close}</div>
        <div class="metrics">
          ${metric(fmt(s.count), 'Active boards')}
          ${metric(fmt(s.cityCount), 'Cities covered')}
          ${metric(s.viewsN ? compact(s.viewsSum) : null, 'Daily impressions')}
          ${metric(avgViews(s), 'Avg daily impressions / board')}
        </div>
      </div>
      <div class="panel__pad">
        <h4 class="panel__h">Major cities to explore</h4>
        <div class="city-grid">
          ${cities.slice(0, first).map(c => `<button type="button" class="city-btn" data-city="${esc(c.key)}"><span class="city-btn__name">${esc(c.name)}, ${c.abbr}</span>${countBlock(c.count)}</button>`).join('')}
        </div>
      </div>
    </div>${ctas(name)}`;
  }

  function cityView(c, d = {}) {
    // Boards ranked by daily views (the mock's "high performing boards"); boards without views go last.
    const signs = c.signIds.map(id => idx.signs.get(id)).sort((a, b) => (b.views || 0) - (a.views || 0));
    const ranked = c.viewsN > 0;
    const rows = signs.map(sg => ({ sign: sg, right: sg.views ? compact(sg.views) + ' impressions' : '' }));
    const range = c.viewsN ? (c.viewsN > 1 && c.viewsMin !== c.viewsMax ? `${compact(c.viewsMin)}-${compact(c.viewsMax)}` : compact(c.viewsMax)) : null;
    const first = 4; // top boards only; every board is still a pin on the map
    return `${handle}<div class="panel__scroll">
      <div class="panel__pad">
        <div class="panel__title-row"><h3 class="panel__title">${esc(c.name)}</h3>${close}</div>
        <p class="panel__subtitle">${esc(c.state)}</p>
        <div class="metrics">
          ${metric(fmt(c.count), 'Active boards')}
          ${metric(c.viewsN ? compact(c.viewsSum) : null, 'Daily impressions')}
          ${metric(range, c.viewsN ? `Daily impressions across ${fmt(c.viewsN)} board${c.viewsN === 1 ? '' : 's'}` : 'Daily impressions / board')}
          ${metric(avgViews(c), 'Avg daily impressions / board')}
        </div>
      </div>
      <div class="panel__pad">
        <h4 class="panel__h">${ranked ? 'High performing boards in this area' : 'Boards in this area'}</h4>
        <div>
          ${rows.slice(0, first).map(r => `<button type="button" class="board-row" data-sign="${esc(r.sign.id)}"><b>${esc(r.sign.address || r.sign.name)}</b><span>${esc(r.right || 'View sign ›')}</span></button>`).join('')}
        </div>
      </div>
    </div>${ctas(c.name)}`;
  }

  // Blip plays are 8 seconds (the FAQ says the same); no feed carries it per sign.
  const BLIP_SECONDS = 8;

  function signView(sg, d = {}) {
    const city = idx.cities.get(sg.cityKey);
    const spec = (label, v) => `<div class="spec"><span>${label}</span><b class="${v == null ? 'is-pending' : ''}">${v == null ? '—' : esc(v)}</b></div>`;
    const tags = [sg.facing, sg.read].filter(Boolean);
    // The detail feed's name is sometimes just "City, ST"; only prefer it when it says more than that.
    const detailName = d.title && d.title.toLowerCase() !== `${sg.city}, ${sg.abbr}`.toLowerCase() ? d.title : null;
    const title = detailName || sg.address || sg.name;
    const meta = [sg.name !== title ? sg.name : null, sg.address && sg.address !== title ? sg.address : null, `${sg.city}, ${sg.abbr}`].filter(Boolean).join(' · ');
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${sg.lat},${sg.lng}`;
    return `${handle}<div class="panel__scroll" style="gap:16px">
      <div class="panel__pad">
        <div class="panel__title-row">
          <button type="button" class="panel__back" data-act="back"><svg viewBox="0 0 6 10" aria-hidden="true"><path d="M5 1 1 5l4 4"/></svg>Back to ${esc(city ? city.name : sg.state)}</button>
          ${close}
        </div>
        ${sg.photo ? `<div class="board-preview board-preview--photo"><img src="${esc(sg.photo)}" alt="Photo of sign ${esc(sg.name)}" loading="lazy" onerror="this.parentNode.outerHTML=window.__boardPreview()"></div>` : boardPreview()}
      </div>
      <div class="panel__pad">
        <p class="sign-kicker">BILLBOARD</p>
        <h3 class="sign-name">${esc(title)}</h3>
        <p class="sign-meta">${esc(meta)}</p>
        <div class="icon-row">
          <a class="icon-btn" href="${mapsUrl}" target="_blank" rel="noopener" aria-label="Open location in Google Maps" title="Open in Google Maps"><img src="${FIG}panel/iconOpen.svg" alt=""></a>
        </div>
        <div class="specs">
          ${spec('Daily impressions', sg.views ? compact(sg.views) : null)}
          ${spec('Blip duration', BLIP_SECONDS + ' seconds')}
          ${spec('Size', sg.size ? sg.size.replace(/ x /, ' × ') : null)}
        </div>
        ${tags.length ? `<div class="tags">${tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
        <p class="coords">${sg.lat.toFixed(5)}, ${sg.lng.toFixed(5)} · Sign ID ${esc(sg.id)}</p>
      </div>
    </div>${ctas(city ? city.name : sg.state)}`;
  }

  // Board illustration rebuilt from its Figma layers (BoardPreview, 598:3151) — shown when a sign has no photo.
  window.__boardPreview = () => boardPreview();
  function boardPreview() {
    const L = (file, inset, extra = '') => `<div style="position:absolute;inset:${inset};${extra}"><img src="${FIG}panel/${file}.svg" alt="" style="inset:0;width:100%;height:100%"></div>`;
    return `<div class="board-preview" aria-hidden="true">
      ${L('bp', '0')}
      ${L('v0', '0 0 50% 0')}
      ${L('v1', '66.67% 0 0 0')}
      ${L('v2', '68.33% 0 16.67% 0')}
      <div style="position:absolute;inset:81.67% 0 18.33% 0"><img src="${FIG}panel/v3.svg" alt="" style="left:0;right:0;top:-0.75px;height:1.5px;width:100%"></div>
      ${L('v4', '45.83% 94.06% 33.33% 2.48%', 'opacity:.6')}
      ${L('v5', '40% 91.09% 33.33% 6.44%', 'opacity:.6')}
      ${L('v6', '43.33% 29.21% 33.33% 67.82%', 'opacity:.6')}
      ${L('v7', '48.33% 25.74% 33.33% 71.78%', 'opacity:.6')}
      ${L('v8', '45.83% 52.48% 16.67% 46.53%')}
      ${L('v8', '45.83% 46.53% 16.67% 52.48%')}
      <div style="position:absolute;inset:15% 39.11% 50% 39.11%"><img src="${FIG}panel/v9.svg" alt="" style="inset:-1.79% -0.88%;width:auto;height:auto"></div>
      ${L('v10', '20% 51.98% 55% 40.59%')}
      ${L('v11', '21.67% 40.59% 71.67% 49.01%')}
      ${L('v12', '31.67% 42.57% 63.33% 49.01%')}
      ${L('v14', '39.17% 44.55% 57.5% 49.01%')}
    </div>`;
  }

  function onPanelClick(e) {
    const t = e.target.closest('button, a');
    if (!t) return;
    if (t.dataset.city) return openCity(t.dataset.city);
    if (t.dataset.sign) return openSign(t.dataset.sign, { fly: true });
    switch (t.dataset.act) {
      case 'close': return closePanel();
      case 'collapse': return $('#panel').classList.toggle('is-collapsed');
      case 'back': {
        const prev = panelStack[panelStack.length - 2];
        if (prev && prev.type === 'city') return openCity(prev.id);
        if (prev) return openState(prev.id);
        return closePanel();
      }
    }
  }

  function geomBbox(g) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    const walk = c => typeof c[0] === 'number' ? (b[0] = Math.min(b[0], c[0]), b[1] = Math.min(b[1], c[1]), b[2] = Math.max(b[2], c[0]), b[3] = Math.max(b[3], c[1])) : c.forEach(walk);
    walk(g.coordinates);
    return b;
  }

  // ---------------------------------------------------------------- full screen
  const isFullscreen = () => $('.map-card').classList.contains('is-fullscreen');

  function setFullscreen(on) {
    const card = $('.map-card');
    const btn = $('#fullscreen');
    card.classList.toggle('is-fullscreen', on);
    document.body.classList.toggle('map-fullscreen', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen map');
    btn.title = on ? 'Exit full screen (Esc)' : 'Full screen map';
    if (!on) card.scrollIntoView({ block: 'nearest' });
    if (!map) return;
    // Keep the same spot centred as the frame grows or shrinks; the overview refits itself via its ResizeObserver.
    const center = map.getCenter();
    requestAnimationFrame(() => { map.resize(); if (view === 'detail') map.jumpTo({ center }); });
  }

  // ---------------------------------------------------------------- search
  // Type-ahead modelled on the devblip radial POC: states and cities only, prefix match from 2 characters,
  // states first, then cities by sign count. Built from the loaded inventory, so it needs no extra API.
  const SEARCH_MIN = 2;
  const SEARCH_MAX = 8;
  const plural = n => `${fmt(n)} sign${n === 1 ? '' : 's'}`;

  function searchItems(q) {
    q = q.trim().toLowerCase().replace(/\s+/g, ' ');
    if (q.length < SEARCH_MIN || !idx) return [];
    const hit = (...names) => names.some(n => n.toLowerCase().startsWith(q));
    const states = [...idx.states.values()].filter(s => hit(s.name, s.abbr))
      .map(s => ({ kind: 'state', id: s.name, label: s.name, meta: `State / ${plural(s.count)}`, count: s.count }));
    const cities = [...idx.cities.values()].filter(c => hit(c.name, `${c.name}, ${c.abbr}`))
      .map(c => ({ kind: 'city', id: c.key, label: `${c.name}, ${c.abbr}`, meta: `City / ${plural(c.count)}`, count: c.count }));
    const byCount = (x, y) => y.count - x.count;
    return [...states.sort(byCount), ...cities.sort(byCount)].slice(0, SEARCH_MAX);
  }

  function wireSearch() {
    const input = $('#search-input');
    const list = $('#search-suggest');
    const msg = $('#search-msg');
    const clear = $('#search-clear');
    let items = [];
    let active = -1;

    const draw = () => {
      list.hidden = !items.length;
      input.setAttribute('aria-expanded', String(!!items.length));
      list.innerHTML = items.map((it, i) => `<li role="option" id="sg-${i}" aria-selected="${i === active}" data-i="${i}"><strong>${esc(it.label)}</strong><span>${it.meta}</span></li>`).join('');
      input.setAttribute('aria-activedescendant', active >= 0 ? 'sg-' + active : '');
      // Keep the highlighted row visible by scrolling the list only, never the page.
      const sel = list.querySelector('[aria-selected="true"]');
      if (sel) {
        if (sel.offsetTop < list.scrollTop) list.scrollTop = sel.offsetTop - 7;
        else if (sel.offsetTop + sel.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = sel.offsetTop + sel.offsetHeight - list.clientHeight + 7;
      }
    };
    const update = () => {
      items = searchItems(input.value);
      active = items.length ? 0 : -1;
      clear.hidden = !input.value;
      msg.textContent = '';
      list.scrollTop = 0;
      draw();
    };
    const choose = it => {
      if (!it) return;
      input.value = it.label;
      clear.hidden = false;
      items = []; draw();
      msg.textContent = '';
      $('.map-frame').scrollIntoView({ behavior: 'smooth', block: 'center' });
      it.kind === 'state' ? openState(it.id) : openCity(it.id);
    };

    input.addEventListener('input', update);
    input.addEventListener('focus', () => { if (input.value) update(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' && items.length) { active = (active + 1) % items.length; draw(); e.preventDefault(); }
      else if (e.key === 'ArrowUp' && items.length) { active = (active - 1 + items.length) % items.length; draw(); e.preventDefault(); }
      else if (e.key === 'Escape') { items = []; draw(); }
    });
    input.addEventListener('blur', () => setTimeout(() => { items = []; draw(); }, 150));
    list.addEventListener('mousedown', e => { const li = e.target.closest('li'); if (li) { e.preventDefault(); choose(items[+li.dataset.i]); } });
    list.addEventListener('mousemove', e => { const li = e.target.closest('li'); if (li && +li.dataset.i !== active) { active = +li.dataset.i; draw(); } });
    clear.addEventListener('click', () => { input.value = ''; update(); input.focus(); });
    $('#search-form').addEventListener('submit', e => {
      e.preventDefault();
      if (!idx || !map) return;
      const pick = items[active] || searchItems(input.value)[0];
      if (pick) choose(pick);
      else if (input.value.trim()) msg.textContent = `No states or cities match “${input.value.trim()}”. Try a state or a nearby city.`;
    });
  }

  // ---------------------------------------------------------------- page sections
  function renderTopMarkets() {
    $('#top-markets').innerHTML = idx.topCities(12).map(c =>
      `<button type="button" class="mkt" data-city="${esc(c.key)}"><span class="mkt__name">${esc(c.name)}, ${c.abbr}</span>${countBlock(c.count)}</button>`).join('');
  }

  // Figma shows 10 states on desktop (2 rows of 5) and 18 on mobile (9 rows of 2) before "Load All".
  const statesShown = () => isMobile() ? 18 : 10;
  function renderStateGrid() {
    $('#state-grid').innerHTML = idx.statesByCount().map((s, i) =>
      `<button type="button" class="mkt" data-state="${esc(s.name)}" ${i >= statesShown() ? 'hidden' : ''}><span class="mkt__name">${esc(s.name)}</span>${countBlock(s.count)}</button>`).join('');
  }

  function goToMap(fn) {
    if (!map) return;
    $('#map-section').scrollIntoView({ behavior: 'smooth' });
    fn();
  }

  // Copy and images from the Steps component (Figma 755:22537).
  const HOW = FIG + 'how/';
  const STEPS = [
    { title: 'Choose your favorite location',
      copy: '<p>Pick where you want your ads to live (and shine!). Browse billboards for rent at one location or across multiple markets.</p>',
      media: `<img class="how__img how__img--contain" src="${HOW}step1-location.png" alt="Blip map with billboard locations and a sign detail card">` },
    { title: 'Set Your Budget and Schedule',
      copy: '<p>Spend what makes sense for your business and scale as you need. We offer flexible options for first-timers and big spenders, and everyone in between, so you can maximize every penny.</p>',
      media: `<div class="how__pair"><img class="how__shot how__shot--a" src="${HOW}step2-schedule.png" alt="Campaign schedule settings"><img class="how__shot how__shot--b" src="${HOW}step2-reach.png" alt="Estimated reach card"><img class="how__shot how__shot--c" src="${HOW}step2-budget.png" alt="Daily budget setting"></div>` },
    { title: 'Upload Your Design',
      copy: '<p>Create simple, easy-to-read artwork that stands out and grabs attention. No designer needed; simple works best on a billboard, and getting started takes just a few minutes.</p><p>Need help with your design? We have your back <a href="#">with our billboard design services</a>.</p>',
      media: `<img class="how__img how__img--cover" src="${HOW}step3-design.png" alt="Uploading a billboard design">` },
    { title: 'Submit and Go Live',
      copy: '<p>We review and approve all designs with our Sign Partners to ensure they’re ready for action. From there, they’re up and running immediately, so you can drive more customers.</p>',
      media: `<div class="how__crop"><img src="${HOW}step4-live.jpg" alt="A live Blip ad on a highway billboard"></div>` }
  ];
  const STEP_NAMES = ['One', 'Two', 'Three', 'Four'];
  let step = 0;
  function showStep(i) {
    step = (i + STEPS.length) % STEPS.length;
    const s = STEPS[step];
    $('#how-step').textContent = 'Step ' + STEP_NAMES[step];
    $('#how-title').textContent = s.title;
    $('#how-copy').innerHTML = s.copy;
    $('#how-media').innerHTML = s.media;
    $('#how-dots').innerHTML = STEPS.map((_, j) => `<button type="button" aria-label="Step ${j + 1}" ${j === step ? 'aria-current="true"' : ''} data-step="${j}"></button>`).join('');
  }

  const FAQ = [
    ['How much does a digital billboard cost?', 'Digital billboard rental pricing varies based on location, time of day, and demand. With Blip, you pay per display (called a “blip”), starting as low as $0.01 per 8-second ad play. You set your own daily budget and only pay when your ad runs. There are no contracts or minimum spends.'],
    ['How much does it cost to rent a digital billboard for a day?', 'There’s no fixed day rate. You set a daily budget — even a small one — and pay only for the plays your ad actually gets. Prices vary by location, time of day, and demand.'],
    ['How do I find digital billboard locations near me?', 'Search a state or city on the map above, or click any state. Zoom in to see every sign as a pin, then open a pin to see exactly where it is.'],
    ['Can I see which billboards are available near me before I commit?', 'Yes. Every pin on the map is a Blip sign. Browse markets and open sign details before you create an account or spend anything.'],
    ['What is local billboard advertising, and is it right for my business?', 'Local billboard advertising puts your message on screens along the roads your customers drive every day. It suits any business with a local audience, from restaurants and clinics to dealerships and real estate.'],
    ['Can I rent a billboard for just one day or one week?', 'Yes. Rent by the day, week, or month with no long-term contracts.'],
    ['How quickly can my ad go live?', 'Blip reviews designs in about 90 minutes, and final sign owner approval usually takes a few days. Most campaigns are live within a week.'],
    ['How Much Is Billboard Rental Cost Near Me?', 'Cost depends on the signs you pick and when your ad plays, starting as low as $0.01 per 8-second play. Search your city above to see the boards near you, then set a budget that fits.']
  ];
  function renderFaq() {
    $('#faq').innerHTML = FAQ.map(([q, a], i) => `<div class="faq__item">
      <button type="button" class="faq__q" aria-expanded="${i === 0}" aria-controls="faq-a${i}" data-faq="${i}"><span>${esc(q)}</span><img src="${FIG}${i === 0 ? 'imgIGamingXmark' : 'imgIMathPlus'}.svg" alt=""></button>
      <div class="faq__panel" id="faq-a${i}" ${i === 0 ? '' : 'hidden'}><div class="faq__rule"></div><div class="faq__a">${esc(a)}</div></div></div>`).join('');
  }

  // ---------------------------------------------------------------- UI wiring
  function wireStaticUI() {
    wireSearch();
    showStep(0);
    renderFaq();

    $('#panel').addEventListener('click', onPanelClick);
    $('#zoom-in').addEventListener('click', () => {
      if (!map) return;
      if (view === 'overview') return enterDetail([-104, 31, -84, 44], 6);
      map.zoomIn();
    });
    $('#zoom-out').addEventListener('click', () => {
      if (!map || view === 'overview') return;
      if (map.getZoom() - 1 <= overviewZoom()) return enterOverview();
      map.zoomOut();
    });
    $('#reset-view').addEventListener('click', () => map && resetView());
    $('#fullscreen').addEventListener('click', () => setFullscreen(!isFullscreen()));
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && isFullscreen() && !(e.target.closest && e.target.closest('#search-form'))) setFullscreen(false);
    });
    document.querySelectorAll('.mode-toggle button').forEach(b => b.addEventListener('click', () => { mode = b.dataset.mode; applyMode(); }));

    $('#top-markets').addEventListener('click', e => { const b = e.target.closest('[data-city]'); if (b) goToMap(() => openCity(b.dataset.city)); });
    $('#state-grid').addEventListener('click', e => { const b = e.target.closest('[data-state]'); if (b) goToMap(() => openState(b.dataset.state)); });
    $('#load-all').addEventListener('click', e => {
      const hidden = document.querySelectorAll('#state-grid [hidden]');
      if (hidden.length) { hidden.forEach(el => { el.hidden = false; }); e.target.textContent = 'Show less'; }
      else { document.querySelectorAll('#state-grid .mkt').forEach((el, i) => { el.hidden = i >= statesShown(); }); e.target.textContent = 'Load All >'; }
    });

    $('#how-prev').addEventListener('click', () => showStep(step - 1));
    $('#how-next').addEventListener('click', () => showStep(step + 1));
    $('#how-dots').addEventListener('click', e => { const b = e.target.closest('[data-step]'); if (b) showStep(+b.dataset.step); });

    $('#faq').addEventListener('click', e => {
      const b = e.target.closest('.faq__q');
      if (!b) return;
      const open = b.getAttribute('aria-expanded') !== 'true';
      b.setAttribute('aria-expanded', String(open));
      b.querySelector('img').src = FIG + (open ? 'imgIGamingXmark' : 'imgIMathPlus') + '.svg';
      document.getElementById(b.getAttribute('aria-controls')).hidden = !open;
    });

    const burger = $('#burger');
    burger.addEventListener('click', () => {
      const open = burger.getAttribute('aria-expanded') !== 'true';
      burger.setAttribute('aria-expanded', String(open));
      $('#drawer').hidden = !open;
    });

    const setPlaceholder = () => { $('#search-input').placeholder = isMobile() ? 'Search a state or city' : 'Search a state or city, like Texas or Miami'; };
    setPlaceholder();
    mqMobile.addEventListener('change', () => { setPlaceholder(); if (idx) renderStateGrid(); if (map) map.resize(); });
  }

  // ?state=Texas | ?city=Houston,TX | ?sign=<signId> | ?mode=pins — handy for review links.
  function handleDeepLink() {
    const p = new URLSearchParams(location.search);
    if (p.get('mode') === 'pins') { mode = 'pins'; applyMode(); }
    if (p.get('sign')) return openSign(p.get('sign'), { fly: true });
    if (p.get('city')) {
      const [name, abbr] = p.get('city').split(',').map(s => s.trim().toLowerCase());
      const c = [...idx.cities.values()].find(c => c.name.toLowerCase() === name && (!abbr || c.abbr.toLowerCase() === abbr));
      if (c) return openCity(c.key);
    }
    if (p.get('state')) openState(p.get('state'));
  }

  init();
})();
