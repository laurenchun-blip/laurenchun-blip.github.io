// Assistant interface: reply(message, ctx) -> { action?, compose(after) -> { parts }, openCsv? }.
// MOCKED: scripted, pattern-based intents. A model can plug in behind the same interface later.
// Pasted text is data, never instructions. The agent never states a number it did not compute.
import { searchListings, coverageByLocation, milesLabel, sortLabel, emptyAdv } from './domain.js';
import { PLACES, OWNERS, NEARBY_CATEGORIES } from './fixtures.js';
import { plural, shortMi } from './terms.js';

const WORD_NUM = { half: 0.5, one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10 };

export const CAPABILITY_REPLIES = ['Near a stadium', 'Go out to 2 miles', 'Sort by impressions', 'I have a list of addresses'];

function parseMiles(text) {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:-?\s*)(?:mi\b|mile|miles)/i);
  if (m) return parseFloat(m[1]);
  if (/half\s+(?:a\s+)?mile/i.test(text)) return 0.5;
  const w = text.match(/\b(one|two|three|four|five|ten)\s+miles?\b/i);
  if (w) return WORD_NUM[w[1].toLowerCase()];
  return null;
}

function parseSort(text) {
  if (!/\b(sort|order|first|rank|highest|most|closest|nearest)\b/i.test(text)) return null;
  if (/impression|most seen|highest|biggest|most\b/i.test(text)) return 'impressions';
  if (/distance|closest|nearest/i.test(text)) return 'distance';
  if (/owner/i.test(text)) return 'owner';
  return null;
}

// Sign attributes in plain words -> the same advanced filters the panel sets.
const DIRS = { 'north': 'N', 'northeast': 'NE', 'east': 'E', 'southeast': 'SE', 'south': 'S', 'southwest': 'SW', 'west': 'W', 'northwest': 'NW' };
function parseAdvanced(t, cur) {
  const out = {};
  const set = (k, vals) => { out[k] = [...new Set([...(cur[k] || []), ...vals])]; };
  if (/\broadside\b/.test(t)) set('environment', ['Roadside']);
  if (/place[- ]based|indoor|in-store|inside stores/.test(t)) set('environment', ['Place based']);
  const media = [];
  if (/\bbulletins?\b/.test(t)) media.push('Bulletin');
  if (/junior posters?/.test(t)) media.push('Junior poster');
  else if (/\bposters?\b/.test(t)) media.push('Poster');
  if (/retail screens?/.test(t)) media.push('Retail screen');
  if (media.length) set('media', media);
  const venue = [];
  if (/pharmac(y|ies)/.test(t)) venue.push('Pharmacy');
  if (/\bgyms?\b/.test(t)) venue.push('Gym');
  if (/salons?/.test(t)) venue.push('Salon');
  if (/gas stations?/.test(t)) venue.push('Gas station');
  if (/restaurants?|dining/.test(t)) venue.push('Casual dining');
  if (/doctor/.test(t)) venue.push("Doctor's office");
  if (/\bretail\b(?! screen)/.test(t) && !media.includes('Retail screen')) venue.push('Retail');
  if (venue.length) set('venue', venue);
  const facing = [...t.matchAll(/facing\s+(north|south|east|west|northeast|northwest|southeast|southwest)/g)].map((m) => DIRS[m[1]]);
  if (facing.length) set('facing', facing);
  if (/\blandscape\b/.test(t)) set('orientation', ['Landscape']);
  if (/\bportrait\b|vertical screens?/.test(t)) set('orientation', ['Portrait']);
  const acc = [];
  for (const c of ['alcohol', 'cannabis', 'political', 'gambling']) {
    if (new RegExp(`(accepts?|allows?|ok for|okay for|takes)\\s+(?:\\w+\\s+)?${c}|${c} (ads?|ok|allowed)|for (an? )?${c} (brand|client|ad)`).test(t)) acc.push(c[0].toUpperCase() + c.slice(1));
  }
  if (/\bbeer|liquor|wine\b/.test(t)) acc.push('Alcohol');
  if (acc.length) set('accepts', acc);
  const imp = t.match(/(?:over|at least|more than|above|min(?:imum)?)\s*([\d.]+)\s*(m|million|k|thousand)?\s*impressions/);
  if (imp) out.minImpressions = parseFloat(imp[1]) * (/^k|thousand/.test(imp[2] || '') ? 1e3 : 1e6);
  return Object.keys(out).length ? out : null;
}

function findOwners(text) {
  const t = text.toLowerCase();
  return OWNERS.filter((o) => t.includes(o.name.toLowerCase()) || t.includes(o.name.split(' ')[0].toLowerCase()));
}

function parseExclusions(text) {
  const m = text.match(/\b(?:exclude|excluding|nothing from|no|not|without|drop|remove|skip)\s+([a-z][a-z ]+)/i);
  if (!m) return [];
  return findOwners(m[1]);
}

function parseInclusions(text) {
  const m = text.match(/\b(?:include|bring back|add back|allow)\s+([a-z][a-z ]+)/i);
  if (!m) return [];
  return findOwners(m[1]);
}

// Gazetteer lookup by name or alias. Longest match wins; ambiguous single words return several.
export function findPlaces(text) {
  const t = text.toLowerCase();
  const hits = [];
  for (const p of PLACES) {
    const names = [p.name.toLowerCase(), ...(p.aliases || [])];
    const hit = names.find((n) => t.includes(n));
    if (hit) hits.push({ place: p, len: hit.length });
  }
  hits.sort((a, b) => b.len - a.len);
  // Drop places whose matched name is contained in a longer match (e.g. "Harbor Field" inside "Harbor Field North Gate").
  const out = [];
  for (const h of hits) if (!out.some((o) => o.place.name.toLowerCase().includes(h.place.name.toLowerCase()) && o.place !== h.place && !h.place.isMarket)) out.push(h);
  return out.map((h) => h.place);
}

export function searchGazetteer(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return PLACES.filter((p) => !p.isMarket && (p.name.toLowerCase().includes(q) || p.address.toLowerCase().includes(q)))
    .concat(PLACES.filter((p) => p.isMarket && p.name.toLowerCase().startsWith(q)))
    .slice(0, 6);
}

function looksLikeEmail(text) {
  return text.length > 70 && /(\bhi\b|\bhello\b|client|looking at|flight|budget|proposal|\$\d)/i.test(text);
}

// A named moment in the request ("Black Friday push") names the proposal better than the place does.
const OCCASION_RE = /\b(black friday|cyber monday|holiday season|back[- ]to[- ]school|grand opening|super bowl|memorial day|labor day|4th of july|fourth of july|valentine'?s day|mother'?s day|father'?s day|new year)\b/i;
const titleCase = (x) => x.replace(/\b\w/g, (ch) => ch.toUpperCase()).replace(/'S\b/g, "'s");
function occasionName(text) { const m = text.match(OCCASION_RE); return m ? titleCase(m[1].toLowerCase().replace(/-/g, ' ')) : null; }
export function campaignTitle(text, placeName) {
  const occ = occasionName(text || '');
  if (occ) return `${occ} campaign`;
  return placeName ? `${placeName.replace(/ Stadium$/, '')} campaign` : null;
}

// Estimated flight windows. A guess the rep can correct, never the client's dates.
// Each returns [start, end] for a given year; the next window that hasn't ended yet is used.
const D = (y, m, d) => new Date(Date.UTC(y, m, d));
const add = (dt, days) => new Date(dt.getTime() + days * 864e5);
function nthWeekday(y, m, weekday, n) { // n = 1..5, or -1 for the last
  if (n === -1) { let d = D(y, m + 1, 0); while (d.getUTCDay() !== weekday) d = add(d, -1); return d; }
  let d = D(y, m, 1); while (d.getUTCDay() !== weekday) d = add(d, 1); return add(d, 7 * (n - 1));
}
const WINDOWS = [
  [/black friday|cyber monday/i, (y) => { const bf = add(nthWeekday(y, 10, 4, 4), 1); return [add(bf, -11), add(bf, 3)]; }, 'two weeks before Black Friday through Cyber Monday'],
  [/holiday season|\bholidays?\b/i, (y) => [D(y, 10, 23), D(y, 11, 31)], 'late November through the end of December'],
  [/back[- ]to[- ]school/i, (y) => [D(y, 6, 20), D(y, 7, 31)], 'late July through August'],
  [/super bowl/i, (y) => { const sb = nthWeekday(y, 1, 0, 2); return [add(sb, -14), sb]; }, 'the two weeks before the Super Bowl'],
  [/memorial day/i, (y) => { const d = nthWeekday(y, 4, 1, -1); return [add(d, -14), d]; }, 'the two weeks before Memorial Day'],
  [/labor day/i, (y) => { const d = nthWeekday(y, 8, 1, 1); return [add(d, -14), d]; }, 'the two weeks before Labor Day'],
  [/4th of july|fourth of july/i, (y) => [D(y, 5, 20), D(y, 6, 4)], 'the two weeks before July 4th'],
  [/valentine/i, (y) => [D(y, 0, 31), D(y, 1, 14)], 'the two weeks before Valentine’s Day'],
  [/mother'?s day/i, (y) => { const d = nthWeekday(y, 4, 0, 2); return [add(d, -14), d]; }, 'the two weeks before Mother’s Day'],
  [/father'?s day/i, (y) => { const d = nthWeekday(y, 5, 0, 3); return [add(d, -14), d]; }, 'the two weeks before Father’s Day'],
  [/new year/i, (y) => [D(y, 11, 15), D(y + 1, 0, 1)], 'mid-December through New Year’s Day'],
  [/\bfall\b/i, (y) => [D(y, 7, 18), D(y, 8, 21)], 'the month before fall starts'],
  [/\bsummer\b/i, (y) => [D(y, 5, 1), D(y, 7, 31)], 'June through August'],
  [/\bspring\b/i, (y) => [D(y, 2, 20), D(y, 4, 31)], 'late March through May'],
  [/\bwinter\b/i, (y) => [D(y, 11, 1), D(y + 1, 1, 28)], 'December through February'],
];
export function estimateWindow(text) {
  const w = WINDOWS.find(([re]) => re.test(text));
  if (!w) return null;
  const now = new Date();
  const today = D(now.getFullYear(), now.getMonth(), now.getDate());
  let y = now.getFullYear();
  let [st, en] = w[1](y);
  if (en < today) [st, en] = w[1](++y);
  if (st < today) st = today;
  const iso = (d) => d.toISOString().slice(0, 10);
  return { start: iso(st), end: iso(en), why: w[2] };
}
const shortDate = (iso) => new Date(Date.parse(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function parseBrief(text) {
  const brief = {};
  const dates = text.match(/(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\s*(?:through|to|-|–|until)\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}/i);
  if (dates) brief.flight = { label: dates[0].replace(/\s+/g, ' '), certain: true };
  else if (OCCASION_RE.test(text)) brief.flight = { label: occasionName(text), certain: false, context: true };
  else if (/\b(fall|spring|summer|winter|holiday)\b/i.test(text)) brief.flight = { label: `Before ${text.match(/\b(fall|spring|summer|winter|holiday)\b/i)[1].toLowerCase()}`, certain: false, context: true };
  const budget = text.match(/\$\s?(\d+(?:\.\d+)?)\s*(k|m)?/i);
  if (budget) brief.budget = { label: `${/around|about|roughly|~/i.test(text) ? 'About ' : ''}$${budget[1]}${(budget[2] || '').toLowerCase()}`, certain: !/around|about|roughly|~/i.test(text) };
  else if (/not sure on budget|no budget|budget (?:is )?tbd/i.test(text)) brief.budget = { label: 'Budget unknown', certain: false };
  return brief;
}

// ---------- Proposal by chat: add or remove many at once ----------
// Same addToProposal / removeFromProposal actions as the row buttons, the bulk bar and the sign card.
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20 };
function proposalIntent(text, lower, ctx) {
  const { state, listings, selected = [] } = ctx;
  const results = searchListings(listings, { ...state, onlyNew: false });
  const inP = new Set(state.proposalIds);
  const nameOf = (ids) => ids.map((id) => listings.find((l) => l.id === id)?.name).filter(Boolean);

  if (/\b(show|open|what'?s in|see)\b.*\bproposal\b|^proposal\??$/.test(lower)) {
    return { openTray: true, compose: (after) => ({ parts: [{ type: 'agent', text: after.proposalIds.length ? `The proposal has ${plural(after.proposalIds.length, 'listing', 'listings')}. It is open at the top right.` : 'Nothing is in the proposal yet. Tick rows, lasso pins, or ask me to add them.' }] }) };
  }

  const inProposal = listings.filter((l) => inP.has(l.id));
  const removing = /\b(remove|take out|drop|clear|empty)\b/.test(lower)
    && (/\b(proposal|selected|these|those|them|all|everything)\b/.test(lower) || /\b[A-Z]{2}-\d{4}\b/.test(text) || inProposal.some((l) => lower.includes(l.name.toLowerCase())));
  const adding = /\b(add|put|include)\b/.test(lower) && !/\bas (a|an) (point|client)|\blocations?\b|\bstores?\b|\bcsv\b|addresses/.test(lower);
  if (!removing && !adding) return null;

  // Which listings the sentence is about
  let scope = null, label = '';
  const ids = text.match(/\b[A-Z]{2}-\d{4}\b/g);
  // When removing, names and IDs are looked up in the proposal itself (they may be outside the current results).
  const pool = removing ? inProposal.map((l) => ({ listing: l })) : results;
  const named = pool.filter((r) => lower.includes(r.listing.name.toLowerCase()));
  const top = lower.match(/\b(?:top|first|best)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty)\b/);
  const owners = findOwners(text);
  if (/\b(selected|ticked|checked|these|those)\b/.test(lower)) { scope = results.filter((r) => selected.includes(r.listing.id)); label = 'selected'; }
  else if (ids) { scope = pool.filter((r) => ids.includes(r.listing.id)); label = ''; }
  else if (named.length) { scope = named; label = ''; }
  else if (top) { const n = NUM_WORDS[top[1]] || parseInt(top[1], 10); scope = results.slice(0, n); label = `top ${n}`; }
  else if (/\bnew (ones|listings|signs)|\bthe new\b/.test(lower)) { scope = results.filter((r) => r.isNew); label = 'new'; }
  else if (owners.length && /\b(from|by|owned)\b/.test(lower)) { scope = results.filter((r) => owners.some((o) => o.id === r.listing.owner.id)); label = `from ${owners.map((o) => o.name).join(' and ')}`; }
  else if (/\bavailable\b/.test(lower) && adding) { scope = results.filter((r) => r.listing.status === 'available'); label = 'available'; }
  else if (/\b(all|every|everything|them)\b/.test(lower) || (removing && /\bproposal\b/.test(lower))) { scope = removing ? state.proposalIds.map((id) => ({ listing: listings.find((l) => l.id === id) })) : results; label = 'all'; }
  if (!scope) return null;

  if (removing) {
    const out = scope.map((r) => r.listing.id).filter((id) => inP.has(id));
    if (!out.length) return { compose: () => ({ parts: [{ type: 'agent', text: 'None of those are in the proposal, so nothing changed.' }] }) };
    return {
      action: { type: 'removeFromProposal', ids: out },
      compose: (after) => ({ parts: [
        { type: 'agent', text: `Removed ${plural(out.length, 'listing', 'listings')} from the proposal. ${plural(after.proposalIds.length, 'listing is', 'listings are')} left.` },
        { type: 'quick', replies: ['Undo', 'Show the proposal'] },
      ] }),
    };
  }

  if (!scope.length) {
    return { compose: () => ({ parts: [{ type: 'agent', text: label === 'selected' ? 'Nothing is selected yet. Tick rows in the list or draw a lasso on the map, then ask again.' : 'No listings in the current results match that, so nothing was added.' }] }) };
  }
  const toAdd = scope.map((r) => r.listing.id).filter((id) => !inP.has(id));
  const already = scope.length - toAdd.length;
  if (!toAdd.length) return { compose: () => ({ parts: [{ type: 'agent', text: `${scope.length === 1 ? 'That one is' : `All ${scope.length} are`} already in the proposal.` }] }) };
  return {
    action: { type: 'addToProposal', ids: toAdd },
    compose: (after) => {
      const names = nameOf(toAdd);
      const which = label === 'all' ? `all ${plural(scope.length, 'listing', 'listings')} in the current results`
        : label.startsWith('from ') ? `${plural(scope.length, 'listing', 'listings')} ${label}`
        : label ? `the ${label} ${scope.length === 1 ? 'listing' : 'listings'}`
        : names.length <= 3 ? names.join(', ') : plural(toAdd.length, 'listing', 'listings');
      return { parts: [
        { type: 'agent', text: `Added ${which} to the proposal${toAdd.length !== scope.length ? ` (${toAdd.length} new)` : ''}.${already ? ` ${already} ${already === 1 ? 'was' : 'were'} already in it.` : ''} The proposal now has ${plural(after.proposalIds.length, 'listing', 'listings')}.` },
        { type: 'quick', replies: ['Show the proposal', 'Undo'] },
      ] };
    },
  };
}

// ---------- Brief: dates and budget, from a pasted request or a plain message ----------
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// "March 3" -> ISO date, choosing the next time that date comes around.
function isoFromMonthDay(mon, day, after) {
  const m = MONTHS.indexOf(mon.slice(0, 3).toLowerCase());
  if (m < 0) return '';
  const now = new Date();
  let y = now.getFullYear();
  const mk = (yy) => new Date(Date.UTC(yy, m, +day));
  let d = mk(y);
  const floor = after ? Date.parse(after) : Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  if (d.getTime() < floor) d = mk(++y);
  return d.toISOString().slice(0, 10);
}
export function parseDates(text) {
  const r = text.match(/\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\.?\s+(\d{1,2})\s*(?:through|thru|to|until|-|–)\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\.?\s+(\d{1,2})/i);
  if (!r) return null;
  const start = isoFromMonthDay(r[1], r[2]);
  const end = isoFromMonthDay(r[3], r[4], start);
  return start && end ? { start, end } : null;
}
function parseBudgetValue(text) {
  const b = text.match(/\$\s?(\d+(?:\.\d+)?)\s*(k|m)?\b/i) || text.match(/\bbudget\b[^\d]{0,20}(\d+(?:\.\d+)?)\s*(k|m)?\b/i);
  if (!b) return null;
  return parseFloat(b[1]) * ({ k: 1e3, m: 1e6 }[(b[2] || '').toLowerCase()] || 1);
}
// A short message that only sets the brief: "flight is March 3 to June 20", "budget is $150k".
function briefIntent(text, lower) {
  if (looksLikeEmail(text)) return null;
  const dates = /\b(flight|dates?|run|running|from)\b/.test(lower) || /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(lower) ? parseDates(text) : null;
  const budget = /\bbudget\b/.test(lower) ? parseBudgetValue(text) : null;
  if (!dates && budget == null) return null;
  const rough = /around|about|roughly|~|ish\b/.test(lower);
  const update = { ...(dates || {}), ...(budget != null ? { budget: String(budget), budgetRough: rough } : {}) };
  const parts = [];
  if (dates) parts.push('flight dates are set');
  if (budget != null) parts.push(`the budget is ${rough ? 'about ' : ''}$${Number(budget).toLocaleString('en-US')}`);
  return {
    briefUpdate: update,
    compose: () => ({ parts: [
      { type: 'agent', text: `Got it, ${parts.join(' and ')}. They are in the brief at the top, and the proposal totals use them.` },
    ] }),
  };
}

// ---------- reply ----------
// ctx: { state, listings, view }
export function reply(message, ctx) {
  const text = message.trim();
  const lower = text.toLowerCase();
  const { state, listings } = ctx;
  const hasAnchors = state.anchors.length > 0;
  const hasStores = state.anchors.some((a) => a.role === 'client_location');

  // Injection or not, pasted text is treated as data. We read it for places and terms, nothing more.
  const injected = /ignore (?:all )?(?:previous|prior|above) instructions|disregard (?:the )?(?:rules|instructions)|system prompt/i.test(text);

  if (/^(undo|undo that|go back|revert)\b/i.test(lower)) return { undo: true };
  if (/^redo\b/i.test(lower)) return { redo: true };

  const prop = proposalIntent(text, lower, ctx);
  if (prop) return prop;
  const bi = briefIntent(text, lower);
  if (bi) return bi;

  if (/\b(csv|list of addresses|upload|spreadsheet of|addresses)\b/i.test(lower) && !looksLikeEmail(text)) {
    return {
      openCsv: true,
      compose: () => ({ parts: [{ type: 'agent', text: 'Upload a CSV and I will find each address on the map. I can tag them all for you.' }] }),
    };
  }

  // Nearby category ("near a stadium", "near an airport")
  const cat = NEARBY_CATEGORIES.find((c) => new RegExp(`near (?:a|an|the)? ?${c.label.slice(0, -1).toLowerCase()}`, 'i').test(lower));
  if (cat) {
    const places = PLACES.filter((p) => cat.match.includes(p.category));
    return {
      compose: () => ({
        parts: [
          { type: 'agent', text: `${places.length === 1 ? 'One' : places.length} ${cat.label.toLowerCase()} on the map. Which one?` },
          { type: 'quick', replies: places.map((p) => `Near ${p.name}`) },
        ],
      }),
    };
  }

  if (/my client'?s stores|around (?:my|the) (?:client'?s )?(?:stores|locations)/i.test(lower)) {
    return {
      compose: () => ({
        parts: [
          { type: 'agent', text: 'Add the stores from a CSV of addresses, or search one store at a time on the right.' },
          { type: 'quick', replies: ['I have a list of addresses'] },
        ],
      }),
    };
  }

  // Coverage intents
  if (hasStores && /(without coverage|no coverage|uncovered|the gaps|show (?:me )?(?:the )?gaps)/i.test(lower) && parseMiles(lower) == null) {
    return {
      view: { tab: 'locations', coverageFilter: 'none' },
      compose: (after) => {
        const gaps = coverageByLocation(listings, after).filter((c) => !c.covered);
        return { parts: [{ type: 'agent', text: gaps.length ? `Showing the ${plural(gaps.length, 'store', 'stores')} with no listing nearby. They are outlined in amber on the map.` : 'Every store has a listing nearby, so there are no gaps to show.' }] };
      },
    };
  }
  if (hasStores && /best (?:listing|board|one)/i.test(lower)) {
    return {
      view: { tab: 'locations', coverageFilter: 'all' },
      compose: (after) => {
        const cov = coverageByLocation(listings, after);
        const withBest = cov.filter((c) => c.best).length;
        return { parts: [
          { type: 'agent', text: `The Best listing column now shows the pick for each store: the most impressions inside its radius. ${withBest} of ${cov.length} stores have one.` },
          { type: 'quick', replies: ['Show only stores without coverage'] },
        ] };
      },
    };
  }

  // Build an action from radius, sort, filters.
  const actions = [];
  const m = parseMiles(lower);
  const gapScope = /\b(gap|gaps|uncovered|without coverage|no coverage)\b/i.test(lower);
  if (m != null) actions.push({ type: 'setRadius', miles: m, scope: gapScope && hasStores ? 'uncovered' : 'all' });
  const sortKey = parseSort(lower);
  if (sortKey) actions.push({ type: 'setSort', key: sortKey });
  const ex = parseExclusions(text).filter((o) => !state.excludeOwnerIds.includes(o.id));
  if (ex.length) actions.push({ type: 'setFilters', excludeOwnerIds: [...state.excludeOwnerIds, ...ex.map((o) => o.id)] });
  const inc = parseInclusions(text).filter((o) => state.excludeOwnerIds.includes(o.id));
  if (inc.length) actions.push({ type: 'setFilters', excludeOwnerIds: state.excludeOwnerIds.filter((id) => !inc.some((o) => o.id === id)) });
  if (/\b(available|open for|only what is open|not on hold)\b/i.test(lower)) actions.push({ type: 'setFilters', availableOnly: true });
  if (/only (?:the )?new/i.test(lower)) actions.push({ type: 'setFilters', onlyNew: true });
  if (/show (?:all|everything)|clear (?:the |all )?filters|remove (?:the |all )?filters/i.test(lower)) actions.push({ type: 'setFilters', onlyNew: false, availableOnly: false, excludeOwnerIds: [], adv: emptyAdv() });
  else {
    const adv = parseAdvanced(lower, state.adv || emptyAdv());
    if (adv) actions.push({ type: 'setFilters', adv });
  }

  const places = findPlaces(text);
  const isEmail = looksLikeEmail(text) || injected;

  // A pasted request: read places, dates, budget, exclusions as suggestions to confirm.
  if (isEmail) {
    const brief = parseBrief(text);
    const placeActions = places.slice(0, 4).map((p, i) => ({ type: 'addPlace', place: p, role: 'point_of_interest', replace: i === 0 && !hasStores }));
    const all = [...placeActions, ...actions];
    const unknownPlace = !places.length ? (text.match(/\b(?:for|near|at|in)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/) || [])[1] : null;
    const exact = parseDates(text);
    const est = !exact && brief.flight?.context ? estimateWindow(text) : null;
    const budgetVal = parseBudgetValue(text);
    return {
      brief: {
        flightRough: !exact && brief.flight ? brief.flight.label : '',
        start: exact?.start || est?.start, end: exact?.end || est?.end,
        estimated: !!est, estimateWhy: est?.why || '',
        budget: budgetVal != null ? String(budgetVal) : undefined,
        budgetRough: brief.budget ? !brief.budget.certain : false,
        budgetNote: brief.budget && budgetVal == null ? brief.budget.label : '',
      },
      action: all.length ? { type: 'batch', actions: all } : null,
      title: campaignTitle(text, places[0] ? (places[0].isMarket ? places.map((p) => p.name).slice(0, 3).join(', ') : places[0].name) : null),
      compose: (after) => {
        const parts = [];
        const crit = [];
        places.slice(0, 4).forEach((p) => crit.push({ label: p.name, certain: true }));
        if (brief.flight) crit.push(brief.flight.context ? { label: est ? `${shortDate(est.start)} – ${shortDate(est.end)} · estimated` : `${brief.flight.label} · no dates`, certain: false } : brief.flight);
        if (brief.budget) crit.push(brief.budget);
        ex.forEach((o) => crit.push({ label: `Not ${o.name}`, certain: true }));
        if (!places.length) {
          parts.push({ type: 'agent', text: unknownPlace ? `I could not find ${unknownPlace} on the map. Try a street address or a nearby landmark, or search on the right.` : 'I read the request but did not find a place in it. Where should the listings be?' });
          if (crit.length) parts.push({ type: 'criteria', title: 'What I read', items: crit });
          if (injected) parts.push({ type: 'note', text: 'Part of that text asked for internal pricing. Floor prices stay internal and never go in a proposal or an export.' });
          parts.push({ type: 'quick', replies: ['Near a stadium', 'Near an airport', 'I have a list of addresses'] });
          return { parts };
        }
        const results = searchListings(listings, after);
        const first = places[0];
        const near = results.filter((r) => r.nearestAnchorId.includes(first.placeId));
        const closest = near.length ? Math.min(...near.map((r) => r.distanceMiles)) : null;
        if (places.length === 1) {
          parts.push({ type: 'agent', text: `I found ${first.name}${first.isMarket ? '' : ` in ${first.area}`} and put it on the map. ${plural(near.length, 'listing is', 'listings are')} within ${milesLabel(after.radiusMiles)}.` });
          parts.push({ type: 'result', title: `Near ${first.name}`, body: `${plural(near.length, 'listing', 'listings')} within ${milesLabel(after.radiusMiles)}.${closest != null ? ` Closest is ${shortMi(closest)} away.` : ''}` });
        } else {
          parts.push({ type: 'agent', text: `I put ${places.slice(0, 4).map((p) => p.name).join(', ')} on the map. ${plural(results.length, 'listing is', 'listings are')} within ${milesLabel(after.radiusMiles)} of them.` });
        }
        if (crit.length > places.length) parts.push({ type: 'criteria', title: 'What I read', items: crit });
        if (injected) parts.push({ type: 'note', text: 'Part of that text asked for internal pricing. Floor prices stay internal and never go in a proposal or an export.' });
        const missing = [!brief.flight && 'Dates', !brief.budget && 'budget'].filter(Boolean);
        parts.push({ type: 'agent', text: `${missing.length === 2 ? 'Dates and budget can wait. ' : brief.budget && !brief.budget.certain ? 'Dates and budget can wait. ' : ''}Want to widen this out or narrow it down?` });
        parts.push({ type: 'quick', replies: [`Go out to ${after.radiusMiles >= 2 ? after.radiusMiles + 1 : 2} miles`, 'Most impressions first', 'Only available listings'] });
        return { parts };
      },
    };
  }

  // A place request in a short message: "near Harbor Field", "check the north gate"
  if (places.length && !actions.length) {
    const q = (lower.match(/(?:near|around|at|check(?: the)?)\s+(.+)$/) || [])[1];
    if (places.length > 1 && q && !places.some((p) => p.name.toLowerCase() === q.trim())) {
      return {
        compose: () => ({ parts: [
          { type: 'agent', text: `A few places match "${q.trim()}". Which one?` },
          { type: 'quick', replies: places.slice(0, 4).map((p) => `Near ${p.name}`) },
        ] }),
      };
    }
    const p = places[0];
    return {
      action: { type: 'addPlace', place: p, role: 'point_of_interest' },
      title: !hasAnchors ? `${p.name.replace(/ Stadium$/, '')} campaign` : null,
      compose: (after) => {
        const results = searchListings(listings, after);
        const near = results.filter((r) => r.nearestAnchorId.includes(p.placeId));
        return { parts: [
          { type: 'agent', text: `Added ${p.name} as a point of interest. ${plural(near.length, 'listing is', 'listings are')} within ${milesLabel(after.radiusMiles)} of it${hasAnchors ? `, ${results.length} in total` : ''}.` },
          { type: 'quick', replies: ['Most impressions first', `Go out to ${after.radiusMiles + 1} miles`] },
        ] };
      },
    };
  }

  // "near Ridgemont": a place we cannot find
  const nearUnknown = lower.match(/\b(?:near|around)\s+([a-z][a-z .'-]+)$/);
  if (!actions.length && nearUnknown) {
    const amb = searchGazetteer(nearUnknown[1]);
    if (amb.length) {
      return { compose: () => ({ parts: [
        { type: 'agent', text: `A few places match "${nearUnknown[1]}". Which one?` },
        { type: 'quick', replies: amb.slice(0, 4).map((p) => `Near ${p.name}`) },
      ] }) };
    }
    return { compose: () => ({ parts: [
      { type: 'agent', text: `I could not find "${nearUnknown[1]}" on the map. Try a street address or a nearby landmark, or search on the right.` },
      { type: 'quick', replies: ['Near a stadium', 'Near an airport'] },
    ] }) };
  }

  if (actions.length) {
    if (!hasAnchors) {
      return { compose: () => ({ parts: [
        { type: 'agent', text: 'Pick a place first, then I can change the radius, sort, or narrow it down. Where should the listings be?' },
        { type: 'quick', replies: ['Near a stadium', 'Near an airport', 'I have a list of addresses'] },
      ] }) };
    }
    return {
      action: actions.length === 1 ? actions[0] : { type: 'batch', actions },
      whatChanged: true,
      compose: (after, before) => {
        const results = searchListings(listings, after);
        const parts = [];
        if (hasStores && actions.some((a) => a.type === 'setRadius' && a.scope === 'uncovered')) {
          const beforeGaps = coverageByLocation(listings, before).filter((c) => !c.covered).length;
          const afterGaps = coverageByLocation(listings, after).filter((c) => !c.covered).length;
          parts.push({ type: 'agent', text: `Done. I widened only the ${beforeGaps} gaps to ${milesLabel(m)}. ${beforeGaps - afterGaps} now have a listing nearby; ${plural(afterGaps, 'store still has', 'stores still have')} none.` });
          parts.push({ type: 'changed' });
          if (afterGaps) parts.push({ type: 'quick', replies: [`Expand to ${m + 1} miles for the gaps`, 'Show only stores without coverage'] });
          return { parts };
        }
        const newCount = after.newIds.filter((id) => results.some((r) => r.listing.id === id)).length;
        const bits = [];
        if (m != null) bits.push(`${plural(results.length, 'listing is', 'listings are')} within ${milesLabel(after.radiusMiles)}${state.anchors.length === 1 ? ` of ${state.anchors[0].place.name.replace(/ Stadium$/, '')}` : ''}`);
        else bits.push(`${plural(results.length, 'listing', 'listings')}`);
        if (sortKey) bits.push(`sorted by ${sortLabel(sortKey).toLowerCase()}`);
        let sentence = `Done. ${bits.join(', ')}.`;
        if (m != null && newCount) sentence += ` ${newCount} ${newCount === 1 ? 'is' : 'are'} new since the ${milesLabel(before.radiusMiles).replace('miles', 'mile')} view.`;
        if (ex.length) sentence += ` Nothing from ${ex.map((o) => o.name).join(' or ')}.`;
        if (!results.length) sentence = `Nothing matches that. No listings are left within ${milesLabel(after.radiusMiles)} with these filters.`;
        parts.push({ type: 'agent', text: sentence });
        parts.push({ type: 'changed' });
        if (!results.length) {
          parts.push({ type: 'quick', replies: ['Undo', `Go out to ${after.radiusMiles + 1} miles`] });
        } else if (sortKey === 'impressions' && results[0]) {
          const top = results.slice(0, 3).map((r) => r.listing.name);
          parts.push({ type: 'agent', text: `The top three are ${top.join(', ')}. Want me to check another place nearby?` });
          parts.push({ type: 'quick', replies: ['Add the top 5', 'Check the north gate', newCount ? 'Show only new ones' : 'Only available listings'] });
        }
        return { parts };
      },
    };
  }

  // Things it cannot do yet
  const cannot = /\b(send|email|book|buy|price|quote|floor|export|deck|discount)\b/i.test(lower);
  return {
    compose: () => ({ parts: [
      { type: 'agent', text: cannot
        ? 'I cannot do that here yet. I can find places, change the radius, sort, exclude an owner, add listings to the proposal, and check coverage for a list of stores.'
        : 'I did not catch that. I can find a place, change the radius, sort, exclude an owner, or add stores from a CSV.' },
      { type: 'quick', replies: hasAnchors ? ['Go out to 2 miles', 'Sort by impressions', 'Exclude Apex'] : CAPABILITY_REPLIES },
    ] }),
  };
}
