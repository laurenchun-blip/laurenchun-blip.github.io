// Pure domain functions. No DOM, no map library. Portable to an Angular service or a Django endpoint.
// The chat and the UI controls both call applyAction(); every change is undoable by the caller's history.

const EARTH_MILES = 3958.8;
const rad = (d) => (d * Math.PI) / 180;

export function haversineMiles(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.sqrt(h));
}

// Ring of [lng, lat] points, closed, for drawing a radius.
export function circleRing(center, milesR, steps = 96) {
  const out = [];
  const latR = milesR / 69.0;
  const lngR = milesR / (69.17 * Math.cos(rad(center.lat)));
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    out.push([center.lng + Math.sin(t) * lngR, center.lat + Math.cos(t) * latR]);
  }
  return out;
}

export const DEFAULT_RADIUS = 1;

export function initialState() {
  return {
    anchors: [],               // Location[]: { id, place, role: 'point_of_interest' | 'client_location', tags, name }
    radiusMiles: DEFAULT_RADIUS,
    prevRadiusMiles: null,     // shown as an inner ring after a widen
    radiusOverrides: {},       // { [locationId]: miles } for "expand only the gaps"
    sort: { key: 'distance', direction: 'asc' },
    excludeOwnerIds: [],
    availableOnly: false,
    adv: emptyAdv(),             // advanced filters: sign attributes
    onlyNew: false,
    proposalIds: [],
    newIds: [],
  };
}

// Advanced filters. Each list is "any of these"; an empty list means no filter on that field.
export const ADV_KEYS = ['environment', 'venue', 'media', 'size', 'orientation', 'facing', 'read', 'accepts'];
export function emptyAdv() {
  return { environment: [], venue: [], media: [], size: [], orientation: [], facing: [], read: [], accepts: [], minImpressions: null };
}
export function advCount(adv) {
  return ADV_KEYS.reduce((n, k) => n + (adv[k].length ? 1 : 0), 0) + (adv.minImpressions ? 1 : 0);
}
export function passesAdv(listing, adv) {
  if (!adv) return true;
  for (const k of ['environment', 'venue', 'media', 'size', 'orientation', 'facing', 'read']) {
    if (adv[k].length && !adv[k].includes(listing[k])) return false;
  }
  // "Accepts alcohol" keeps only signs that do not restrict alcohol.
  if (adv.accepts.length && adv.accepts.some((c) => (listing.restricts || []).includes(c))) return false;
  if (adv.minImpressions && !(listing.impressions >= adv.minImpressions)) return false;
  return true;
}

export function effectiveRadius(state, anchorId) {
  return state.radiusOverrides[anchorId] ?? state.radiusMiles;
}

function passesFilters(listing, state) {
  if (state.excludeOwnerIds.includes(listing.owner.id)) return false;
  if (state.availableOnly && listing.status !== 'available') return false;
  return passesAdv(listing, state.adv);
}

// Listings within the radius of any anchor, with the nearest anchor and distance.
export function searchListings(listings, state, { ignoreOnlyNew = false } = {}) {
  if (!state.anchors.length) return [];
  const newSet = new Set(state.newIds);
  const out = [];
  for (const listing of listings) {
    if (!passesFilters(listing, state)) continue;
    let best = null;
    for (const a of state.anchors) {
      const d = haversineMiles(listing.position, a.place.position);
      if (d <= effectiveRadius(state, a.id) && (!best || d < best.distanceMiles)) {
        best = { listing, distanceMiles: d, nearestAnchorId: a.id };
      }
    }
    if (best) {
      best.isNew = newSet.has(listing.id);
      out.push(best);
    }
  }
  const filtered = state.onlyNew && !ignoreOnlyNew ? out.filter((r) => r.isNew) : out;
  return sortResults(filtered, state.sort);
}

// Listings that pass the filters but sit outside the radius, up to maxMiles from the nearest place.
// The radius is a working tool, not a client rule, so the map shows what a wider pitch would add.
export function listingsOutside(listings, state, maxMiles) {
  if (!state.anchors.length) return [];
  const inside = new Set(searchListings(listings, { ...state, onlyNew: false }).map((r) => r.listing.id));
  const out = [];
  for (const listing of listings) {
    if (inside.has(listing.id) || !passesFilters(listing, state)) continue;
    let best = null;
    for (const a of state.anchors) {
      const dd = haversineMiles(listing.position, a.place.position);
      if (dd <= maxMiles && (!best || dd < best.distanceMiles)) best = { listing, distanceMiles: dd, nearestAnchorId: a.id, outside: true };
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => a.distanceMiles - b.distanceMiles);
}

export function sortResults(results, sort) {
  const dir = sort.direction === 'desc' ? -1 : 1;
  const byDistance = (a, b) => a.distanceMiles - b.distanceMiles;
  const cmp = {
    distance: (a, b) => dir * byDistance(a, b),
    impressions: (a, b) => {
      const ai = a.listing.impressions, bi = b.listing.impressions;
      if (ai == null && bi == null) return byDistance(a, b);
      if (ai == null) return 1;          // missing impressions always last
      if (bi == null) return -1;
      return dir * (ai - bi) || byDistance(a, b);
    },
    owner: (a, b) => dir * a.listing.owner.name.localeCompare(b.listing.owner.name) || byDistance(a, b),
    name: (a, b) => dir * a.listing.name.localeCompare(b.listing.name),
    status: (a, b) => dir * a.listing.status.localeCompare(b.listing.status) || byDistance(a, b),
  }[sort.key] || ((a, b) => {
    // Any other listing field: numbers compare as numbers, missing values last.
    const av = a.listing[sort.key], bv = b.listing[sort.key];
    if (av == null || (Array.isArray(av) && !av.length)) return 1;
    if (bv == null || (Array.isArray(bv) && !bv.length)) return -1;
    return dir * String(av).localeCompare(String(bv), undefined, { numeric: true }) || byDistance(a, b);
  });
  return [...results].sort(cmp);
}

// Coverage for each client location: listings inside its effective radius, and the best one.
// "Best" = most impressions inside the radius, nearest on a tie. (Open question: is that what "best" means?)
export function coverageByLocation(listings, state) {
  const locations = state.anchors.filter((a) => a.role === 'client_location');
  return locations.map((loc) => {
    const r = effectiveRadius(state, loc.id);
    let count = 0;
    let best = null;
    for (const listing of listings) {
      if (!passesFilters(listing, state)) continue;
      const d = haversineMiles(listing.position, loc.place.position);
      if (d > r) continue;
      count++;
      const imp = listing.impressions ?? 0;
      const bImp = best ? best.listing.impressions ?? 0 : -1;
      if (!best || imp > bImp || (imp === bImp && d < best.distanceMiles)) best = { listing, distanceMiles: d };
    }
    return { locationId: loc.id, location: loc, radiusMiles: r, listingCount: count, best, covered: count > 0 };
  });
}

// ---------- Actions ----------
// Each action is a plain object. applyAction is pure: (listings, state, action) -> nextState.

export function applyAction(listings, state, action) {
  const next = reduce(listings, state, action);
  if (next === state) return state;
  // Mark listings that appear because of this change as "new". Sorting alone keeps the previous marks.
  const before = new Set(searchListings(listings, state, { ignoreOnlyNew: true }).map((r) => r.listing.id));
  const afterIds = searchListings(listings, { ...next, onlyNew: false }, { ignoreOnlyNew: true }).map((r) => r.listing.id);
  const sameSet = afterIds.length === before.size && afterIds.every((id) => before.has(id));
  if (!sameSet) {
    next.newIds = before.size ? afterIds.filter((id) => !before.has(id)) : [];
  }
  return next;
}

function reduce(listings, state, action) {
  switch (action.type) {
    case 'batch':
      return action.actions.reduce((s, a) => reduce(listings, s, a), state);

    case 'setRadius': {
      const { miles: m, scope = 'all' } = action;
      if (scope === 'all') {
        if (m === state.radiusMiles && !Object.keys(state.radiusOverrides).length) return state;
        return { ...state, radiusMiles: m, prevRadiusMiles: m > state.radiusMiles ? state.radiusMiles : null, radiusOverrides: {} };
      }
      if (scope === 'uncovered') {
        const gaps = coverageByLocation(listings, state).filter((c) => !c.covered);
        if (!gaps.length) return state;
        const overrides = { ...state.radiusOverrides };
        gaps.forEach((g) => (overrides[g.locationId] = m));
        return { ...state, radiusOverrides: overrides };
      }
      // scope is one location id
      return { ...state, radiusOverrides: { ...state.radiusOverrides, [scope]: m } };
    }

    case 'setSort': {
      const direction = action.direction || (action.key === 'impressions' ? 'desc' : 'asc');
      if (state.sort.key === action.key && state.sort.direction === direction) return state;
      return { ...state, sort: { key: action.key, direction } };
    }

    case 'setFilters': {
      const next = { ...state };
      if (action.excludeOwnerIds) next.excludeOwnerIds = action.excludeOwnerIds;
      if (action.availableOnly != null) next.availableOnly = action.availableOnly;
      if (action.onlyNew != null) next.onlyNew = action.onlyNew;
      if (action.adv) next.adv = { ...(state.adv || emptyAdv()), ...action.adv };
      return next;
    }

    case 'addPlace': {
      if (state.anchors.some((a) => a.place.placeId === action.place.placeId && a.role === action.role)) return state;
      const loc = { id: `loc-${action.place.placeId}-${action.role}`, place: action.place, role: action.role, tags: action.tags || [], name: action.place.name };
      const anchors = action.replace ? [loc] : [...state.anchors, loc];
      return { ...state, anchors };
    }

    case 'addLocations': {
      const existing = new Set(state.anchors.map((a) => a.id));
      const added = action.locations.filter((l) => !existing.has(l.id));
      return { ...state, anchors: [...state.anchors, ...added] };
    }

    case 'removeLocation': {
      const overrides = { ...state.radiusOverrides };
      delete overrides[action.id];
      return { ...state, anchors: state.anchors.filter((a) => a.id !== action.id), radiusOverrides: overrides };
    }

    case 'addToProposal': {
      const known = new Set(listings.map((l) => l.id));
      const ids = action.ids.filter((id) => known.has(id) && !state.proposalIds.includes(id)); // unknown IDs rejected
      if (!ids.length) return state;
      return { ...state, proposalIds: [...state.proposalIds, ...ids] };
    }

    case 'removeFromProposal':
      return { ...state, proposalIds: state.proposalIds.filter((id) => !action.ids.includes(id)) };

    case 'reset':
      // A new request clears places and filters but keeps listings already added to the proposal.
      return { ...initialState(), proposalIds: action.keepProposal ? state.proposalIds : [] };

    default:
      return state;
  }
}

// ---------- Describing a change (for "What changed" cards) ----------

export function describeChange(listings, before, after, ownersById) {
  const chips = [];
  if (after.radiusMiles !== before.radiusMiles) chips.push({ key: 'radius', label: `Within ${milesLabel(after.radiusMiles)}` });
  const newOverrides = Object.keys(after.radiusOverrides).filter((k) => after.radiusOverrides[k] !== before.radiusOverrides[k]);
  if (newOverrides.length) {
    const m = after.radiusOverrides[newOverrides[0]];
    chips.push({ key: 'overrides', label: newOverrides.length === 1 ? `${milesLabel(m)} for 1 ${'location'}` : `${milesLabel(m)} for ${newOverrides.length} gaps` });
  }
  if (after.sort.key !== before.sort.key || after.sort.direction !== before.sort.direction) chips.push({ key: 'sort', label: `Sort: ${sortLabel(after.sort.key)}` });
  const addedEx = after.excludeOwnerIds.filter((id) => !before.excludeOwnerIds.includes(id));
  addedEx.forEach((id) => chips.push({ key: `exclude:${id}`, label: `Not ${ownersById[id]?.name || id}` }));
  const removedEx = before.excludeOwnerIds.filter((id) => !after.excludeOwnerIds.includes(id));
  removedEx.forEach((id) => chips.push({ key: `include:${id}`, label: `Including ${ownersById[id]?.name || id}` }));
  if (after.availableOnly !== before.availableOnly) chips.push({ key: 'availableOnly', label: after.availableOnly ? 'Available only' : 'Any status' });
  const ba = before.adv || emptyAdv(), aa = after.adv || emptyAdv();
  for (const k of ADV_KEYS) {
    if (JSON.stringify(ba[k]) !== JSON.stringify(aa[k])) chips.push({ key: `adv:${k}`, label: aa[k].length ? advChipLabel(k, aa[k]) : `Any ${ADV_LABELS[k].toLowerCase()}` });
  }
  if (ba.minImpressions !== aa.minImpressions) chips.push({ key: 'adv:minImpressions', label: aa.minImpressions ? advChipLabel('minImpressions', aa.minImpressions) : 'Any impressions' });
  if (after.onlyNew !== before.onlyNew) chips.push({ key: 'onlyNew', label: after.onlyNew ? 'Only new' : 'All listings' });

  const b = searchListings(listings, before).length;
  const a = searchListings(listings, after).length;
  const delta = a - b;
  const details = [];
  if (after.radiusMiles !== before.radiusMiles) details.push(`Radius ${shortMiles(before.radiusMiles)} to ${shortMiles(after.radiusMiles)}`);
  const deltaText = delta === 0 ? 'same listings' : `${delta > 0 ? '+' : ''}${delta} listings`;
  return { chips, before: b, after: a, delta, detail: `${details.length ? details.join(', ') + ' ' : ''}(${deltaText}). Same data as the controls on the right.` };
}

export const ADV_LABELS = { environment: 'Environment', venue: 'Venue', media: 'Media type', size: 'Size', orientation: 'Orientation', facing: 'Facing', read: 'Read', accepts: 'Accepts', minImpressions: 'Impressions' };
export function advChipLabel(k, v) {
  if (k === 'minImpressions') return `${(v / 1e6).toFixed(1)}M+ impressions`;
  if (k === 'facing') return `Facing ${v.join(', ')}`;
  if (k === 'read') return `${v.join(' or ')} read`;
  if (k === 'accepts') return `Accepts ${v.map((x) => x.toLowerCase()).join(', ')}`;
  return v.length > 2 ? `${v.slice(0, 2).join(', ')} +${v.length - 2}` : v.join(', ');
}

export function milesLabel(m) {
  const v = Math.round(m * 10) / 10;
  return `${v} ${v === 1 ? 'mile' : 'miles'}`;
}
function shortMiles(m) {
  return `${Math.round(m * 10) / 10} mi`;
}
export function sortLabel(key) {
  return { distance: 'Distance', impressions: 'Impressions', owner: 'Owner', name: 'Name', status: 'State', media: 'Media type', dims: 'Dimensions', px: 'Resolution', environment: 'Environment', venue: 'Venue', facing: 'Facing', read: 'Read', orientation: 'Orientation', market: 'Market', illuminatedHours: 'Lit hours', size: 'Size' }[key] || key;
}

// ---------- Proposal: quote, guardrails, export (pure) ----------
// Impressions on a listing are per 4 weeks. Totals come only from here, never from the chat.
export function flightWeeks(start, end) {
  const a = Date.parse(start), b = Date.parse(end);
  if (!a || !b || b <= a) return null;
  return Math.max(1, Math.ceil((b - a) / (7 * 864e5)));
}
export function parseMoney(v) {
  if (v == null || v === '') return null;
  const m = String(v).replace(/[, $]/g, '').match(/^(\d+(?:\.\d+)?)(k|m)?$/i);
  if (!m) return null;
  return parseFloat(m[1]) * ({ k: 1e3, m: 1e6 }[(m[2] || '').toLowerCase()] || 1);
}
export function calculatePlan(listings, ids, quote = {}) {
  const items = ids.map((id) => listings.find((l) => l.id === id)).filter(Boolean);
  const weeks = flightWeeks(quote.start, quote.end);
  const factor = (weeks || 4) / 4;
  let imp = 0, floorW = 0, impKnown = 0;
  const lines = items.map((l) => {
    const i = l.impressions == null ? null : l.impressions * factor;
    if (i != null) { imp += i; floorW += l.floorCpm * i; impKnown += i; }
    return { listing: l, impressions: i };
  });
  const floor = impKnown ? floorW / impKnown : 0;                 // internal
  const suggested = Math.round(floor * 1.35 * 4) / 4;              // internal starting point
  const cpm = quote.cpm != null && !Number.isNaN(quote.cpm) ? quote.cpm : suggested;
  lines.forEach((x) => (x.cost = x.impressions == null ? null : (x.impressions / 1000) * cpm));
  const total = (imp / 1000) * cpm;
  const budget = parseMoney(quote.budget);
  const flags = [];
  if (cpm < floor) flags.push({ level: 'review', key: 'below-floor' });
  else if (suggested && cpm < suggested * 0.8) flags.push({ level: 'warn', key: 'deep-discount' });
  if (budget && total > budget) flags.push({ level: 'info', key: 'over-budget', amount: total - budget });
  const missing = lines.filter((x) => x.impressions == null).length;
  if (missing) flags.push({ level: 'info', key: 'missing-impressions', count: missing });
  if (!weeks) flags.push({ level: 'info', key: 'no-dates' });
  return { lines, weeks, weeksAssumed: !weeks, impressions: imp, floor, suggested, cpm, total, budget, flags };
}

// Export allow-list: only these fields ever reach a file. Floor CPM, capacity, utilization and notes are never read here.
export const EXPORT_COLUMNS = ['Listing ID', 'Listing', 'Market', 'Owner', 'Media type', 'Dimensions', 'Resolution', 'Flight', 'Impressions', 'CPM', 'Est. cost'];
export function exportRows(plan, flightText) {
  return plan.lines.map(({ listing: l, impressions: i, cost }) => ({
    'Listing ID': l.id, 'Listing': l.name, 'Market': l.market, 'Owner': l.owner.name, 'Media type': l.media,
    'Dimensions': l.dims, 'Resolution': l.px, 'Flight': flightText,
    'Impressions': i == null ? '' : Math.round(i), 'CPM': plan.cpm.toFixed(2), 'Est. cost': cost == null ? '' : cost.toFixed(2),
  }));
}
export function toCsv(rows) {
  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [EXPORT_COLUMNS.join(','), ...rows.map((r) => EXPORT_COLUMNS.map((k) => cell(r[k])).join(','))].join('\n');
}
