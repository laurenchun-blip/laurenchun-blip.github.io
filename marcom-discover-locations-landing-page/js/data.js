// Data layer for Discover Locations.
// Two devblip feeds are merged:
//  - the MapLibre coverage feed decides which signs exist and where (~6,450, exact lat/lng);
//  - the radial POC's inventory summary adds address, daily views, size, facing/read and photo.
// The inventory currently holds only ~5,000 unique signs — its 6,455 rows repeat ~1,450 of them — so it
// can't be the base without dropping signs. If the coverage feed fails we fall back to the deduped
// inventory, then to a bundled snapshot so the page works offline.
// Network-level figures no feed carries (Blip delivered, advertisers, pricing) go through `Enrichment`,
// the seam for BlipBot.

(function () {
  const INVENTORY_URL = 'https://devblip.wpengine.com/wp-json/blip-mapbox-radial/v1/inventory/summary';
  const DETAIL_URL = 'https://devblip.wpengine.com/wp-json/blip-mapbox-radial/v1/inventory/detail?id=';
  const COVERAGE_URL = 'https://devblip.wpengine.com/wp-json/blip-maplibre/v1/coverage';
  const SNAPSHOT_URL = 'data/coverage-snapshot.json';
  const STATES_URL = 'data/us-states.geojson';

  const STATE_ABBR = {
    Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO',
    Connecticut: 'CT', Delaware: 'DE', 'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA',
    Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY',
    Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
    Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH',
    'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND',
    Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Puerto Rico': 'PR', 'Rhode Island': 'RI',
    'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT',
    Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY'
  };

  const ABBR_STATE = Object.fromEntries(Object.entries(STATE_ABBR).map(([name, abbr]) => [abbr, name]));
  const READ = { L: 'Left read', R: 'Right read', C: 'Center read' };

  // Network-wide figures the coverage feed can't derive. Kept from the Figma until BlipBot supplies them.
  const STATIC_STATS = { blipsDelivered: '2B+', marketsCovered: '170', advertisers: '45.5K', impressions: '28.79B', adsPlayed: '2B+' };

  async function fetchJSON(url, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // devblip doesn't send `Vary: Origin`, so a copy the browser cached for one site (say localhost) carries that
      // site's CORS header and gets rejected when the same browser opens the GitHub Pages copy. Always fetch fresh.
      const crossSite = new URL(url, location.href).origin !== location.origin;
      const res = await fetch(url, { signal: ctrl.signal, cache: crossSite ? 'no-store' : 'default' });
      if (!res.ok) throw new Error(res.status + ' ' + url);
      return await res.json();
    } finally { clearTimeout(t); }
  }

  function detailOf(p) {
    return {
      address: p.address || null,
      views: p.daily_views > 0 ? p.daily_views : null,
      size: p.size || null,
      facing: p.facing ? p.facing + ' facing' : null,
      read: READ[p.read] || null,
      photo: p.image || (p.photos && p.photos[0] && p.photos[0].url) || null,
      traffic: p.traffic_context || null
    };
  }

  // Inventory rows keyed by sign id. Repeated rows are collapsed; when copies disagree on views, keep the higher.
  function inventoryById(inv) {
    const byId = new Map();
    for (const f of inv.signs.features) {
      const p = f.properties;
      const prev = byId.get(p.id);
      if (!prev || (p.daily_views || 0) > (prev.p.daily_views || 0)) byId.set(p.id, { p, geometry: f.geometry });
    }
    return byId;
  }

  async function loadCoverage() {
    const params = new URLSearchParams(location.search);
    if (params.has('snapshot')) return { fc: await fetchJSON(SNAPSHOT_URL, 15000), source: 'snapshot' };

    const [cov, inv] = await Promise.allSettled([fetchJSON(COVERAGE_URL, 12000), fetchJSON(INVENTORY_URL, 20000)]);
    const details = inv.status === 'fulfilled' && inv.value && inv.value.signs ? inventoryById(inv.value) : null;
    if (inv.status === 'rejected') console.warn('[discover] inventory summary failed; signs will have positions only', inv.reason);

    let fc, source;
    if (cov.status === 'fulfilled' && cov.value && cov.value.features && cov.value.features.length) {
      fc = cov.value; source = 'live';
    } else if (details) {
      console.warn('[discover] coverage feed failed, using inventory as the base', cov.reason);
      fc = { type: 'FeatureCollection', features: [...details.values()].map(({ p, geometry }) => ({
        type: 'Feature', geometry, properties: { signId: p.id, displayName: p.name, city: p.city, state: ABBR_STATE[p.state] || p.state }
      })) };
      source = 'inventory';
    } else {
      fc = await fetchJSON(SNAPSHOT_URL, 15000); source = 'snapshot';
    }
    if (details) for (const f of fc.features) {
      const d = details.get(f.properties.signId);
      if (d) f.properties.detail = detailOf(d.p);
    }
    return { fc, source, enriched: !!details };
  }

  function extendBbox(b, lng, lat) {
    if (lng < b[0]) b[0] = lng; if (lat < b[1]) b[1] = lat;
    if (lng > b[2]) b[2] = lng; if (lat > b[3]) b[3] = lat;
  }

  // Daily-view rollups per state/city: total, how many boards report views, and the low/high board.
  const viewsAgg = () => ({ viewsSum: 0, viewsN: 0, viewsMin: Infinity, viewsMax: 0 });
  function addViews(o, v) {
    if (!v) return;
    o.viewsSum += v; o.viewsN++;
    if (v < o.viewsMin) o.viewsMin = v;
    if (v > o.viewsMax) o.viewsMax = v;
  }

  function buildIndex(fc) {
    const states = new Map();
    const cities = new Map();
    const signs = new Map();
    const usFeatures = [];

    for (const f of fc.features) {
      const p = f.properties || {};
      const [lng, lat] = f.geometry.coordinates;
      const abbr = STATE_ABBR[p.state];
      if (!abbr) continue; // e.g. one Ontario sign — no state polygon to roll it into
      const cityKey = p.city + '|' + p.state;
      const sign = { id: p.signId, name: p.displayName, city: p.city, state: p.state, abbr, lng, lat, cityKey, ...(p.detail || {}) };
      signs.set(sign.id, sign);
      usFeatures.push({ type: 'Feature', id: usFeatures.length, geometry: f.geometry, properties: { signId: sign.id, name: sign.name, city: sign.city, abbr } });

      let s = states.get(p.state);
      if (!s) { s = { name: p.state, abbr, count: 0, cityKeys: new Set(), bbox: [Infinity, Infinity, -Infinity, -Infinity], ...viewsAgg() }; states.set(p.state, s); }
      s.count++; s.cityKeys.add(cityKey); extendBbox(s.bbox, lng, lat); addViews(s, sign.views);

      let c = cities.get(cityKey);
      if (!c) { c = { key: cityKey, name: p.city, state: p.state, abbr, count: 0, signIds: [], bbox: [Infinity, Infinity, -Infinity, -Infinity], ...viewsAgg() }; cities.set(cityKey, c); }
      c.count++; c.signIds.push(sign.id); extendBbox(c.bbox, lng, lat); addViews(c, sign.views);
    }

    // Density tiers as terciles of covered states, so the legend stays meaningful as inventory grows.
    const counts = [...states.values()].map(s => s.count).sort((a, b) => a - b);
    const q = i => counts[Math.floor(counts.length * i)];
    const tiers = { mediumMin: q(1 / 3), highMin: q(2 / 3) };
    for (const s of states.values()) {
      s.tier = s.count >= tiers.highMin ? 'high' : s.count >= tiers.mediumMin ? 'medium' : 'low';
      s.cityCount = s.cityKeys.size;
    }

    const citiesByState = name => [...cities.values()].filter(c => c.state === name).sort((a, b) => b.count - a.count);
    const topCities = n => [...cities.values()].sort((a, b) => b.count - a.count).slice(0, n);
    const statesByCount = () => [...states.values()].sort((a, b) => b.count - a.count);

    return {
      states, cities, signs, tiers, citiesByState, topCities, statesByCount,
      signsGeoJSON: { type: 'FeatureCollection', features: usFeatures },
      totalSigns: signs.size,
      statesLive: states.size
    };
  }

  // Async extras the panels render once they arrive.
  //   state(name) / city(key) -> BlipBot seam for network figures (Blip delivered, advertisers, pricing); null today.
  //   sign(id) -> the location name and description from the radial POC's per-sign detail endpoint.
  const signDetailCache = new Map();
  const Enrichment = {
    async state() { return null; },
    async city() { return null; },
    async sign(id) {
      if (!signDetailCache.has(id)) {
        signDetailCache.set(id, fetchJSON(DETAIL_URL + encodeURIComponent(id), 8000)
          .then(r => {
            const p = r && r.feature && r.feature.properties;
            return p ? { title: p.displayName || null, description: p.description || null } : null;
          })
          .catch(() => null));
      }
      return signDetailCache.get(id);
    }
  };

  async function loadStates() { return fetchJSON(STATES_URL, 15000); }

  window.DiscoverData = { loadCoverage, loadStates, buildIndex, Enrichment, STATE_ABBR, STATIC_STATS };
})();
