// Adkom discovery prototype, 11.4.26 frames. Plain ES modules, no build step.
// One action, two callers: chat replies and UI controls both go through dispatch() -> applyAction().
import { initialState, applyAction, searchListings, listingsOutside, haversineMiles, coverageByLocation, effectiveRadius, describeChange, milesLabel, sortLabel, emptyAdv, advCount, advChipLabel, ADV_KEYS, ADV_LABELS, calculatePlan, exportRows, toCsv, EXPORT_COLUMNS, parseMoney } from './domain.js';
import { LISTINGS, OWNERS, ownerById, ATTR, SIZE_HINT, PLACES, placeById, NEARBY_CATEGORIES, STORE_ROWS, sampleCsvText, SAMPLE_CSV_NAME, geocodeMany, RECENT_PROPOSALS, SAMPLE_REQUESTS } from './fixtures.js';
import { reply, searchGazetteer } from './assistant.js';
import { createMapPort } from './map.js';
import { icon } from './icons.js';
import { placeholderPhoto } from './photos.js';
import { TERMS, plural, shortMi, impressions } from './terms.js';

const ASSET = '../assets';
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- App state ----------
const app = {
  screen: 'home',
  proposal: { title: 'New proposal', client: null },
  history: [initialState()],
  idx: 0,
  messages: [],
  view: freshView(),
  dialog: null,
  csvSummary: null,
  homeDraft: '',
  chipColor: new URLSearchParams(location.search).get('chips') || 'neutral',
  sim: { inventoryError: false, slow: true, streets: new URLSearchParams(location.search).get('streets') !== '0' },
  lastFitKey: '',
  lastText: '',
  protoOpen: false,
  toasts: [],
};
function freshView() {
  return { mode: 'find', showOutside: true, selected: [], lastSel: null, tab: 'listings', coverageFilter: 'all', tagFilter: 'all', locSort: { key: 'coverage', dir: 'asc' }, selectedLocationId: null, showSearch: false, query: '', category: null, focusIdx: -1, addMenuFor: null, preview: null, popover: null, loading: false, error: false, hoverId: null };
}
const S = () => app.history[app.idx];
let msgSeq = 0;
let mapPort = null;

// ---------- Actions ----------
function dispatch(action, { source = 'control', label } = {}) {
  const before = S();
  const after = applyAction(LISTINGS, before, action);
  if (after === before) return null;
  app.history = app.history.slice(0, app.idx + 1);
  app.history.push(after);
  app.idx++;
  if (source === 'control' && label) pushMsg({ kind: 'event', text: label, historyIdx: app.idx });
  return { before, after };
}
function undo() {
  if (app.idx === 0) return false;
  app.idx--;
  app.view.selectedLocationId = S().anchors.some((a) => a.id === app.view.selectedLocationId) ? app.view.selectedLocationId : null;
  return true;
}
function redo() {
  if (app.idx >= app.history.length - 1) return false;
  app.idx++;
  return true;
}
function pushMsg(m) {
  app.messages.push({ id: ++msgSeq, ...m });
}

function controlAction(action, label) {
  const anchorsChange = ['addPlace', 'addLocations', 'removeLocation'].includes(action.type);
  if (app.sim.inventoryError && (anchorsChange || action.type === 'setRadius')) {
    app.view.error = true;
    renderWorkspace();
    return;
  }
  const r = dispatch(action, { source: 'control', label });
  if (!r) return;
  app.view.error = false;
  if (anchorsChange) simulateLoad();
  renderWorkspace();
}

function simulateLoad(ms = 650) {
  if (!app.sim.slow) return;
  app.view.loading = true;
  setTimeout(() => { app.view.loading = false; renderWorkspace(); }, ms);
}

// ---------- Chat ----------
function send(text, { instant = false } = {}) {
  text = text.trim();
  if (!text) return;
  app.lastText = text;
  pushMsg({ kind: 'user', text, turnStart: app.idx });
  if (instant) { handleReply(text); return; }
  pushMsg({ kind: 'typing' });
  renderWorkspace();
  setTimeout(() => {
    app.messages = app.messages.filter((m) => m.kind !== 'typing');
    handleReply(text);
    renderWorkspace();
  }, 520);
}

function handleReply(text) {
  const stepWord = text.trim().toLowerCase();
  if (/^(find|show|see)( me)? (the )?listings\b|^next$/.test(stepWord) && app.view.mode === 'brief') {
    if (!S().anchors.length) { pushMsg({ kind: 'agent', text: 'Add a place to the brief first, then I can find listings near it.' }); return; }
    pushMsg({ kind: 'agent', text: `Here are the ${TERMS.listings} near ${nearText()}. Add the ones you want, then review the ${TERMS.proposal}.` });
    setMode('find');
    return;
  }
  if (/^(review|build|show)( the)? proposal\b/.test(stepWord) && S().proposalIds.length && app.view.mode !== 'proposal') {
    pushMsg({ kind: 'agent', text: `Here is the ${TERMS.proposal}: ${plural(S().proposalIds.length, TERMS.listing, TERMS.listings)}, ${money(plan().total)} at ${money(plan().cpm, 2)} CPM. Ask me to change the dates, CPM or listings.` });
    setMode('proposal');
    return;
  }
  const r = reply(text, { state: S(), listings: LISTINGS, selected: app.view.selected });
  if (r.undo) {
    pushMsg({ kind: 'agent', text: undo() ? 'Undone. The map and the list are back to how they were.' : 'There is nothing to undo yet.' });
    return;
  }
  if (r.redo) {
    pushMsg({ kind: 'agent', text: redo() ? 'Redone.' : 'There is nothing to redo.' });
    return;
  }
  if (r.openCsv) openCsvDialog();
  if (r.openTray) setTimeout(() => { app.view.popover = 'tray'; renderPopover(); }, 30);
  if (r.brief) applyBrief(r.brief, { onlyEmpty: true });
  const briefNudge = app.view.mode === 'brief' && !app.briefNudged;
  if (r.briefUpdate) applyBrief(r.briefUpdate, { onlyEmpty: false });
  if (r.view) Object.assign(app.view, r.view);
  let before = S(), after = S();
  if (r.action) {
    const touchesInventory = JSON.stringify(r.action).match(/addPlace|addLocations|setRadius/);
    if (app.sim.inventoryError && touchesInventory) {
      pushMsg({ kind: 'agent', text: 'Listings could not load just now, so nothing changed. Try again in a moment.' });
      pushMsg({ kind: 'quick', replies: ['Try again'], retry: text });
      app.view.error = true;
      return;
    }
    const res = dispatch(r.action, { source: 'chat' });
    app.view.error = false;
    if (res) {
      ({ before, after } = res);
      if (/addPlace|addLocations/.test(JSON.stringify(r.action))) simulateLoad();
    }
  }
  if (r.action && /ToProposal/.test(r.action.type) && /selected|ticked|checked|these|those/i.test(text)) app.view.selected = [];
  if (r.title && app.proposal.title === 'New proposal') app.proposal.title = r.title;
  if (!r.compose) return;
  const { parts } = r.compose(after, before);
  if (briefNudge && S().anchors.length) {
    // In the brief step, the agent's reply ends with the way forward instead of jumping ahead.
    app.briefNudged = true;
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i].type === 'quick') parts.splice(i, 1);
    parts.push({ type: 'agent', text: app.brief.flightEstimated
      ? `The brief is on the right. The request gave no dates, so I estimated ${flightText()}${app.brief.estimateWhy ? ` (${app.brief.estimateWhy})` : ''}. Change them there or tell me the exact dates, then find listings.`
      : !app.quote.start ? 'The brief is on the right. There are no flight dates yet. Tell me the dates or add them there, then find listings.'
      : 'The brief is on the right. Change anything there or tell me here, then find listings.' });
    parts.push({ type: 'quick', replies: ['Find listings', 'Go out to 2 miles'] });
  }
  for (const p of parts) {
    if (p.type === 'agent') pushMsg({ kind: 'agent', text: p.text });
    else if (p.type === 'result') pushMsg({ kind: 'result', title: p.title, body: p.body });
    else if (p.type === 'criteria') pushMsg({ kind: 'criteria', title: p.title, items: p.items });
    else if (p.type === 'note') pushMsg({ kind: 'note', text: p.text });
    else if (p.type === 'quick') pushMsg({ kind: 'quick', replies: p.replies });
    else if (p.type === 'changed' && after !== before) {
      const d = describeChange(LISTINGS, before, after, ownerById);
      pushMsg({ kind: 'changed', chips: d.chips, detail: d.detail, historyIdx: app.idx });
    }
  }
}

function revertChip(key) {
  const s = S();
  if (key === 'radius') return controlAction({ type: 'setRadius', miles: 1 }, 'Radius back to 1 mile');
  if (key === 'overrides') return controlAction({ type: 'setRadius', miles: s.radiusMiles }, `Gaps back to ${milesLabel(s.radiusMiles)}`);
  if (key === 'sort') return controlAction({ type: 'setSort', key: 'distance' }, 'Sorted by distance');
  if (key.startsWith('exclude:')) {
    const id = key.split(':')[1];
    return controlAction({ type: 'setFilters', excludeOwnerIds: s.excludeOwnerIds.filter((x) => x !== id) }, `Including ${ownerById[id].name} again`);
  }
  if (key.startsWith('include:')) {
    const id = key.split(':')[1];
    return controlAction({ type: 'setFilters', excludeOwnerIds: [...s.excludeOwnerIds, id] }, `Excluded ${ownerById[id].name}`);
  }
  if (key === 'availableOnly') return controlAction({ type: 'setFilters', availableOnly: !s.availableOnly }, s.availableOnly ? 'Showing any status' : 'Available only');
  if (key.startsWith('adv:')) {
    const k = key.slice(4);
    return controlAction({ type: 'setFilters', adv: { [k]: k === 'minImpressions' ? null : [] } }, `${ADV_LABELS[k]} filter removed`);
  }
  if (key === 'owners') return controlAction({ type: 'setFilters', excludeOwnerIds: [] }, 'Including every owner');
  if (key === 'onlyNew') return controlAction({ type: 'setFilters', onlyNew: !s.onlyNew }, s.onlyNew ? 'Showing all listings' : 'Only new listings');
}

// ---------- Derived ----------
function hasStores() { return S().anchors.some((a) => a.role === 'client_location'); }
function pois() { return S().anchors.filter((a) => a.role === 'point_of_interest'); }
function stores() { return S().anchors.filter((a) => a.role === 'client_location'); }
function results() { return searchListings(LISTINGS, S()); }
function coverage() { return coverageByLocation(LISTINGS, S()); }
function anchorName(id) { return S().anchors.find((a) => a.id === id)?.place.name || ''; }
function mode() { return app.view.mode !== 'proposal' && hasStores() && app.view.tab !== 'listings' ? 'coverage' : 'listings'; }

function filteredCoverage() {
  const v = app.view;
  let cov = coverage();
  if (v.tagFilter !== 'all') cov = cov.filter((c) => c.location.tags.includes(v.tagFilter));
  if (v.coverageFilter === 'covered') cov = cov.filter((c) => c.covered);
  if (v.coverageFilter === 'none') cov = cov.filter((c) => !c.covered);
  const dir = v.locSort.dir === 'desc' ? -1 : 1;
  const by = {
    coverage: (a, b) => (a.covered - b.covered) || (b.listingCount - a.listingCount),
    name: (a, b) => dir * a.location.place.name.localeCompare(b.location.place.name),
    tag: (a, b) => dir * (a.location.tags.at(-1) || '').localeCompare(b.location.tags.at(-1) || ''),
    count: (a, b) => dir * (a.listingCount - b.listingCount),
    best: (a, b) => dir * ((a.best?.listing.impressions ?? -1) - (b.best?.listing.impressions ?? -1)),
  }[v.locSort.key];
  return [...cov].sort(v.locSort.key === 'coverage' ? (a, b) => dir * by(a, b) : by);
}
function allTags() {
  const t = new Set();
  stores().forEach((s) => s.tags.forEach((x) => t.add(x)));
  return [...t];
}

// ========== Render: shell ==========
const root = document.getElementById('app');

function render() {
  if (app.screen === 'home') renderHome();
  else if (app.screen === 'proposal') renderProposal();
  else renderWorkspace();
  renderDialog();
  renderProto();
  renderToasts();
}

// ---------- Home (Sidebar / Expanded) ----------
function renderHome() {
  mapPort = null;
  // Two zones: start something new (a centered composer with its ways in attached), then keep working (recent proposals).
  root.innerHTML = `
    <div class="app">
      ${navHtml()}
      <main class="content home">
        <div class="home-scroll">
          <section class="home-start" aria-labelledby="home-q">
            <h1 class="home-q" id="home-q">Where should we start?</h1>
            <div class="home-composer">
              <label class="sr-only" for="home-input">Request</label>
              <textarea id="home-input" rows="3" placeholder="Paste an email, describe what the client wants, or name a place...">${esc(app.homeDraft)}</textarea>
              <div class="row">
                <div class="left">
                  <button class="btn tertiary sm" data-act="home-attach">${icon('attach', 16)}Attach</button>
                  <button class="btn tertiary sm" data-act="home-csv">${icon('upload', 16)}Upload CSV</button>
                </div>
                <button class="send-btn" data-act="home-start" aria-label="Start proposal" title="Start proposal (Enter)" ${app.homeDraft.trim() ? '' : 'disabled'}>${icon('arrowRight', 18)}</button>
              </div>
              <input type="file" id="home-file" accept=".txt,.eml,.csv,text/plain,text/csv" hidden>
            </div>
            <div class="home-ways" role="group" aria-label="Or start from">
              ${startCard('home-email', 'fileText', 'Paste text', 'An email or notes')}
              ${startCard('home-search', 'mapPin', 'Search a place', 'Address or city')}
              ${startCard('home-csv', 'upload', 'Upload addresses', 'A CSV of stores')}
            </div>
          </section>
          <section class="home-continue" aria-labelledby="home-recent">
            <div class="home-continue-head"><h2 class="t-heading" id="home-recent">Pick up where you left off</h2><button class="btn tertiary sm" data-act="nav" data-to="Proposals">All proposals</button></div>
            <div class="recent" id="recent">
              ${RECENT_PROPOSALS.map((p) => `
                <div class="recent-row" data-act="open-recent" data-id="${p.id}" role="button" tabindex="0">
                  <span class="recent-ico">${icon('fileText', 16)}</span>
                  <div class="main"><div class="t-body-m">${esc(p.title)}</div><div class="sub">${esc(p.client)} · ${esc(p.when)}</div></div>
                  <span class="pill ${p.status.tone}">${esc(p.status.label)}</span>
                  <span class="link" style="font-size:14px">Open</span>
                </div>`).join('')}
            </div>
          </section>
        </div>
      </main>
    </div>`;
  const ta = $('#home-input');
  ta.addEventListener('input', () => {
    app.homeDraft = ta.value;
    $('[data-act="home-start"]').disabled = !ta.value.trim();
  });
  // Enter starts, Shift+Enter adds a line (like other chat composers).
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && ta.value.trim()) { e.preventDefault(); startFromText(ta.value); }
  });
  $('#home-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const text = await f.text();
    if (/\.csv$/i.test(f.name)) { resetWorkspace(); greet(); renderWorkspace(); openCsvDialog({ name: f.name, text }); return; }
    app.homeDraft = text.slice(0, 4000); renderHome();
  });
  ta.focus();
}
function startCard(act, ic, name, desc) {
  return `<button class="way" data-act="${act}"><span class="ico">${icon(ic, 16)}</span><span><span class="name">${name}</span><span class="desc">${desc}</span></span></button>`;
}
// ---------- Navigation (one list, two widths) ----------
// Every product section is listed; no "More" until we know who uses what and how often.
const NAV_MAIN = [
  ['home', 'Home'], ['fileText', 'Proposals', 12], ['users', 'Clients'], ['layers', 'Inventory'],
  ['clipboard', 'Spec sheet'], ['mapPin', 'Locations'], ['image', 'Photo library'], ['chart', 'Analytics'],
];
const NAV_FOOT = [['sliders', 'Settings'], ['help', 'Help']];
// null = the screen's default (expanded on Home, rail inside a proposal); a toggle sets it for every screen.
function navExpanded() {
  return app.navExpanded ?? (app.screen === 'home');
}
function navHtml() {
  const active = app.screen === 'home' ? 'Home' : 'Proposals';
  if (navExpanded()) {
    const item = ([ic, label, count]) => `<button class="nav-item ${label === active ? 'is-active' : ''}" data-act="nav" data-to="${label}" ${label === active ? 'aria-current="page"' : ''}>${icon(ic, 16)}${label}${count ? `<span class="count">${count}</span>` : ''}</button>`;
    return `
    <aside class="sidebar" id="nav" aria-label="Main">
      <div class="side-top"><span class="logo-solid" role="img" aria-label="Adkom"></span>
        <button class="icon-btn nav-toggle" data-act="nav-toggle" aria-label="Collapse navigation" title="Collapse">${icon('panelClose', 18)}</button></div>
      <div class="side-search">${icon('search', 16)}<span>Search</span><kbd>⌘K</kbd></div>
      ${NAV_MAIN.map(item).join('')}
      <div class="nav-divider"></div>
      ${NAV_FOOT.map(item).join('')}
      <div class="me"><span class="avatar">PR</span><div><div class="me-name">Pat Rivera</div><div class="me-role">Sales executive</div></div></div>
    </aside>`;
  }
  const item = ([ic, label]) => `<button class="rail-item ${label === active ? 'is-active' : ''}" data-act="nav" data-to="${label}" data-tip="${label}" aria-label="${label}" ${label === active ? 'aria-current="page"' : ''}>${icon(ic, 18)}</button>`;
  return `
    <nav class="rail" id="nav" aria-label="Main">
      <img class="mark" src="assets/figma/logo-mark.svg" alt="Adkom">
      <button class="rail-item" data-act="nav-toggle" data-tip="Expand" aria-label="Expand navigation">${icon('panelOpen', 18)}</button>
      <div class="rail-gap"></div>
      ${NAV_MAIN.map(item).join('')}
      <div class="rail-gap"></div>
      ${NAV_FOOT.map(item).join('')}
      <span class="avatar" title="Pat Rivera, sales executive">PR</span>
    </nav>`;
}
function renderNav() {
  const el = $('#nav');
  if (!el) return;
  el.outerHTML = navHtml();
  // The map needs to know its box changed width.
  setTimeout(() => mapPort?.resize(), 0);
}

// ---------- Workspace (Sidebar / Rail) ----------
function workspaceShell() {
  root.innerHTML = `
    <div class="app">
      ${navHtml()}
      <main class="content">
        <header class="page-header" id="ws-header"></header>
        <div class="body">
          <section class="panel panel-chat" aria-label="Chat" id="chat-panel">
            <button class="chat-rail" data-act="chat-toggle" aria-label="Open the chat" title="Open the chat">${icon('bulb', 16)}<span>Chat</span></button>
            <div class="panel-head"><span class="t-heading">Chat</span><div class="head-right"><button class="btn tertiary sm" data-act="new-request" title="Keeps the listings you added. Undo brings the rest back.">New request</button><button class="icon-btn sm" data-act="chat-toggle" aria-label="Collapse the chat" title="Collapse the chat">${icon('panelClose', 16)}</button></div></div>
            <div class="messages" id="messages" aria-live="polite"></div>
            <div class="composer-area">
              <div class="composer">
                <label class="sr-only" for="composer-input">Message</label>
                <textarea id="composer-input" rows="2" placeholder="Ask about the area, paste an email, or say what the client wants..."></textarea>
                <div class="row">
                  <div class="left">
                    <button class="btn tertiary sm" data-act="attach">${icon('attach', 16)}Attach</button>
                    <button class="btn tertiary sm" data-act="open-csv">${icon('upload', 16)}Upload CSV</button>
                  </div>
                  <button class="btn primary sm" data-act="send">Send</button>
                </div>
              </div>
              <input type="file" id="attach-file" accept=".txt,.eml,.csv,text/plain,text/csv" hidden>
            </div>
          </section>
          <div class="col-split" id="col-split" role="separator" aria-orientation="vertical" aria-controls="chat-panel" tabindex="0"
            aria-label="Resize the chat. Drag, or use the arrow keys. Double-click to reset." title="Drag to resize the chat · double-click to reset"></div>
          <section class="panel panel-listings" aria-label="${TERMS.Listings}">
            <div class="toolbar" id="toolbar">
              <div class="left">
                <div id="tb-tabs" style="display:contents"></div>
                <div class="search-field" id="search-wrap">
                  <div class="field">${icon('search', 16)}<input id="search-input" placeholder="Search a place, or paste addresses" autocomplete="off" aria-label="Search a place or address"></div>
                </div>
                <button class="btn neutral" data-act="open-csv" style="flex:none">Add locations</button>
                <span class="tb-sep" aria-hidden="true"></span>
                <div id="tb-chips" style="display:contents"></div>
              </div>
            </div>
            <div id="search-pop"></div>
            <div id="lp-top"></div>
            <div class="map-section" id="map-section"><div class="map-box" id="map-box"><div class="map-skeleton" id="map-skel" hidden></div><div class="radius-ctl" id="radius-ctl" hidden></div><div class="map-legend" id="map-legend" hidden></div><div class="sign-card" id="sign-card" hidden></div></div></div>
            <div class="splitter" id="splitter" role="separator" aria-orientation="horizontal" aria-controls="map-section" tabindex="0" aria-label="Resize the map. Drag, or use the arrow keys. Enter hides or shows the map." title="Drag to resize · double-click to reset">
              <span class="grip" aria-hidden="true"></span>
              <span class="split-label" id="split-label"></span>
            </div>
            <div id="lp-list" style="display:flex;flex-direction:column;flex:1;min-height:0"></div>
            <div id="adv-root"></div>
          </section>
          <aside class="panel panel-receipt" id="receipt" aria-label="Proposal summary" hidden></aside>
          <section class="panel panel-step" id="brief-panel" aria-label="Brief" hidden></section>
          <section class="panel panel-step" id="summary-panel" aria-label="${TERMS.Proposal} summary" hidden></section>
        </div>
      </main>
    </div>
    <div id="popover-root"></div>`;

  mapPort = createMapPort($('#map-box'), {
    onHoverListing: (id) => {
      document.querySelectorAll('tr.is-hover').forEach((r) => r.classList.remove('is-hover'));
      if (id) document.querySelector(`tr[data-listing="${CSS.escape(id)}"]`)?.classList.add('is-hover');
    },
    onSelectListing: (id) => openSignCard(id, { fly: false, scrollRow: true }),
    // Lasso: whatever is inside joins the list's checkbox selection, so the bulk bar handles it.
    onLasso: (ids) => {
      const v = app.view;
      if (!ids.length) { toast(`No ${TERMS.listings} inside that shape.`); return; }
      const before = new Set(v.selected);
      v.selected = [...new Set([...v.selected, ...ids])];
      const added = v.selected.length - before.size;
      if (hasStores() && v.tab !== 'listings') v.tab = 'listings';
      if ((v.mapMode || 'split') === 'full') setMapMode('split');
      renderWorkspace();
      toast(added ? `Selected ${plural(added, TERMS.listing, TERMS.listings)}. ${v.selected.length} selected in total.` : `Those ${TERMS.listings} were already selected.`);
    },
    onSelectLocation: (id) => selectLocation(id),
    streets: app.sim.streets,
  });
  app.lastFitKey = '';

  const input = $('#composer-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendComposer(); }
  });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; });

  const search = $('#search-input');
  search.addEventListener('focus', () => { app.view.showSearch = true; renderSearch(); });
  search.addEventListener('input', () => { app.view.query = search.value; app.view.category = null; app.view.focusIdx = search.value ? 0 : -1; app.view.addMenuFor = null; renderSearch(); });
  search.addEventListener('keydown', onSearchKey);
  // A single-line field drops line breaks, so keep a pasted list readable as "a; b; c".
  search.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') || '';
    const list = splitList(text);
    if (list.length < 2) return;
    e.preventDefault();
    search.value = list.join('; ');
    app.view.query = search.value; app.view.showSearch = true; app.view.addMenuFor = null;
    renderSearch();
  });

  $('#attach-file').addEventListener('change', onAttach);
}

function renderWorkspace() {
  if (app.screen !== 'workspace') return;
  if (!$('#messages')) workspaceShell();
  renderHeader();
  renderMessages();
  renderToolbar();
  renderTop();
  renderList();
  renderSearch();
  renderPopover();
  renderAdv();
  applyModeLayout();
  applyMapLayout();
  updateMap();
  renderSignCard();
  renderBriefPanel();
  renderSummaryPanel();
  renderDialog();
  renderProto();
}

// The brief lives in the header from the first message: filled by the chat, editable in place.
// Dashed = rough or not given yet. The proposal's receipt reads from it, so nothing is re-entered later.
app.brief = { flightRough: '', flightEstimated: false, estimateWhy: '', budgetRough: false, budgetNote: '' };
function applyBrief(b, { onlyEmpty }) {
  const q = app.quote;
  if (b.start && b.end && (!onlyEmpty || !q.start)) { q.start = b.start; q.end = b.end; app.brief.flightRough = b.estimated ? (b.flightRough || '') : ''; app.brief.flightEstimated = !!b.estimated; app.brief.estimateWhy = b.estimateWhy || ''; }
  else if (b.flightRough && !q.start) app.brief.flightRough = b.flightRough;
  if (b.budget != null && (!onlyEmpty || !q.budget)) { q.budget = b.budget; app.brief.budgetRough = !!b.budgetRough; app.brief.budgetNote = ''; }
  else if (b.budgetNote && !q.budget) app.brief.budgetNote = b.budgetNote;
  if (!app.email?.edited) app.email = null;
}
function briefChip(key, ic, label, value, state) {
  // state: 'set' | 'rough' | 'empty'
  return `<button class="brief-chip is-${state}" data-act="pop" data-pop="brief-${key}" aria-haspopup="dialog" aria-label="${label}: ${esc(value)}${state === 'rough' ? ', rough' : state === 'empty' ? ', not set' : ''}">
    ${icon(ic, 14)}<span class="bk">${label}</span><span class="bv">${esc(value)}</span></button>`;
}
function briefStrip() {
  const s = S();
  const q = app.quote, b = app.brief;
  const flight = q.start && q.end ? [flightText(), 'set'] : ['No dates yet', 'empty'];
  const budgetVal = parseMoney(q.budget);
  const budget = budgetVal ? [`${b.budgetRough ? 'About ' : ''}${money(budgetVal)}`, b.budgetRough ? 'rough' : 'set'] : b.budgetNote ? [b.budgetNote, 'rough'] : ['Add budget', 'empty'];
  const ex = s.excludeOwnerIds.map((id) => ownerById[id].name.split(' ')[0]);
  return `<div class="brief-strip" role="group" aria-label="Brief">
    ${briefChip('client', 'users', 'Client', app.proposal.client || 'Add client', app.proposal.client ? 'set' : 'empty')}
    ${s.anchors.length ? `<span class="brief-chip is-set is-static">${icon('mapPin', 14)}<span class="bk">Near</span><span class="bv">${esc(nearText())}</span></span>` : ''}
    ${briefChip('flight', 'calendar', 'Flight', flight[0], flight[1])}
    ${briefChip('budget', 'wallet', 'Budget', budget[0], budget[1])}
    <button class="brief-chip ${ex.length ? 'is-set' : 'is-empty'}" data-act="adv-open">${icon('ban', 14)}<span class="bk">Excludes</span><span class="bv">${ex.length ? esc(ex.join(', ')) : 'None'}</span></button>
  </div>`;
}
// The brief on the Listings step: the two numbers that steer the search, then "+N" for the rest.
// Client is already in the breadcrumb and Near is in the row under the toolbar, so they fold into +N.
function briefFacts() {
  const s = S();
  const q = app.quote, b = app.brief;
  const bv = parseMoney(q.budget);
  const ex = s.excludeOwnerIds.map((id) => ownerById[id].name);
  return {
    client: app.proposal.client ? { v: app.proposal.client } : null,
    near: s.anchors.length ? { v: nearText() } : null,
    flight: q.start && q.end ? { v: flightText(), rough: b.flightEstimated, est: b.flightEstimated } : { v: 'No dates yet', rough: true, missing: true },
    budget: bv ? { v: `${b.budgetRough ? 'About ' : ''}${compactMoney(bv)}`, rough: b.budgetRough } : b.budgetNote ? { v: 'No budget yet', rough: true } : null,
    excludes: ex.length ? { v: ex.join(', ') } : null,
  };
}
function briefSummaryChip() {
  const f = briefFacts();
  const shown = [f.flight, f.budget].filter(Boolean);
  const more = [f.client, f.near, f.excludes].filter(Boolean).length + (f.budget ? 0 : 1);
  const val = (x) => `<span class="bs-v ${x.rough ? 'is-rough' : ''}">${esc(x.v)}</span>${x.est ? '<span class="est-tag">Est.</span>' : ''}`;
  return `<button class="brief-sum" data-act="pop" data-pop="brief-all" aria-haspopup="dialog" aria-label="Brief: ${esc(shown.map((x) => x.v).join(', ') || 'not set')}${more ? `, plus ${more} more` : ''}">
    ${icon('fileText', 14)}<span class="bs-k">Brief</span>${shown.length ? shown.map(val).join('<span class="bs-dot">·</span>') : '<span class="bs-v is-rough">Add dates and budget</span>'}${more ? `<span class="bs-more">${more}+</span>` : ''}${icon('chevronDown', 14)}
  </button>`;
}
function briefAllPopover(r) {
  const f = briefFacts();
  const row = (key, ic, label, fact, act) => `<button class="ba-row" ${act}>${icon(ic, 16)}<span class="ba-k">${label}</span><span class="ba-v ${fact?.rough ? 'is-rough' : ''} ${fact && !fact.missing ? '' : 'is-empty'}">${esc(fact ? fact.v : 'None')}${fact?.est ? '<span class="est-tag">Est.</span>' : ''}</span>${icon('chevronDown', 14, 'ba-go')}</button>`;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - 336));
  return `<div class="menu brief-all" style="position:fixed;left:${left}px;top:${r.bottom + 6}px;width:320px" role="dialog" aria-label="Brief">
    <div class="menu-label">The brief</div>
    ${row('flight', 'calendar', 'Flight', f.flight, 'data-act="pop" data-pop="brief-flight"')}
    ${row('budget', 'wallet', 'Budget', f.budget, 'data-act="pop" data-pop="brief-budget"')}
    ${row('near', 'mapPin', 'Near', f.near, 'data-act="flow-go" data-step="brief"')}
    ${row('excludes', 'ban', 'Exclusions', f.excludes, 'data-act="adv-open"')}
    ${row('client', 'users', 'Client', f.client, 'data-act="pop" data-pop="brief-client"')}
    <div class="cols-foot"><span></span><button class="btn tertiary sm" data-act="flow-go" data-step="brief">Edit the brief</button></div>
  </div>`;
}

function compactMoney(n) { return n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : money(n); }
// Three steps in one workspace, chat on the left in all of them: 1 Brief → 2 Listings → 3 Proposal.
const STEPS = [['brief', 'Brief'], ['find', TERMS.Listings], ['proposal', TERMS.Proposal], ['review', 'Review'], ['send', 'Send']];
const STEP_GO = { brief: 'brief', find: 'find', proposal: 'review', review: 'export', send: 'email' };
function stepPrimary() {
  const s = S();
  const m = app.view.mode;
  if (m === 'brief') return `<button class="btn primary" data-act="ws-mode" data-mode="find" ${s.anchors.length ? '' : 'disabled title="Add a place to the brief first"'}>Find ${TERMS.listings} ${icon('arrowRight', 16)}</button>`;
  if (m === 'find') return `<button class="btn primary" data-act="ws-mode" data-mode="proposal" ${s.proposalIds.length ? '' : 'disabled title="Add listings from the list first"'}>Review ${TERMS.proposal} ${icon('arrowRight', 16)}</button>`;
  return `<button class="btn primary" data-act="flow-go" data-step="export">Continue to review ${icon('arrowRight', 16)}</button>`;
}
function currentStep() {
  if (app.screen === 'proposal') return app.pstep === 'email' ? 'send' : 'review';
  return app.view.mode;
}
function stepTabs() {
  const s = S();
  const m = currentStep();
  const idx = STEPS.findIndex(([k]) => k === m);
  const has = s.proposalIds.length > 0;
  const can = { brief: true, find: s.anchors.length > 0, proposal: has, review: has, send: has };
  return `<ol class="step-tabs" aria-label="Steps">${STEPS.map(([k, l], i) => `<li><button class="step-tab ${k === m ? 'is-current' : i < idx ? 'is-done' : ''}" data-act="flow-go" data-step="${STEP_GO[k]}" ${can[k] ? '' : 'disabled'} ${k === m ? 'aria-current="step"' : ''}>
    <span class="n">${i < idx ? icon('check', 12) : i + 1}</span>${l}${k === 'proposal' && s.proposalIds.length ? `<span class="cnt">${s.proposalIds.length}</span>` : ''}</button></li>`).join('<li class="sep" aria-hidden="true"></li>')}</ol>`;
}
function renderHeader() {
  const n = S().proposalIds.length;
  const pm = app.view.mode === 'proposal';
  const total = n ? plan().total : 0;
  $('#ws-header').innerHTML = `
    <div class="hdr-top">
      <div>
        <div class="crumbs"><button data-act="go-home">${TERMS.proposals}</button><span>›</span><span>${esc(app.proposal.client || 'New')}</span></div>
        <div class="title-row"><h1 class="t-title">${esc(app.proposal.title)}</h1></div>
      </div>
      <div class="actions">
        ${app.view.mode === 'find' ? `<button class="btn neutral tray-btn ${n ? 'has-items' : ''}" data-act="pop" data-pop="tray" aria-haspopup="dialog">${icon('fileText', 16)}${n ? `${plural(n, TERMS.listing, TERMS.listings)} · ${compactMoney(total)}` : `No ${TERMS.listings} yet`}${icon('chevronDown', 14)}</button>` : ''}
        <button class="btn neutral" data-act="save">Save</button>
        ${stepPrimary()}
      </div>
    </div>
    <div class="hdr-sub">
      ${stepTabs()}
      ${app.view.mode === 'find' ? briefSummaryChip() : ''}
    </div>`;
}

// ---------- Messages ----------
function renderMessages() {
  const box = $('#messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  // Copy and Retry sit under the last message of each agent reply. Retry only on the latest reply.
  const ms = app.messages;
  const lastUser = ms.map((m) => m.kind).lastIndexOf('user');
  const busy = ms.some((m) => m.kind === 'typing');
  box.innerHTML = ms.map((m, i) => {
    let html = renderMsg(m);
    const next = ms[i + 1];
    const endsTurn = m.kind !== 'user' && m.kind !== 'typing' && m.kind !== 'event' && m.kind !== 'divider' && (!next || next.kind === 'user' || next.kind === 'divider');
    if (endsTurn) {
      const u = ms.slice(0, i).map((x) => x.kind).lastIndexOf('user');
      const latest = u === lastUser && u >= 0 && !busy;
      html += `<div class="msg-actions"><button class="icon-btn sm" data-act="msg-copy" data-i="${i}" title="Copy reply" aria-label="Copy reply">${icon('copy', 14)}</button>${latest ? `<button class="icon-btn sm" data-act="msg-retry" title="Retry: undo what this reply changed and run it again" aria-label="Retry">${icon('retry', 14)}</button>` : ''}</div>`;
    }
    return html;
  }).join('');
  if (atBottom || true) box.scrollTop = box.scrollHeight;
}
function agentBlock(inner) {
  return `<div class="msg-agent"><span class="agent-avatar">${icon('bulb', 14)}</span><div><div class="who">Agent</div>${inner}</div></div>`;
}
function renderMsg(m) {
  switch (m.kind) {
    case 'user': return `<div class="msg-user ${m.text.length > 400 ? 'is-long' : ''}">${esc(m.text)}</div>`;
    case 'agent': return agentBlock(`<p class="txt">${esc(m.text)}</p>`);
    case 'typing': return agentBlock('<span class="typing" aria-label="Agent is working"><i></i><i></i><i></i></span>');
    case 'result': return `<div class="card" style="margin-top:-8px"><div class="card-title">${esc(m.title)}</div><div class="card-body">${esc(m.body)}</div></div>`;
    case 'summary': return `<div class="card" style="margin-top:-8px">${m.rows.map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('')}</div>`;
    case 'criteria': {
      const rough = m.items.some((c) => !c.certain);
      return `<div class="card" style="margin-top:-8px"><div class="card-title">${esc(m.title)}</div><div class="chips">${m.items.map((c) => `<span class="crit ${c.certain ? '' : 'uncertain'}">${esc(c.label)}</span>`).join('')}</div>${rough ? '<div class="card-body" style="font-size:12px;line-height:16px">Dashed means rough or not given yet. Add it in the chat any time.</div>' : ''}</div>`;
    }
    case 'note': return `<div class="note" style="margin-top:-8px">${icon('info', 14)}<span>${esc(m.text)}</span></div>`;
    case 'quick': return `<div class="quick-replies" style="margin-top:-6px">${m.replies.map((r) => `<button class="chip" data-act="quick" data-text="${esc(m.retry && r === 'Try again' ? m.retry : r)}">${esc(r)}</button>`).join('')}</div>`;
    case 'changed': {
      const undone = m.historyIdx > app.idx;
      const live = m.historyIdx === app.idx;
      return `<div class="card ${undone ? 'is-undone' : ''}" style="margin-top:-8px">
        <div class="card-title"><span>${undone ? 'Undone' : 'What changed'}</span>${live ? `<button class="btn tertiary sm" data-act="undo" style="margin:-4px -6px -4px 0">${icon('undo', 14)}Undo</button>` : ''}</div>
        <div class="chips">${m.chips.map((c) => `<span class="chip applied">${icon('check', 14)}${esc(c.label)}${live ? `<button class="x" data-act="revert" data-key="${esc(c.key)}" aria-label="Remove ${esc(c.label)}">${icon('x', 12)}</button>` : ''}</span>`).join('')}</div>
        <div class="card-body" style="font-size:12px;line-height:16px">${esc(m.detail)}</div>
      </div>`;
    }
    case 'divider': {
      const live = m.historyIdx === app.idx;
      return `<div class="event divider-ev"><span class="ev">${esc(m.text)}${live ? ` · <button class="link" data-act="undo">Undo</button>` : ''}</span></div>`;
    }
    case 'event': {
      const live = m.historyIdx === app.idx;
      const undone = m.historyIdx > app.idx;
      return `<div class="event"><span class="ev">${undone ? '<s>' : ''}${esc(m.text)}${undone ? '</s>' : ''}${live ? ` · <button class="link" data-act="undo">Undo</button>` : ''}</span></div>`;
    }
    default: return '';
  }
}
function sendComposer() {
  const input = $('#composer-input');
  const t = input.value;
  if (!t.trim()) return;
  input.value = '';
  input.style.height = 'auto';
  send(t);
}

// ---------- Toolbar ----------
function renderToolbar() {
  const s = S();
  const cov = hasStores();
  const v = app.view;
  if (v.mode === 'proposal') {
    $('#tb-tabs').innerHTML = `<span class="t-body-m tb-title">${icon('map', 16)}The map shows the ${plural(s.proposalIds.length, TERMS.listing, TERMS.listings)} in this ${TERMS.proposal}</span>`;
    $('#search-wrap').style.display = 'none';
    $('#tb-chips').innerHTML = '';
    return;
  }
  $('#tb-tabs').innerHTML = cov ? `
    <div class="tabs" role="tablist">
      ${[['locations', `${TERMS.Locations} (${stores().length})`], ['listings', `${TERMS.Listings} (${results().length})`], ['coverage', 'Coverage']].map(([k, l]) => `<button class="tab ${v.tab === k ? 'is-active' : ''}" role="tab" aria-selected="${v.tab === k}" data-act="tab" data-tab="${k}">${l}</button>`).join('')}
    </div>` : '';
  const showSearch = !cov || v.tab === 'listings';
  $('#search-wrap').style.display = showSearch ? '' : 'none';

  let chips = '';
  if (!cov || v.tab === 'listings') {
    if (s.anchors.length) {
      // Radius lives on the map slider (and in chat), so the toolbar keeps room for the search field.
      const sOn = s.sort.key !== 'distance';
      chips += `<button class="chip ${sOn ? 'is-on' : ''}" data-act="pop" data-pop="sort">${sOn ? icon('check', 14) : ''}<span class="sort-prefix">Sort: </span>${sortLabel(s.sort.key)}<span class="chip-dir" aria-label="${dirWord(s.sort.key, s.sort.direction)}">${icon(s.sort.direction === 'asc' ? 'arrowUp' : 'arrowDown', 14)}</span>${icon('chevronDown', 14)}</button>`;
      chips += advButton();
      if (s.onlyNew) chips += `<span class="chip applied">${icon('check', 14)}Only new<button class="x" data-act="revert" data-key="onlyNew" aria-label="Show all">${icon('x', 12)}</button></span>`;
    }
  } else if (v.tab === 'locations') {
    const tagOn = v.tagFilter !== 'all', covOn = v.coverageFilter !== 'all';
    chips += `<button class="chip ${tagOn ? 'is-on' : ''}" data-act="pop" data-pop="tag">${tagOn ? icon('check', 14) : ''}Tag: ${esc(tagOn ? v.tagFilter : 'All')}${icon('chevronDown', 14)}</button>`;
    chips += `<button class="chip ${covOn ? 'is-on' : ''}" data-act="pop" data-pop="coverage">${covOn ? icon('check', 14) : ''}Coverage: ${{ all: 'All', covered: 'Covered', none: 'No coverage' }[v.coverageFilter]}${icon('chevronDown', 14)}</button>`;
    chips += advButton();
  }
  $('#tb-chips').innerHTML = chips;
}

// ---------- Near row + stats ----------
function renderTop() {
  const s = S();
  const v = app.view;
  let html = '';
  if (hasStores() && v.tab !== 'listings') {
    const cov = coverage();
    const covered = cov.filter((c) => c.covered).length;
    const gaps = cov.length - covered;
    const overridden = Object.keys(s.radiusOverrides).length;
    const pct = cov.length ? Math.round((covered / cov.length) * 100) : 0;
    const skipped = app.csvSummary?.skipped || 0;
    html = `<div class="stats">
      <div class="stat"><div class="k">${TERMS.Locations} added</div><div class="v">${cov.length}</div><div class="s">${skipped ? `<button class="link stat-link" data-act="review-skipped">${skipped} need review</button>` : 'All addresses found'}</div></div>
      <div class="stat"><div class="k">Covered within<button class="var" data-act="pop" data-pop="radius" aria-label="Change the radius, now ${milesLabel(s.radiusMiles)}">${milesLabel(s.radiusMiles)}${icon('chevronDown', 12)}</button></div><div class="v">${covered}</div><div class="s good">${pct}% of ${TERMS.stores}${overridden ? `. ${overridden} widened past ${milesLabel(s.radiusMiles)}` : ''}</div></div>
      <button class="stat stat-btn ${v.coverageFilter === 'none' ? 'is-on' : ''}" data-act="${gaps ? 'toggle-gaps' : ''}" ${gaps ? '' : 'disabled'} title="${gaps ? 'Show only these in the table and on the map' : ''}">
        <div class="k">No coverage</div><div class="v">${gaps}</div>
        <div class="s ${gaps ? 'warn' : ''}">${gaps ? `<span class="gap-swatch" aria-hidden="true"></span>No listing within ${milesLabel(s.radiusMiles)} · ${v.coverageFilter === 'none' ? 'Show all' : 'Show them'}` : 'Every store has a listing nearby'}</div>
      </button>
    </div>`;
  }
  $('#lp-top').innerHTML = viewBar() + appliedRow() + html;
  $('#map-skel').hidden = !v.loading;
  renderRadiusCtl();
}

// One row under the toolbar: what the search is near (left) and the view switcher (right).
function viewBar() {
  const s = S();
  if (!s.anchors.length) return '';
  const v = app.view;
  const mode = v.mapMode || 'split';
  const coverageView = hasStores() && v.tab !== 'listings';
  const left = v.mode === 'proposal' ? '' : coverageView ? '' : `<span class="t-caption">Near</span>
      ${pois().map((a) => `<span class="crit">${esc(a.place.name)}<button class="x" data-act="remove-anchor" data-id="${esc(a.id)}" aria-label="Remove ${esc(a.place.name)}">${icon('x', 12)}</button></span>`).join('')}
      ${stores().length ? `<span class="crit">${plural(stores().length, 'client location', 'client locations')}</span>` : ''}`;
  if (v.mode === 'proposal') return `<div class="near-row view-bar"><div class="vb-left"><span class="t-caption">The ${plural(s.proposalIds.length, TERMS.listing, TERMS.listings)} in this ${TERMS.proposal}</span></div>${proposalViewSeg()}</div>`;
  const seg = [['split', 'split', 'Map and list'], ['full', 'map', 'Map only'], ['collapsed', 'list', 'List only']];
  return `<div class="near-row view-bar"><div class="vb-left">${left}</div>
    <div class="seg" role="radiogroup" aria-label="View">${seg.map(([m, ic, label]) => `<button class="seg-btn ${mode === m ? 'is-on' : ''}" role="radio" aria-checked="${mode === m}" data-act="view-mode" data-mode="${m}" title="${label}" aria-label="${label}">${icon(ic, 16)}</button>`).join('')}</div></div>`;
}

// ---------- List ----------
// Keep the scroll position when the list redraws (ticking boxes, adding, sorting in place).
function renderList() {
  const prev = $('#lp-list .list-scroll')?.scrollTop || 0;
  renderListInner();
  mapPort?.setChecked(app.view.selected);
  const sc = $('#lp-list .list-scroll');
  if (sc && prev) sc.scrollTop = prev;
}
function renderListInner() {
  const s = S();
  const v = app.view;
  const box = $('#lp-list');
  if (v.error) {
    box.innerHTML = `<div class="empty">${icon('alert', 20)}<div class="h">Listings could not load</div><p>Nothing changed. Your places and filters are kept.</p><div class="quick-replies"><button class="btn neutral sm" data-act="retry">Try again</button></div></div>`;
    return;
  }
  if (!s.anchors.length) {
    box.innerHTML = `<div class="empty">${icon('mapPin', 20)}<div class="h">Pick a place to see listings nearby</div><p>Choose a search result, then add it as a ${TERMS.poi} or a client location.</p></div>`;
    return;
  }
  if (v.loading) {
    box.innerHTML = `<div class="list-head"><div class="title"><span class="t-heading">${TERMS.Listings}</span></div></div><div class="list-scroll" style="padding:12px 16px;display:flex;flex-direction:column;gap:18px">${Array.from({ length: 6 }, (_, i) => `<div class="skel-row" style="width:${90 - i * 6}%"></div>`).join('')}</div>`;
    return;
  }
  if (v.mode === 'proposal') return renderProposalList(box);
  if (hasStores() && v.tab === 'locations') return renderLocationsTable(box);
  if (hasStores() && v.tab === 'coverage') return renderCoverageTable(box);
  renderListingsTable(box);
}

// Sorted column shows one arrow for its direction; the rest keep the faint two-way icon.
function sortIcon(on, dir) {
  return on ? icon(dir === 'asc' ? 'arrowUp' : 'arrowDown', 12) : icon('sort', 12, 'sort-idle');
}
function dirWord(key, dir) {
  if (key === 'impressions') return dir === 'desc' ? 'highest first' : 'lowest first';
  if (key === 'distance') return dir === 'asc' ? 'closest first' : 'farthest first';
  return dir === 'asc' ? 'A to Z' : 'Z to A';
}
function sortTh(label, key, cls = '') {
  const s = S().sort;
  const on = s.key === key;
  return `<th class="${on ? 'is-sorted' : ''} ${cls}" aria-sort="${on ? (s.direction === 'asc' ? 'ascending' : 'descending') : 'none'}"><button data-act="sort-col" data-key="${key}" title="${on ? `Sorted ${dirWord(key, s.direction)} · click to reverse` : `Sort by ${label.toLowerCase()}`}">${label}${sortIcon(on, s.direction)}</button></th>`;
}

// ---------- Listing columns ----------
// Listing (name + ID) is always shown. Everything else can be turned on from "Columns"; the table scrolls sideways.
// Fields follow the real sign model (BlipBot data check); values are invented fixtures.
const pillFor = (r) => r.isNew ? '<span class="pill info">New</span>' : r.listing.status === 'hold' ? '<span class="pill warning">On hold</span>' : '<span class="pill success">Available</span>';
const LIST_COLUMNS = [
  { key: 'distance', label: 'Distance', def: true, num: true, cell: (r, x) => `${shortMi(r.distanceMiles)}${x.multi ? `<div class="id">${esc(anchorName(r.nearestAnchorId))}</div>` : ''}` },
  { key: 'owner', label: TERMS.owner, def: true, cell: (r) => esc(r.listing.owner.name) },
  { key: 'impressions', label: TERMS.impressions, def: true, num: true, cell: (r) => impressions(r.listing.impressions) },
  { key: 'status', label: 'State', def: true, cell: pillFor },
  { key: 'media', label: 'Media type', group: 'Placement' },
  { key: 'dims', label: 'Dimensions', num: true, group: 'Placement' },
  { key: 'px', label: 'Resolution', num: true, group: 'Placement', hint: 'Creative size in pixels' },
  { key: 'environment', label: 'Environment', group: 'Placement' },
  { key: 'venue', label: 'Venue', group: 'Placement' },
  { key: 'orientation', label: 'Orientation', group: 'Placement' },
  { key: 'facing', label: 'Facing', group: 'Direction', cell: (r) => esc(r.listing.facing || '—') },
  { key: 'read', label: 'Read', group: 'Direction', cell: (r) => esc(r.listing.read ? `${r.listing.read} side` : '—') },
  { key: 'market', label: 'Market', group: 'Where' },
  { key: 'illuminatedHours', label: 'Lit hours', num: true, group: 'Content and hours', cell: (r) => `${r.listing.illuminatedHours} h` },
  { key: 'restricts', label: 'Turns down', group: 'Content and hours', sortable: false, cell: (r) => r.listing.restricts?.length ? esc(r.listing.restricts.join(', ')) : '<span class="muted">—</span>' },
];
const DEFAULT_COLUMNS = LIST_COLUMNS.filter((c) => c.def).map((c) => c.key);
function visibleColumns() {
  const on = app.columns || DEFAULT_COLUMNS;
  return LIST_COLUMNS.filter((c) => on.includes(c.key));
}
function columnsButton() {
  const extra = (app.columns || DEFAULT_COLUMNS).filter((k) => !DEFAULT_COLUMNS.includes(k)).length;
  return `<button class="btn neutral sm" data-act="pop" data-pop="columns" aria-haspopup="dialog">${icon('columns', 16)}Columns${extra ? `<span class="count-badge">+${extra}</span>` : ''}</button>`;
}

// Bulk selection: checkboxes, select all, shift-click for a range, then one action for the lot.
function selAllState(res) {
  const sel = app.view.selected.filter((id) => res.some((r) => r.listing.id === id)).length;
  return sel === 0 ? '' : sel === res.length ? 'checked' : 'data-mixed';
}
function bulkHead(res, sortedText, newCount) {
  const ids = app.view.selected.filter((id) => res.some((r) => r.listing.id === id));
  if (!ids.length) {
    return `<div class="list-head">
      <div class="title"><span class="t-heading">${TERMS.Listings}</span><span class="tag">${res.length}</span></div>
      <div class="head-right"><span class="t-caption">${esc(sortedText)}.${newCount ? ` ${plural(newCount, 'new listing', 'new listings')} marked.` : ''}</span>${columnsButton()}</div>
    </div>`;
  }
  const inP = S().proposalIds;
  const toAdd = ids.filter((id) => !inP.includes(id)).length;
  const toRemove = ids.length - toAdd;
  return `<div class="list-head bulk-bar" role="region" aria-label="Selection">
    <div class="title"><span class="t-body-m">${ids.length} selected</span>
      ${ids.length < res.length ? `<button class="link" style="font-size:13px" data-act="sel-all-btn">Select all ${res.length}</button>` : ''}</div>
    <div class="actions">
      ${toRemove ? `<button class="btn neutral sm" data-act="bulk-remove">Remove ${toRemove}</button>` : ''}
      ${toAdd ? `<button class="btn secondary sm" data-act="bulk-add">${icon('plus', 16)}Add ${toAdd} to ${TERMS.proposal}</button>` : ''}
      <button class="btn tertiary sm" data-act="sel-clear">Clear</button>
    </div>
  </div>`;
}

function renderListingsTable(box) {
  const s = S();
  const res = results();
  const multi = s.anchors.length > 1;
  const cols = visibleColumns();
  const ctx = { multi };
  const newCount = res.filter((r) => r.isNew).length;
  const single = s.anchors.length === 1 ? s.anchors[0].place.name : null;
  const sortedText = s.sort.key === 'distance' ? `Sorted by distance${single ? ` from ${single.replace(/ Stadium$/, '')}` : ''}` : `Sorted by ${sortLabel(s.sort.key).toLowerCase()}, ${dirWord(s.sort.key, s.sort.direction)}`;
  if (!res.length) {
    box.innerHTML = `<div class="empty">${icon('search', 20)}<div class="h">No listings match</div><p>Nothing within ${milesLabel(s.radiusMiles)} with these filters.</p><div class="quick-replies">
      <button class="chip" data-act="quick" data-text="Go out to ${s.radiusMiles >= 2 ? s.radiusMiles + 1 : 2} miles">Go out to ${s.radiusMiles >= 2 ? s.radiusMiles + 1 : 2} miles</button>
      ${s.excludeOwnerIds.length || s.availableOnly || s.onlyNew ? '<button class="chip" data-act="clear-filters">Clear filters</button>' : ''}</div></div>`;
    return;
  }
  box.innerHTML = `
    ${bulkHead(res, sortedText, newCount)}
    <div class="list-scroll">
      <table class="grid sticky-grid ${cols.length > 4 ? 'is-wide' : ''}">
        <thead><tr><th class="sel stick-l0"><label class="checkbox" title="Select all"><input type="checkbox" data-act="sel-all" aria-label="Select all ${res.length} ${TERMS.listings}" ${selAllState(res)}></label></th>${sortTh(TERMS.Listing, 'name', 'stick-l1')}${cols.map((c) => c.sortable === false ? `<th>${c.label}</th>` : sortTh(c.label, c.key, c.num ? 'num' : '')).join('')}<th class="stick-r"><span class="sr-only">Add</span></th></tr></thead>
        <tbody>${res.map((r) => {
          const inP = s.proposalIds.includes(r.listing.id);
          const sel = app.view.selected.includes(r.listing.id);
          return `<tr data-listing="${esc(r.listing.id)}" class="${inP ? 'in-proposal' : ''} ${sel ? 'is-checked' : ''} ${app.view.cardId === r.listing.id ? 'is-selected' : ''}">
            <td class="sel stick-l0"><label class="checkbox"><input type="checkbox" data-act="sel-row" data-id="${esc(r.listing.id)}" aria-label="Select ${esc(r.listing.name)}" ${sel ? 'checked' : ''}></label></td>
            <td class="stick-l1"><div class="name">${esc(r.listing.name)}</div><div class="id">${esc(r.listing.id)}</div></td>
            ${cols.map((c) => `<td class="${c.num ? 'num' : ''} ${c.def ? '' : 'nowrap'}">${c.cell ? c.cell(r, ctx) : esc(r.listing[c.key] ?? '—')}</td>`).join('')}
            <td class="act stick-r">${inP ? `<button class="cart-btn is-in" data-act="remove-proposal" data-id="${esc(r.listing.id)}" aria-pressed="true" aria-label="In proposal. Remove ${esc(r.listing.name)}" title="In proposal · click to remove">${icon('check', 16)}</button>` : `<button class="cart-btn" data-act="add-proposal" data-id="${esc(r.listing.id)}" aria-pressed="false" aria-label="Add ${esc(r.listing.name)} to proposal" title="Add to proposal">${icon('plus', 16)}</button>`}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>
    <div class="list-foot">
      <span>${plural(res.length, TERMS.listing, TERMS.listings)} within ${milesLabel(s.radiusMiles)}${single ? ` of ${esc(single)}` : multi ? ` of ${plural(s.anchors.length, 'place', 'places')}` : ''}.${newCount ? ' Pins with a halo on the map are the new ones.' : ''}</span>
      ${s.proposalIds.length ? `<button class="link" style="font-size:12px;min-height:24px" data-act="pop" data-pop="tray">${s.proposalIds.length} in proposal</button>` : ''}
    </div>`;
  bindRowHover(box);
  const all = box.querySelector('[data-act="sel-all"]'); if (all) all.indeterminate = selAllState(res) === 'data-mixed';
}

function bindRowHover(box) {
  box.querySelectorAll('tr[data-listing]').forEach((tr) => {
    tr.addEventListener('mouseenter', () => mapPort?.highlightListing(tr.dataset.listing));
    tr.addEventListener('mouseleave', () => mapPort?.highlightListing(null));
    // Click a row to jump the map to that listing.
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button, input, label')) return;
      openSignCard(tr.dataset.listing, { fly: true });
    });
  });
}

function locTh(label, key) {
  const ls = app.view.locSort;
  const on = ls.key === key;
  return `<th class="${on ? 'is-sorted' : ''}" aria-sort="${on ? (ls.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button data-act="loc-sort" data-key="${key}" title="${on ? 'Click to reverse' : `Sort by ${label.toLowerCase()}`}">${label}${sortIcon(on, ls.dir)}</button></th>`;
}

function renderLocationsTable(box) {
  const s = S();
  const rows = filteredCoverage();
  const total = stores().length;
  const gaps = coverage().filter((c) => !c.covered).length;
  const r = s.radiusMiles;
  box.innerHTML = `
    <div class="list-head">
      <div class="title"><span class="t-heading">${TERMS.Locations}</span><span class="tag">${rows.length}</span></div>
      <span class="t-caption">${app.view.locSort.key === 'coverage' ? 'Sorted by coverage, gaps first' : `Sorted by ${app.view.locSort.key}`}</span>
    </div>
    <div class="list-scroll">
      ${rows.length ? `<table class="grid">
        <thead><tr>${locTh(TERMS.Location, 'name')}${locTh('Tag', 'tag')}${locTh(`${TERMS.Listings} in ${shortMi(r)}`, 'count')}${locTh('Best listing', 'best')}${locTh('Coverage', 'coverage')}<th></th></tr></thead>
        <tbody>${rows.map((c) => {
          const widened = s.radiusOverrides[c.locationId] != null;
          const sel = app.view.selectedLocationId === c.locationId;
          const regionTag = c.location.tags.filter((t) => t !== app.csvSummary?.tagAll).at(-1) || c.location.tags[0];
          return `<tr data-location="${esc(c.locationId)}" class="${sel ? 'is-selected' : ''}" title="Show on the map">
            <td><div class="name">${esc(c.location.place.name)}</div>${c.location.place.address && !c.location.place.address.startsWith(c.location.place.name) ? `<div class="id">${esc(c.location.place.address)}</div>` : ''}</td>
            <td>${regionTag ? `<span class="tag">${esc(regionTag)}</span>` : ''}</td>
            <td class="num">${c.listingCount}${widened ? `<div class="id">in ${shortMi(c.radiusMiles)}</div>` : ''}</td>
            <td>${c.best ? `${esc(c.best.listing.name)}, ${shortMi(c.best.distanceMiles)}` : `<span class="muted">None within ${milesLabel(c.radiusMiles)}</span>`}</td>
            <td>${c.covered ? `<span class="pill success">Covered${widened ? ` at ${shortMi(c.radiusMiles)}` : ''}</span>` : '<span class="pill warning">No coverage</span>'}</td>
            <td class="act">${c.covered ? `<button class="btn tertiary sm" data-act="view-location" data-id="${esc(c.locationId)}">View</button>` : `<button class="btn neutral sm" data-act="expand-location" data-id="${esc(c.locationId)}">Expand</button>`}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>` : `<div class="empty">${icon('store', 20)}<div class="h">No ${TERMS.locations} match</div><p>Change the tag or coverage filter.</p></div>`}
    </div>
    <div class="list-foot"><span>Showing ${rows.length} of ${plural(total, TERMS.location, TERMS.locations)}. ${gaps ? `${gaps} have no listing within ${milesLabel(r)}.` : 'Every location has a listing nearby.'}</span>
      ${gaps ? `<button class="link" style="font-size:12px" data-act="quick" data-text="Expand to ${r + 1} miles for the ${gaps} gaps">Expand the ${gaps} gaps</button>` : ''}</div>`;
  box.querySelectorAll('tr[data-location]').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('button')) selectLocation(tr.dataset.location); }));
}

function renderCoverageTable(box) {
  const cov = coverage();
  const byTag = new Map();
  cov.forEach((c) => {
    const tag = c.location.tags.filter((t) => t !== app.csvSummary?.tagAll).at(-1) || 'Untagged';
    const row = byTag.get(tag) || { tag, total: 0, covered: 0, listings: 0 };
    row.total++; if (c.covered) row.covered++; row.listings += c.listingCount;
    byTag.set(tag, row);
  });
  const rows = [...byTag.values()].sort((a, b) => (a.covered / a.total) - (b.covered / b.total));
  box.innerHTML = `
    <div class="list-head"><div class="title"><span class="t-heading">Coverage by tag</span></div><span class="t-caption">Weakest first</span></div>
    <div class="list-scroll"><table class="grid">
      <thead><tr><th>Tag</th><th>${TERMS.Locations}</th><th>Covered</th><th>No coverage</th><th>${TERMS.Listings} nearby</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><span class="tag">${esc(r.tag)}</span></td><td class="num">${r.total}</td><td class="num">${r.covered} <span class="muted">(${Math.round((r.covered / r.total) * 100)}%)</span></td>
        <td class="num">${r.total - r.covered ? `<span class="pill warning">${r.total - r.covered}</span>` : '0'}</td><td class="num">${r.listings}</td>
        <td class="act"><button class="btn tertiary sm" data-act="filter-tag" data-tag="${esc(r.tag)}">Show</button></td></tr>`).join('')}</tbody>
    </table></div>
    <div class="list-foot"><span>Listings nearby counts a listing once per location it covers.</span></div>`;
}

function selectLocation(id) {
  app.view.selectedLocationId = id;
  if (app.view.tab !== 'locations') app.view.tab = 'locations';
  const loc = S().anchors.find((a) => a.id === id);
  renderWorkspace();
  if (loc) mapPort?.flyTo(loc.place.position, 12.5);
  const row = document.querySelector(`tr[data-location="${CSS.escape(id)}"]`);
  if (row) { row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}

// ---------- Map ----------
// How far past the radius to show gray pins: 2.5× the radius, at least 2 miles more, capped at 25.
function outsideReach(r) { return Math.min(25, Math.max(r * 2.5, r + 2)); }
function outsideFor(st) { return listingsOutside(LISTINGS, st, outsideReach(st.radiusMiles)); }

function previewState() {
  const s = S();
  const pr = app.view.previewRadius;
  return pr == null ? s : { ...s, radiusMiles: pr, radiusOverrides: {}, prevRadiusMiles: null };
}

// ---------- Radius slider (same action as the chip, the chat and the stat variable) ----------
// Stops, not a linear scale: sales teams mostly search at 5 and 10 miles, but stores in dense areas need fractions of a mile.
const R_STOPS = [0.25, 0.5, 1, 1.5, 2, 3, 5, 7.5, 10, 15, 20, 25];
const stopIndex = (m) => R_STOPS.reduce((best, v, i) => (Math.abs(v - m) < Math.abs(R_STOPS[best] - m) ? i : best), 0);
function radiusSummary(s) {
  if (s.anchors.some((a) => a.role === 'client_location')) {
    const cov = coverageByLocation(LISTINGS, s);
    return `${cov.filter((c) => c.covered).length} of ${plural(cov.length, TERMS.store, TERMS.stores)} covered`;
  }
  return `${plural(searchListings(LISTINGS, s).length, TERMS.listing, TERMS.listings)} inside`;
}
function radiusControl(where) {
  const s = previewState();
  const widened = Object.keys(S().radiusOverrides).length;
  return `
    <div class="top"><span class="t-caption">${hasStores() ? 'Radius for every location' : 'Radius'}</span><span class="val" data-rval>${shortMi(s.radiusMiles)}</span></div>
    <input class="range" type="range" min="0" max="${R_STOPS.length - 1}" step="1" value="${stopIndex(s.radiusMiles)}" data-radius="${where}" aria-label="Radius in miles" aria-valuetext="${milesLabel(s.radiusMiles)}">
    <div class="range-ends">${[0, R_STOPS.indexOf(5), R_STOPS.indexOf(10), R_STOPS.length - 1].map((i, k, arr) => `<span style="left:${(i / (R_STOPS.length - 1)) * 100}%" class="${k === 0 ? 'first' : k === arr.length - 1 ? 'last' : ''}">${R_STOPS[i]}${k === 0 || k === arr.length - 1 ? ' mi' : ''}</span>`).join('')}</div>
    <div class="sub" data-rsub>${radiusSummary(s)}${widened && app.view.previewRadius == null ? `. ${widened} widened ${widened === 1 ? TERMS.location : 'gaps'} reset if you move this.` : ''}</div>
    ${hasStores() ? '' : outsideHint(s, where)}`;
}
// Legend for the coverage map: what the squares, amber rings and numbered circles mean.
function renderLegend() {
  const el = $('#map-legend');
  if (!el) return;
  el.hidden = mode() !== 'coverage';
  if (el.hidden) return;
  const r = milesLabel(S().radiusMiles);
  el.innerHTML = `
    <span class="lg"><span class="lg-store"></span>Client ${TERMS.store}</span>
    <span class="lg"><span class="lg-store is-gap"></span>No listing within ${r}</span>
    <span class="lg"><span class="lg-cluster">3</span>${TERMS.Listings}, grouped</span>`;
}

// What a wider pitch would add: count just outside, plus a one-click step up.
function outsideHint(s, where) {
  if (where !== 'map' || app.view.previewRadius != null) return '';
  const reach = outsideReach(s.radiusMiles);
  const more = outsideFor(s).length;
  const next = R_STOPS.find((x) => x > s.radiusMiles && searchListings(LISTINGS, { ...s, radiusMiles: x, radiusOverrides: {} }).length > searchListings(LISTINGS, s).length);
  const gain = next ? searchListings(LISTINGS, { ...s, radiusMiles: next, radiusOverrides: {} }).length - searchListings(LISTINGS, s).length : 0;
  return `<div class="out-hint">
    <label class="checkbox out-toggle"><input type="checkbox" data-act="toggle-outside" ${app.view.showOutside !== false ? 'checked' : ''}><span class="out-dot" aria-hidden="true"></span>${more ? `${more} more within ${shortMi(Math.round(reach * 10) / 10)}` : `None within ${shortMi(Math.round(reach * 10) / 10)}`}</label>
    ${next ? `<button class="link" data-act="set-radius" data-miles="${next}">Widen to ${shortMi(next)} (+${gain})</button>` : ''}
  </div>`;
}

function renderRadiusCtl() {
  renderLegend();
  const el = $('#radius-ctl');
  if (!el || app.view.dragging) return;
  el.hidden = !S().anchors.length || app.view.error || app.view.mode === 'proposal';
  if (!el.hidden) el.innerHTML = radiusControl('map');
}
function onRadiusInput(input) {
  app.view.previewRadius = R_STOPS[+input.value];
  app.view.dragging = true;
  const box = input.closest('.radius-ctl');
  const s = previewState();
  box.querySelector('[data-rval]').textContent = shortMi(s.radiusMiles);
  box.querySelector('[data-rsub]').textContent = radiusSummary(s);
  updateMap();
}
function onRadiusCommit(input) {
  const m = R_STOPS[+input.value];
  app.view.previewRadius = null;
  app.view.dragging = false;
  app.view.popover = null;
  if (m === S().radiusMiles && !Object.keys(S().radiusOverrides).length) { renderWorkspace(); return; }
  controlAction({ type: 'setRadius', miles: m }, `Radius set to ${milesLabel(m)}`);
}

function updateMap() {
  if (!mapPort) return;
  const real = S();
  const s = previewState(); // while the slider is being dragged, draw the radius it would set
  const v = app.view;
  const m = mode();
  let anchors = s.anchors;
  const cov = coverageByLocation(LISTINGS, s);
  if (m === 'coverage' && v.tab === 'locations') {
    const keep = new Set(filteredCoverage().map((c) => c.locationId));
    anchors = anchors.filter((a) => a.role !== 'client_location' || keep.has(a.id));
  }
  const fitKey = `${real.anchors.map((a) => a.id).join(',')}|${real.radiusMiles}|${v.preview?.placeId || ''}`;
  const fit = fitKey !== app.lastFitKey && v.previewRadius == null;
  if (v.previewRadius == null) app.lastFitKey = fitKey;
  const pm = v.mode === 'proposal';
  const propResults = pm ? s.proposalIds.map((id) => LISTINGS.find((l) => l.id === id)).filter(Boolean).map((listing) => ({ listing, distanceMiles: 0, isNew: false })) : null;
  mapPort.render({
    anchors, results: v.error ? [] : pm ? propResults : searchListings(LISTINGS, s), coverage: pm ? [] : cov, mode: m, proposalIds: s.proposalIds,
    outside: !pm && !v.error && m === 'listings' && v.showOutside !== false ? outsideFor(s) : [],
    radiusFor: (id) => effectiveRadius(s, id), overrides: s.radiusOverrides, prevRadius: v.previewRadius == null ? s.prevRadiusMiles : null,
    selectedLocationId: v.selectedLocationId, preview: v.preview, fit: fit && (s.anchors.length || v.preview), showRingLabels: !hasStores(),
  });
}

// ---------- Proposal mode (same workspace: chat · listings · receipt) ----------
function chatCollapsed() { return !!app.chatCollapsed; }
// Which right-hand panel each step shows. Proposal has its own Summary · Map · List toggle (view.pview).
// ---------- Chat width: drag the divider between the chat and the content ----------
const CHAT_MIN = 280, CHAT_SNAP = 200, CONTENT_MIN = 520;
function chatMax() {
  const body = $('.body');
  if (!body) return 640;
  const cs = getComputedStyle(body);
  const inner = body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  return Math.max(CHAT_MIN, inner - CONTENT_MIN - 9);
}
function applyChatWidth() {
  const el = $('#chat-panel');
  if (!el) return;
  el.style.width = !chatCollapsed() && app.chatWidth ? `${Math.min(app.chatWidth, chatMax())}px` : '';
}
(function bindChatSplitter() {
  let drag = null, raf = 0;
  document.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('#col-split');
    if (!h) return;
    const chat = $('#chat-panel');
    drag = { x: e.clientX, w: chat.getBoundingClientRect().width, moved: false };
    if (chatCollapsed()) { app.chatCollapsed = false; chat.classList.remove('is-collapsed'); }
    try { h.setPointerCapture(e.pointerId); } catch (_) {}
    h.classList.add('is-dragging');
    document.body.classList.add('is-col-resizing');
    e.preventDefault();
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 3) drag.moved = true;
    const w = Math.max(52, Math.min(chatMax(), drag.w + dx));
    drag.cur = w;
    const chat = $('#chat-panel');
    chat.style.width = `${Math.max(w, CHAT_MIN)}px`;
    $('#col-split').classList.toggle('will-collapse', w < CHAT_SNAP);
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; mapPort?.resize(); });
  });
  document.addEventListener('pointerup', () => {
    if (!drag) return;
    const { cur, moved } = drag;
    drag = null;
    const h = $('#col-split');
    h.classList.remove('is-dragging', 'will-collapse');
    document.body.classList.remove('is-col-resizing');
    if (moved && cur < CHAT_SNAP) { app.chatCollapsed = true; }
    else if (moved) { app.chatCollapsed = false; app.chatWidth = Math.round(Math.max(CHAT_MIN, Math.min(chatMax(), cur))); }
    applyModeLayout();
  });
  document.addEventListener('dblclick', (e) => {
    if (!e.target.closest('#col-split')) return;
    app.chatWidth = null; app.chatCollapsed = false; applyModeLayout();
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.id !== 'col-split' || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const w = $('#chat-panel').getBoundingClientRect().width + (e.key === 'ArrowRight' ? 32 : -32);
    if (w < CHAT_SNAP) app.chatCollapsed = true;
    else { app.chatCollapsed = false; app.chatWidth = Math.max(CHAT_MIN, Math.min(chatMax(), Math.round(w))); }
    applyModeLayout();
  });
  window.addEventListener('resize', () => { if (app.screen === 'workspace') applyChatWidth(); });
})();

function applyModeLayout() {
  const v = app.view;
  const m = v.mode;
  const pv = v.pview || 'summary';
  $('.body')?.classList.toggle('is-proposal', m === 'proposal');
  $('#chat-panel')?.classList.toggle('is-collapsed', chatCollapsed());
  applyChatWidth();
  $('#toolbar')?.classList.toggle('is-proposal', m === 'proposal');
  const rc = $('#receipt'); if (rc) rc.hidden = true;
  const showListings = m === 'find';
  $('.panel-listings').hidden = !showListings;
  $('#brief-panel').hidden = m !== 'brief';
  $('#summary-panel').hidden = m !== 'proposal';
  setTimeout(() => mapPort?.resize(), 0);
}
function setMode(m) {
  const v = app.view;
  if (m === 'proposal' && !S().proposalIds.length) { toast(`Add ${TERMS.listings} first.`); return; }
  if (m === 'find' && !S().anchors.length) { toast('Add a place to the brief first.'); return; }
  const was = v.mode;
  v.mode = m;
  if (m === 'proposal') v.pview = 'summary';
  // Leaving the proposal's Map/List views restores the normal split for finding listings.
  if (m === 'find' && was === 'proposal') { v.mapMode = v.findMapMode || 'split'; }
  if (was === 'find') v.findMapMode = v.mapMode || 'split';
  v.popover = null; v.advOpen = false; v.selected = []; v.cardId = null;
  app.lastFitKey = '';
  renderWorkspace();
}
function setPview(pv) {
  app.view.pview = pv;
  app.lastFitKey = '';
  renderWorkspace();
}
function renderReceipt() {
  const el = $('#receipt');
  if (!el || app.view.mode !== 'proposal') return;
  const s = S();
  const pl = plan();
  const hide = app.hideInternal;
  const flags = pl.flags.filter((f) => f.key !== 'no-dates' || !app.brief.flightRough).map((f) => { const [h, b] = quoteFlagText(f, pl); return `<div class="banner ${f.level === 'review' ? 'error' : f.level === 'warn' ? 'warning' : 'info'} q-flag">${icon(f.level === 'info' ? 'info' : 'alert', 16)}<div><strong>${h}</strong><p>${b}</p></div></div>`; }).join('');
  el.innerHTML = `
    <div class="panel-head"><span class="t-heading">Summary</span><span class="t-caption">${plural(pl.lines.length, TERMS.listing, TERMS.listings)}</span></div>
    <div class="p-scroll">
      <div class="p-sec">
        <dl class="kvs"><dt>Flight</dt><dd>${app.quote.start && app.quote.end ? esc(flightText()) : `<button class="link" data-act="pop" data-pop="brief-flight">${esc(app.brief.flightRough || 'Add dates')}</button>`}</dd>
          <dt>Budget</dt><dd>${pl.budget ? `${app.brief.budgetRough ? 'About ' : ''}${money(pl.budget)}` : `<button class="link" data-act="pop" data-pop="brief-budget">Add budget</button>`}</dd>
          ${mixOf(pl.lines).map(([m, n]) => `<dt>${esc(m)}</dt><dd>${n}</dd>`).join('')}</dl>
        <div class="t-caption" style="margin:10px 0 6px">Creative sizes needed</div>
        <div class="chips-row">${sizesNeeded(pl.lines).map(([px, n]) => `<span class="tag">${esc(px)} ×${n}</span>`).join('')}</div>
      </div>
      <div class="p-sec q-sec">
        <div class="p-sec-head"><h2 class="t-heading">Quote</h2>
          <button class="btn tertiary sm hide-btn" data-act="toggle-internal" aria-pressed="${hide}" title="${hide ? 'Show internal numbers' : 'Hide internal numbers, for screen sharing'}">${icon(hide ? 'eye' : 'eyeOff', 14)}${hide ? 'Show internal' : 'Hide internal'}</button></div>
        ${hide ? '<p class="t-caption internal-hidden">Internal numbers are hidden for screen sharing.</p>' : `<div class="internal-box"><div class="ib-head"><span class="lock">${icon('alert', 12)}Internal only</span><span class="t-caption" style="font-weight:400">Never in an export</span></div>
          <dl class="kvs"><dt>Floor CPM</dt><dd>${money(pl.floor, 2)}</dd><dt>Suggested CPM</dt><dd>${money(pl.suggested, 2)}</dd></dl></div>`}
        <label class="field-label" for="q-cpm" style="margin-top:12px">Quoted CPM</label>
        <div class="field q-cpm ${pl.flags.some((f) => f.key === 'below-floor') ? 'is-flag' : ''}"><span class="muted">$</span><input id="q-cpm" data-q="cpm" inputmode="decimal" value="${app.quote.cpm != null ? app.quote.cpm : pl.suggested.toFixed(2)}"></div>
        ${app.quote.cpm != null && !hide ? `<button class="link" style="font-size:12px;margin-top:4px;min-height:24px" data-act="q-reset">Use suggested ${money(pl.suggested, 2)}</button>` : ''}
        <dl class="kvs totals"><dt>Impressions</dt><dd>${impressions(pl.impressions)}</dd>
          <dt>Flight length</dt><dd>${pl.weeks ? `${pl.weeks} weeks` : '4 weeks (assumed)'}</dd>
          <dt class="big">Estimated total</dt><dd class="big">${money(pl.total)}</dd></dl>
        ${flags}
      </div>
    </div>
    <div class="p-foot"><button class="btn primary lg" style="width:100%" data-act="flow-go" data-step="export">Continue to export ${icon('arrowRight', 16)}</button></div>`;
}
function proposalViewSeg() {
  const pv = app.view.pview || 'summary';
  return `<div class="seg labeled" role="radiogroup" aria-label="Proposal view">${[['summary', 'fileText', 'Summary'], ['map', 'map', 'Map'], ['list', 'list', 'List']].map(([k, ic, l]) => `<button class="seg-btn ${pv === k ? 'is-on' : ''}" role="radio" aria-checked="${pv === k}" data-act="pview" data-pv="${k}">${icon(ic, 14)}${l}</button>`).join('')}</div>`;
}

// ---------- Step 1: the brief (search criteria first) ----------
function briefField(state) { return state === 'rough' ? 'is-rough' : state === 'empty' ? 'is-empty' : ''; }
function renderBriefPanel() {
  const el = $('#brief-panel');
  if (!el || app.view.mode !== 'brief') return;
  const s = S();
  const q = app.quote, b = app.brief;
  const placeOpts = PLACES.filter((pl) => !pl.isMarket).map((pl) => `<option value="${esc(pl.name)}">`).join('');
  const flightState = q.start && q.end ? (b.flightEstimated ? 'rough' : 'set') : 'empty';
  const budgetState = parseMoney(q.budget) ? (b.budgetRough ? 'rough' : 'set') : b.budgetNote ? 'rough' : 'empty';
  el.innerHTML = `
    <div class="panel-head"><div><span class="t-heading">The brief</span><div class="t-caption" style="font-weight:400">Read from the request. Change anything here or in the chat.</div></div></div>
    <div class="p-scroll brief-form">
      <section class="bf-sec"><h3>${icon('mapPin', 16)}Where</h3>
        <div class="bf-places">${s.anchors.length ? s.anchors.filter((a) => a.role === 'point_of_interest').map((a) => `<span class="crit">${esc(a.place.name)}<button class="x" data-act="remove-anchor" data-id="${esc(a.id)}" aria-label="Remove ${esc(a.place.name)}">${icon('x', 12)}</button></span>`).join('') + (stores().length ? `<span class="crit">${plural(stores().length, 'client location', 'client locations')}</span>` : '') : '<span class="muted" style="font-size:13px">No places yet.</span>'}</div>
        <div class="bf-row">
          <div class="field" style="flex:1"><span>${icon('search', 16)}</span><input id="bf-place" list="bf-place-list" placeholder="Add a stadium, mall, address or city" autocomplete="off"><datalist id="bf-place-list">${placeOpts}</datalist></div>
          <button class="btn neutral" data-act="bf-add-place">Add</button>
          <button class="btn tertiary" data-act="open-csv">${icon('upload', 16)}A list of addresses</button>
        </div>
        <div class="bf-row"><label class="field-label" for="bf-radius" style="margin:0">Start within</label>
          <div class="select-wrap" style="width:140px"><select class="select" id="bf-radius" data-bf="radius">${R_STOPS.map((m) => `<option value="${m}" ${m === s.radiusMiles ? 'selected' : ''}>${milesLabel(m)}</option>`).join('')}</select>${icon('chevronDown', 16)}</div>
          <span class="t-caption" style="font-weight:400">A starting point. You can widen it on the map.</span></div>
      </section>
      <section class="bf-sec"><h3>${icon('calendar', 16)}Flight</h3>
        ${b.flightEstimated ? `<p class="bf-note"><span class="est-tag">Est.</span>Estimated from the request${b.estimateWhy ? `: ${esc(b.estimateWhy)}` : ''}. Change them if the client has exact dates.</p>` : ''}
        <div class="bf-grid ${briefField(flightState)}">
          <div><label class="field-label" for="bf-start">Starts</label><div class="field"><input type="date" id="bf-start" data-q="start" value="${esc(q.start)}"></div></div>
          <div><label class="field-label" for="bf-end">Ends</label><div class="field"><input type="date" id="bf-end" data-q="end" value="${esc(q.end)}"></div></div>
        </div>
      </section>
      <section class="bf-sec"><h3>${icon('wallet', 16)}Budget</h3>
        ${b.budgetNote && budgetState !== 'set' && !parseMoney(q.budget) ? `<p class="bf-note">${/unknown/i.test(b.budgetNote) ? "The request didn't give a budget." : `The request said "${esc(b.budgetNote)}".`}</p>` : ''}
        <div class="bf-row ${briefField(budgetState)}">
          <div class="field" style="width:200px"><span class="muted">$</span><input id="bf-budget" data-q="budget" inputmode="decimal" placeholder="Not given yet" value="${esc(q.budget)}"></div>
          <label class="checkbox" style="font-size:13px"><input type="checkbox" data-bf="rough" ${b.budgetRough ? 'checked' : ''}>It's a rough number</label>
        </div>
      </section>
      <section class="bf-sec"><h3>${icon('ban', 16)}Exclusions</h3>
        <div class="bf-owners">${OWNERS.map((o) => `<label class="checkbox"><input type="checkbox" data-bf="exclude" data-id="${o.id}" ${s.excludeOwnerIds.includes(o.id) ? 'checked' : ''}>${esc(o.name)}</label>`).join('')}</div>
        <button class="link" style="font-size:13px;margin-top:8px" data-act="adv-open-find">More filters, like media type or facing</button>
      </section>
      <section class="bf-sec"><h3>${icon('users', 16)}Client</h3>
        <div class="field" style="width:320px"><input id="bf-client" data-bf="client" placeholder="Agency or brand" value="${esc(app.proposal.client || '')}"></div>
      </section>
    </div>`;
}

// ---------- Step 3: the proposal summary (no map; Map and List are one click away) ----------
function renderSummaryPanel() {
  const el = $('#summary-panel');
  if (!el || app.view.mode !== 'proposal') return;
  const s = S();
  const pl = plan();
  const hide = app.hideInternal;
  const ex = s.excludeOwnerIds.map((id) => ownerById[id].name);
  const flags = pl.flags.map((f) => { const [h, b] = quoteFlagText(f, pl); return `<div class="banner ${f.level === 'review' ? 'error' : f.level === 'warn' ? 'warning' : 'info'} q-flag">${icon(f.level === 'info' ? 'info' : 'alert', 16)}<div><strong>${h}</strong><p>${b}</p></div></div>`; }).join('');
  el.innerHTML = `
    <div class="panel-head"><span class="t-heading">${TERMS.Proposal} summary</span><span class="t-caption" style="font-weight:400">The map and filters are in step 2. <button class="link" style="font-size:12px" data-act="ws-mode" data-mode="find">Go to ${TERMS.listings}</button></span></div>
    <div class="sum-body">
      <div class="sum-left">
        <div class="p-sec"><div class="p-sec-head"><h2 class="t-heading">Brief</h2><button class="link" style="font-size:13px" data-act="ws-mode" data-mode="brief">Edit</button></div>
          <dl class="kvs"><dt>Client</dt><dd>${esc(app.proposal.client || '—')}</dd><dt>Near</dt><dd>${esc(nearText())}</dd>
            <dt>Flight</dt><dd>${app.quote.start && app.quote.end ? `${app.brief.flightEstimated ? '<span class="est-tag">Est.</span>' : ''}${esc(flightText())}` : `<button class="link" style="font-size:13px" data-act="ws-mode" data-mode="brief">Add dates</button>`}</dd>
            <dt>Budget</dt><dd>${pl.budget ? `${app.brief.budgetRough ? 'About ' : ''}${money(pl.budget)}` : '<span class="muted">Not set</span>'}</dd>
            <dt>Exclusions</dt><dd>${ex.length ? esc(ex.join(', ')) : 'None'}</dd></dl></div>
        <div class="p-sec"><div class="p-sec-head"><h2 class="t-heading">${TERMS.Listings}</h2><span class="tag">${pl.lines.length}</span></div>
          <dl class="kvs">${mixOf(pl.lines).map(([m, n]) => `<dt>${esc(m)}</dt><dd>${plural(n, TERMS.listing, TERMS.listings)}</dd>`).join('')}</dl>
          <div class="t-caption" style="margin:10px 0 6px">Creative sizes needed</div>
          <div class="chips-row">${sizesNeeded(pl.lines).map(([px, n]) => `<span class="tag">${esc(px)} ×${n}</span>`).join('')}</div></div>
        <div class="p-sec q-sec"><div class="p-sec-head"><h2 class="t-heading">Quote</h2>
            <button class="btn tertiary sm hide-btn" data-act="toggle-internal" aria-pressed="${hide}">${icon(hide ? 'eye' : 'eyeOff', 14)}${hide ? 'Show internal' : 'Hide internal'}</button></div>
          ${hide ? '<p class="t-caption internal-hidden">Internal numbers are hidden for screen sharing.</p>' : `<div class="internal-box"><div class="ib-head"><span class="lock">${icon('alert', 12)}Internal only</span><span class="t-caption" style="font-weight:400">Never in an export</span></div>
            <dl class="kvs"><dt>Floor CPM</dt><dd>${money(pl.floor, 2)}</dd><dt>Suggested CPM</dt><dd>${money(pl.suggested, 2)}</dd></dl></div>`}
          <label class="field-label" for="q-cpm" style="margin-top:12px">Quoted CPM</label>
          <div class="field q-cpm ${pl.flags.some((f) => f.key === 'below-floor') ? 'is-flag' : ''}"><span class="muted">$</span><input id="q-cpm" data-q="cpm" inputmode="decimal" value="${app.quote.cpm != null ? app.quote.cpm : pl.suggested.toFixed(2)}"></div>
          ${app.quote.cpm != null && !hide ? `<button class="link" style="font-size:12px;margin-top:4px;min-height:24px" data-act="q-reset">Use suggested ${money(pl.suggested, 2)}</button>` : ''}
          <dl class="kvs totals"><dt>Impressions</dt><dd>${impressions(pl.impressions)}</dd><dt>Flight length</dt><dd>${pl.weeks ? `${pl.weeks} weeks` : '4 weeks (assumed)'}</dd>
            <dt class="big">Estimated total</dt><dd class="big">${money(pl.total)}</dd></dl>
          ${flags}</div>
      </div>
      <div class="sum-right">
        <div class="list-head"><div class="title"><span class="t-heading">${TERMS.Listings} in this ${TERMS.proposal}</span><span class="tag">${pl.lines.length}</span></div>
          <div class="head-right"><button class="btn neutral sm" data-act="ws-mode" data-mode="find">${icon('plus', 16)}Add more</button></div></div>
        <div class="list-scroll"><ul class="prop-list">${pl.lines.map(({ listing: l, impressions: i, cost }) => propRow(l, i, cost)).join('')}</ul></div>
        <div class="list-foot"><span>${impressions(pl.impressions)} impressions · ${money(pl.total)} at ${money(pl.cpm, 2)} CPM</span></div>
      </div>
    </div>`;
}
// One proposal listing: enough to judge it without the map, and every adjustment one click away.
function propRow(l, i, cost) {
  const open = (app.view.expanded || []).includes(l.id);
  const where = l.facing ? `Faces ${l.facing}` : l.venue;
  const pill = l.status === 'hold' ? '<span class="pill warning">On hold</span>' : '<span class="pill success">Available</span>';
  return `<li class="prop-row ${open ? 'is-open' : ''}">
    <div class="pr-main">
      <button class="pr-thumb" data-act="p-on-map" data-id="${esc(l.id)}" aria-label="Show ${esc(l.name)} on the map">${placeholderPhoto(l)}</button>
      <div class="pr-info">
        <div class="pr-title"><span class="name" title="${esc(l.name)}">${esc(l.name)}</span></div>
        <div class="id pr-id">${esc(l.id)} · ${esc(l.market)} · ${esc(l.owner.name)}</div>
        <div class="pr-specs"><span class="tag">${esc(l.media)}</span><span class="tag">${esc(l.dims)}</span><span class="tag">${esc(l.px)}</span><span class="tag">${esc(where)}</span>${pill}</div>
      </div>
      <div class="pr-nums"><div class="pr-cost">${money(cost)}</div><div class="t-caption" style="font-weight:400">${impressions(i)} impressions</div></div>
      <div class="pr-acts">
        <button class="icon-btn sm" data-act="p-on-map" data-id="${esc(l.id)}" title="Show on the map" aria-label="Show ${esc(l.name)} on the map">${icon('map', 16)}</button>
        <button class="icon-btn sm" data-act="p-expand" data-id="${esc(l.id)}" aria-expanded="${open}" title="${open ? 'Less' : 'More details'}" aria-label="${open ? 'Hide' : 'Show'} details for ${esc(l.name)}">${icon('chevronDown', 16, open ? 'flip' : '')}</button>
        <button class="icon-btn sm" data-act="p-remove" data-id="${esc(l.id)}" title="Remove from the proposal" aria-label="Remove ${esc(l.name)}">${icon('x', 16)}</button>
      </div>
    </div>
    ${open ? `<dl class="pr-more">
      <dt>Environment</dt><dd>${esc(l.environment)}</dd><dt>Orientation</dt><dd>${esc(l.orientation)}</dd>
      <dt>Read</dt><dd>${l.read ? `${esc(l.read)} side` : '—'}</dd><dt>Lit hours</dt><dd>${l.illuminatedHours} h</dd>
      <dt>Impressions / 4 wks</dt><dd>${impressions(l.impressions)}</dd><dt>Turns down</dt><dd>${l.restricts?.length ? esc(l.restricts.join(', ')) : 'Nothing'}</dd>
      ${app.hideInternal ? '' : `<dt class="internal-dt">${icon('alert', 12)}Floor CPM</dt><dd class="internal-dd">${money(l.floorCpm, 2)}</dd>`}
    </dl>` : ''}
  </li>`;
}

function renderProposalList(box) {
  const pl = plan();
  box.innerHTML = `
    <div class="list-head"><div class="title"><span class="t-heading">${TERMS.Listings} in this ${TERMS.proposal}</span><span class="tag">${pl.lines.length}</span></div>
      <div class="head-right"><span class="t-caption">Edit here or ask in the chat</span>${columnsButton()}</div></div>
    <div class="list-scroll">${reviewTable(pl)}</div>
    <div class="list-foot"><span>${impressions(pl.impressions)} impressions over the flight · ${money(pl.total)} at ${money(pl.cpm, 2)} CPM</span>
      <button class="link" style="font-size:12px;min-height:24px" data-act="ws-mode" data-mode="find">${icon('plus', 14)}Add more ${TERMS.listings}</button></div>`;
}

// ---------- Sign card (click a pin or a row) ----------
// Matches the board card in the ADKOM color system: photo, name, ID line, key facts, one action.
function openSignCard(id, { fly = false, scrollRow = false } = {}) {
  const l = LISTINGS.find((x) => x.id === id);
  if (!l) return;
  const v = app.view;
  v.cardId = id;
  if ((v.mapMode || 'split') === 'collapsed') setMapMode('split');
  mapPort?.selectListing(id);
  if (fly) mapPort?.flyTo(l.position, 14.5);
  renderSignCard();
  document.querySelectorAll('tr.is-selected').forEach((r) => r.classList.remove('is-selected'));
  const row = document.querySelector(`tr[data-listing="${CSS.escape(id)}"]`);
  if (row) {
    row.classList.add('is-selected');
    if (scrollRow) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}
function closeSignCard() {
  app.view.cardId = null;
  mapPort?.selectListing(null);
  document.querySelectorAll('tr.is-selected').forEach((r) => r.classList.remove('is-selected'));
  renderSignCard();
}
function renderSignCard() {
  const el = $('#sign-card');
  if (!el) return;
  const id = app.view.cardId;
  const s = S();
  const r = id ? searchListings(LISTINGS, { ...s, onlyNew: false }).find((x) => x.listing.id === id) : null;
  const l = r?.listing || (id ? LISTINGS.find((x) => x.id === id) : null);
  // Outside the radius: distance to the nearest place, so the rep can pitch going wider.
  let outNear = null;
  if (l && !r && s.anchors.length) {
    for (const a of s.anchors) { const dd = haversineMiles(l.position, a.place.position); if (!outNear || dd < outNear.d) outNear = { d: dd, a }; }
  }
  if (!l) { el.hidden = true; el.innerHTML = ''; return; }
  const inP = s.proposalIds.includes(l.id);
  const pill = r?.isNew ? '<span class="pill info">New</span>' : l.status === 'hold' ? '<span class="pill warning">On hold</span>' : '<span class="pill success">Available</span>';
  const where = l.facing ? `Faces ${l.facing}` : l.venue;
  const rows = [
    [TERMS.impressions, impressions(l.impressions)],
    ['Distance', r ? `${shortMi(r.distanceMiles)} from ${esc(anchorName(r.nearestAnchorId).replace(/ Stadium$/, ''))}` : outNear ? `${shortMi(outNear.d)} from ${esc(outNear.a.place.name.replace(/ Stadium$/, ''))}` : '—'],
    [TERMS.owner, esc(l.owner.name)],
    ['Size', `${esc(l.size)}${SIZE_HINT[l.size] ? ` · ${esc(SIZE_HINT[l.size])}` : ''}`],
    l.environment === 'Place based' ? ['Venue', esc(l.venue)] : ['Read', `${esc(l.read)} side`],
    ['State', pill],
  ];
  el.hidden = false;
  el.innerHTML = `
    <div class="sc-photo">${placeholderPhoto(l)}<span class="sc-ph-label">Placeholder photo</span>
      <button class="sc-close" data-act="card-close" aria-label="Close">${icon('x', 14)}</button></div>
    <div class="sc-body">
      <div><h4 class="sc-name">${esc(l.name)}</h4><div class="sc-id">${esc(l.id)} · ${esc(l.media)} · ${esc(where)}</div></div>
      <dl class="sc-facts">${rows.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('')}</dl>
      ${!r && outNear ? `<div class="sc-out">${icon('target', 14)}<span>Outside your ${shortMi(s.radiusMiles)} radius. <button class="link" data-act="set-radius" data-miles="${R_STOPS.find((x) => x >= outNear.d) || 25}">Widen to ${shortMi(R_STOPS.find((x) => x >= outNear.d) || 25)}</button></span></div>` : ''}
      ${l.restricts?.length ? `<div class="sc-note">${icon('info', 14)}Turns down ${esc(l.restricts.map((x) => x.toLowerCase()).join(' and '))} ads</div>` : ''}
    </div>
    <div class="sc-foot">${inP
      ? `<button class="btn secondary sc-btn" data-act="remove-proposal" data-id="${esc(l.id)}">${icon('check', 16)}In proposal · Remove</button>`
      : `<button class="btn primary sc-btn" data-act="add-proposal" data-id="${esc(l.id)}">${icon('plus', 16)}${!r && outNear ? 'Add anyway' : 'Add to proposal'}</button>`}</div>`;
}

// ---------- Map and list split ----------
// view.mapMode: 'split' (drag to size), 'collapsed' (map hidden), 'full' (list hidden). view.mapH: map height in px, null = default.
const MAP_MIN = 140, LIST_MIN = 120, SNAP = 70;
function defaultMapH() { return Math.round(Math.min(420, Math.max(240, window.innerHeight * 0.33))); }
function applyMapLayout() {
  const sec = $('#map-section'), box = $('#map-box'), list = $('#lp-list'), split = $('#splitter');
  if (!sec || !split) return;
  const v = app.view;
  const mode = v.mapMode || 'split';
  sec.classList.toggle('is-collapsed', mode === 'collapsed');
  sec.classList.toggle('is-full', mode === 'full');
  list.style.display = mode === 'full' ? 'none' : 'flex';
  box.style.height = mode === 'split' ? `${v.mapH ?? defaultMapH()}px` : '';
  split.setAttribute('aria-valuenow', mode === 'collapsed' ? 0 : mode === 'full' ? 100 : 50);
  $('#split-label').innerHTML = mode === 'collapsed' ? `${icon('map', 14)}Map hidden · click to show` : mode === 'full' ? `${icon('list', 14)}${TERMS.Listings} hidden · click to show` : '';
  split.classList.toggle('is-closed', mode !== 'split');
}
function setMapMode(mode, h) {
  const v = app.view;
  const was = v.mapMode || 'split';
  v.mapMode = mode;
  if (h != null) v.mapH = h;
  applyMapLayout();
  if (was !== mode || h != null) setTimeout(() => mapPort?.resize(), 0);
  if (was !== mode) { const vb = $('.view-bar'); if (vb) renderTop(); }
}
// Drag the handle: live resize, snap shut past the edges.
(function bindSplitter() {
  let drag = null, raf = 0;
  document.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('#splitter');
    if (!h || e.target.closest('button')) return;
    const box = $('#map-box'), panel = $('.panel-listings'), list = $('#lp-list');
    const mode = app.view.mapMode || 'split';
    const startH = mode === 'collapsed' ? 0 : mode === 'full' ? box.getBoundingClientRect().height : box.getBoundingClientRect().height;
    // Space the map can grow into = current map + current list
    const room = startH + (mode === 'full' ? 0 : list.getBoundingClientRect().height);
    drag = { y: e.clientY, startH, room, h: startH, from: mode, moved: false, prevH: app.view.mapH };
    try { h.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events */ }
    h.classList.add('is-dragging');
    if (mode !== 'split') { app.view.mapMode = 'split'; app.view.mapH = Math.max(startH, 1); applyMapLayout(); }
    e.preventDefault();
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const hgt = Math.max(0, Math.min(drag.room, drag.startH + (e.clientY - drag.y)));
    drag.h = hgt;
    if (Math.abs(e.clientY - drag.y) > 4) drag.moved = true;
    const box = $('#map-box');
    box.style.height = `${Math.max(hgt, 0)}px`;
    const split = $('#splitter');
    split.classList.toggle('will-collapse', hgt < MAP_MIN - SNAP / 2);
    split.classList.toggle('will-full', drag.room - hgt < LIST_MIN - SNAP / 2);
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; mapPort?.resize(); });
  });
  document.addEventListener('pointerup', () => {
    if (!drag) return;
    const split = $('#splitter');
    split.classList.remove('is-dragging', 'will-collapse', 'will-full');
    const { h, room, from, moved, prevH } = drag;
    drag = null;
    // A click (no drag) on a closed bar opens what is hidden, at the height it had before.
    if (!moved && from !== 'split') { app.view.mapMode = from; app.view.mapH = prevH; setMapMode('split'); return; }
    if (!moved) { app.view.mapMode = from; applyMapLayout(); return; }
    if (h < MAP_MIN - SNAP / 2) setMapMode('collapsed');
    else if (room - h < LIST_MIN - SNAP / 2) setMapMode('full');
    else setMapMode('split', Math.max(MAP_MIN, Math.min(room - LIST_MIN, Math.round(h))));
  });
  document.addEventListener('dblclick', (e) => { if (e.target.closest('#splitter') && !e.target.closest('button')) { app.view.mapH = null; setMapMode('split'); } });
  document.addEventListener('keydown', (e) => {
    if (!e.target.matches?.('#splitter')) return;
    const v = app.view;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMapMode((v.mapMode || 'split') === 'collapsed' ? 'split' : 'collapsed'); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const cur = (v.mapMode || 'split') === 'collapsed' ? 0 : $('#map-box').getBoundingClientRect().height;
      const next = cur + (e.key === 'ArrowDown' ? 32 : -32);
      if (next < MAP_MIN) setMapMode('collapsed'); else setMapMode('split', next);
    }
  });
  window.addEventListener('resize', () => { if (app.screen === 'workspace') applyMapLayout(); });
})();

// ---------- Search ----------
function searchItems() {
  const v = app.view;
  if (v.category) {
    const cat = NEARBY_CATEGORIES.find((c) => c.id === v.category);
    return PLACES.filter((p) => cat.match.includes(p.category));
  }
  if (!v.query.trim()) return PLACES.filter((p) => p.recent);
  return searchGazetteer(v.query);
}
function placeIcon(p) {
  if (p.recent && !app.view.query) return 'clock';
  if (p.recent) return 'clock';
  if (p.category === 'Address') return 'building';
  if (p.category === 'Parking') return 'parking';
  if (p.isMarket) return 'map';
  return 'mapPin';
}
function highlight(text, q) {
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(text);
  return `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
}
// A list is two or more entries split by new lines, semicolons or pipes. Commas stay: they live inside addresses.
function splitList(text) {
  return String(text || '').split(/\r?\n|;|\|/).map((x) => x.trim()).filter(Boolean).slice(0, 500);
}
function openBulkReview(list) {
  $('#search-input').value = '';
  app.view.query = '';
  closeSearch();
  app.dialog = { step: 'map', source: 'paste', fileName: 'Pasted addresses', columns: ['address'], rows: list.map((a) => ({ address: a })), mapping: { address: 'address', name: '', tag: '', city: '' }, results: [], tagAll: '', useTagCol: false, drag: false, resolutions: {}, pastedText: list.join('\n') };
  geocodeDialog();
  renderDialog();
}

function renderSearch() {
  const pop = $('#search-pop');
  if (!pop) return;
  const v = app.view;
  if (!v.showSearch) { pop.innerHTML = ''; return; }
  const q = v.query.trim();
  const list = splitList(q);
  if (list.length > 1) {
    // A pasted list: offer to review and add them all, through the same review and tag step as a CSV.
    pop.innerHTML = `
      <div class="search-pop" role="listbox">
        <div class="results">
          <div class="sr is-focus" role="option" aria-selected="true">
            <span class="sr-ico">${icon('list', 14)}</span>
            <div class="sr-main" data-act="bulk-review"><div class="t-body-m">Add ${list.length} addresses</div>
              <div class="sr-sub">${esc(list.slice(0, 2).join(' · '))}${list.length > 2 ? ` and ${list.length - 2} more` : ''}</div></div>
            <button class="btn primary sm" data-act="bulk-review">Review</button>
          </div>
          <div class="none" style="font-size:12px;line-height:16px">We find each one on the map, then you check the matches and tag them. Nothing is added until you confirm.</div>
        </div>
      </div>`;
    return;
  }
  const items = searchItems();
  pop.innerHTML = `
    <div class="search-pop" role="listbox">
      <div class="results">
        ${!q && !v.category ? '<div class="menu-label" style="padding:10px 12px 4px">Recent</div>' : ''}
        ${v.category ? `<div class="menu-label" style="padding:10px 12px 4px">${esc(NEARBY_CATEGORIES.find((c) => c.id === v.category).label)} on the map</div>` : ''}
        ${items.length ? items.map((p, i) => `
          <div class="sr ${i === v.focusIdx ? 'is-focus' : ''}" data-idx="${i}" role="option" aria-selected="${i === v.focusIdx}">
            <span class="sr-ico">${icon(placeIcon(p), 14)}</span>
            <div class="sr-main" data-act="sr-add" data-id="${p.placeId}"><div class="t-body-m">${highlight(p.name, q)}</div><div class="sr-sub">${esc(p.recent ? 'Recent search' : p.category)} · ${esc(p.area)}</div></div>
            ${i === v.focusIdx ? '<span class="enter-hint">↵ to add</span>' : ''}
            <button class="btn tertiary sm" data-act="sr-add" data-id="${p.placeId}">Add</button>
          </div>`).join('') : `<div class="none">No place matches "${esc(q)}". Try a street address or a landmark nearby.</div>`}
        ${!q && !v.category ? `<div class="none" style="font-size:12px;line-height:16px;display:flex;gap:8px;align-items:center">${icon('list', 14)}<span>Have several? Paste a list of addresses, one per line, to add them all at once.</span></div>` : ''}
      </div>
      ${v.addMenuFor ? `<div class="menu add-menu" role="menu" id="add-menu">
        <button class="menu-item" data-act="add-as" data-role="point_of_interest" data-id="${v.addMenuFor}">${icon('flag', 16)}Add as ${TERMS.poi}</button>
        <button class="menu-item" data-act="add-as" data-role="client_location" data-id="${v.addMenuFor}">${icon('store', 16)}Add as client location</button>
        <button class="menu-item" data-act="add-as" data-role="search_around" data-id="${v.addMenuFor}">${icon('target', 16)}Search around it</button>
      </div>` : ''}
      <div class="search-nearby">
        <div class="t-caption" style="margin-bottom:8px">Search nearby</div>
        <div class="quick-replies">${NEARBY_CATEGORIES.map((c) => `<button class="chip ${v.category === c.id ? 'is-on' : ''}" data-act="category" data-cat="${c.id}">${c.label}</button>`).join('')}</div>
      </div>
    </div>`;
  // Place the add menu beside its row, outside the scrolling results so it is never clipped.
  const menu = $('#add-menu');
  if (menu) {
    const idx = items.findIndex((p) => p.placeId === v.addMenuFor);
    const row = pop.querySelector(`.sr[data-idx="${idx}"]`);
    const list = pop.querySelector('.results');
    if (row) menu.style.top = `${Math.max(0, row.offsetTop - list.scrollTop)}px`;
  }
  pop.querySelectorAll('.sr').forEach((el) => {
    el.addEventListener('mouseenter', () => {
      const p = items[+el.dataset.idx];
      if (app.view.preview?.placeId !== p.placeId) { app.view.preview = p; updateMap(); }
    });
  });
  const focused = items[v.focusIdx];
  if (focused && v.preview?.placeId !== focused.placeId) { v.preview = focused; updateMap(); }
}
function closeSearch() {
  const v = app.view;
  v.showSearch = false; v.addMenuFor = null; v.preview = null; v.category = null; v.focusIdx = -1;
  renderSearch();
  updateMap();
}
function onSearchKey(e) {
  const v = app.view;
  const list = splitList(v.query);
  if (list.length > 1 && e.key === 'Enter') { e.preventDefault(); openBulkReview(list); return; }
  const items = searchItems();
  if (e.key === 'ArrowDown') { e.preventDefault(); v.focusIdx = Math.min(items.length - 1, v.focusIdx + 1); v.addMenuFor = null; renderSearch(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); v.focusIdx = Math.max(0, v.focusIdx - 1); v.addMenuFor = null; renderSearch(); }
  // Enter adds the highlighted result as a point of interest (the Add menu holds the other choices).
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (!v.query.trim() && v.focusIdx < 0 && !v.category) return;
    const p = v.addMenuFor ? placeById[v.addMenuFor] : items[Math.max(0, v.focusIdx)];
    if (p) addPlaceFromSearch(p.placeId, 'point_of_interest');
  }
  else if (e.key === 'ArrowRight' && v.focusIdx >= 0 && items[v.focusIdx]) { v.addMenuFor = items[v.focusIdx].placeId; renderSearch(); }
  else if (e.key === 'Escape') { $('#search-input').blur(); closeSearch(); }
}
function addPlaceFromSearch(placeId, role) {
  const p = placeById[placeId];
  const first = !S().anchors.length;
  $('#search-input').value = '';
  app.view.query = '';
  closeSearch();
  if (role === 'search_around') controlAction({ type: 'addPlace', place: p, role: 'point_of_interest', replace: true }, `Searching around ${p.name}`);
  else controlAction({ type: 'addPlace', place: p, role }, `Added ${p.name} as a ${role === 'client_location' ? 'client location' : TERMS.poi}`);
  if (role === 'client_location') app.view.tab = 'locations';
  if (first && app.proposal.title === 'New proposal') app.proposal.title = `${p.name.replace(/ Stadium$/, '')} campaign`;
  renderWorkspace();
}

// ---------- Advanced filters ----------
// One drawer for every sign attribute. Edits stay in a draft with live counts; "Show N" applies them as one undoable action,
// the same setFilters action the chat uses.
function filtersCount(s = S()) {
  return advCount(s.adv || emptyAdv()) + (s.excludeOwnerIds.length ? 1 : 0) + (s.availableOnly ? 1 : 0);
}
function advButton() {
  const n = filtersCount();
  return `<button class="chip ${n ? 'is-on' : ''}" data-act="adv-open" aria-haspopup="dialog" aria-label="Advanced filters${n ? `, ${n} on` : ''}">${icon('sliders', 14)}<span class="adv-long">Advanced filters</span><span class="adv-short">Filters</span>${n ? `<span class="count-badge">${n}</span>` : ''}</button>`;
}
function appliedRow() {
  const s = S();
  const adv = s.adv || emptyAdv();
  const chips = [];
  for (const k of ADV_KEYS) if (adv[k].length) chips.push([`adv:${k}`, advChipLabel(k, adv[k])]);
  if (adv.minImpressions) chips.push(['adv:minImpressions', advChipLabel('minImpressions', adv.minImpressions)]);
  if (s.excludeOwnerIds.length) chips.push(['owners', `Not ${s.excludeOwnerIds.map((id) => ownerById[id].name).join(', ')}`]);
  if (s.availableOnly) chips.push(['availableOnly', 'Available only']);
  if (!chips.length) return '';
  return `<div class="near-row applied-row"><span class="t-caption">Filters</span>
    ${chips.map(([k, l]) => `<span class="chip applied sm-chip">${esc(l)}<button class="x" data-act="revert" data-key="${esc(k)}" aria-label="Remove ${esc(l)}">${icon('x', 12)}</button></span>`).join('')}
    <button class="btn tertiary sm" data-act="clear-filters">Clear all</button></div>`;
}
function openAdv() {
  const s = S();
  app.view.advDraft = { adv: JSON.parse(JSON.stringify(s.adv || emptyAdv())), ex: [...s.excludeOwnerIds], avail: s.availableOnly };
  app.view.advOpen = true;
  app.view.advConfirm = false;
  app.view.popover = null;
  renderAdv();
}
function draftState(d, without) {
  const adv = { ...d.adv };
  if (without) adv[without] = without === 'minImpressions' ? null : [];
  return { ...S(), adv, excludeOwnerIds: without === 'owners' ? [] : d.ex, availableOnly: without === 'avail' ? false : d.avail, onlyNew: false };
}
// How many results each option would leave, holding every other filter fixed.
function facet(d, field) {
  const counts = {};
  for (const r of searchListings(LISTINGS, draftState(d, field))) {
    const v = field === 'owners' ? r.listing.owner.id : field === 'accepts' ? null : r.listing[field];
    if (field === 'accepts') { for (const c of ATTR.restrictions) if (!(r.listing.restricts || []).includes(c)) counts[c] = (counts[c] || 0) + 1; }
    else counts[v] = (counts[v] || 0) + 1;
  }
  return counts;
}
function pills(d, field, values, hints = {}) {
  const f = facet(d, field);
  const cur = d.adv[field];
  return `<div class="pills">${values.map((v) => {
    const on = cur.includes(v);
    const n = f[v] || 0;
    return `<button class="pill-opt ${on ? 'is-on' : ''}" data-act="adv-toggle" data-field="${field}" data-val="${esc(v)}" aria-pressed="${on}" ${!n && !on ? 'data-zero="1"' : ''}>${on ? icon('check', 12) : ''}${esc(v)}${hints[v] ? `<span class="hint">${esc(hints[v])}</span>` : ''}<span class="n">${n}</span></button>`;
  }).join('')}</div>`;
}
function renderAdv() {
  const host = $('#adv-root');
  if (!host) return;
  const v = app.view;
  if (!v.advOpen) { host.innerHTML = ''; return; }
  const d = v.advDraft;
  const ds = draftState(d);
  const n = searchListings(LISTINGS, ds).length;
  const storesMode = hasStores();
  const cov = storesMode ? coverageByLocation(LISTINGS, ds) : null;
  const fac = facet(d, 'facing');
  const compass = ['NW', 'N', 'NE', 'W', '', 'E', 'SW', 'S', 'SE'];
  const ownerF = facet(d, 'owners');
  const draftCount = advCount(d.adv) + (d.ex.length ? 1 : 0) + (d.avail ? 1 : 0);
  host.innerHTML = `
    <div class="adv-scrim" data-act="adv-close"></div>
    <aside class="adv" role="dialog" aria-modal="false" aria-labelledby="adv-title">
      <div class="adv-head"><div><h2 class="t-heading" id="adv-title" style="margin:0">Advanced filters</h2>
        <div class="t-caption" style="font-weight:400">Numbers show what each choice would leave within ${milesLabel(S().radiusMiles)}.</div></div>
        <button class="icon-btn" data-act="adv-close" aria-label="Close">${icon('x', 18)}</button></div>
      <div class="adv-body">
        <section><h3>Placement</h3>
          <div class="adv-field"><div class="lbl">Environment</div>${pills(d, 'environment', ATTR.environment)}</div>
          <div class="adv-field"><div class="lbl">Venue</div>${pills(d, 'venue', ATTR.venue)}</div>
          <div class="adv-field"><div class="lbl">Media type</div>${pills(d, 'media', ATTR.media)}</div>
          <div class="adv-field"><div class="lbl">Size</div>${pills(d, 'size', ATTR.size, SIZE_HINT)}</div>
          <div class="adv-field"><div class="lbl">Orientation</div>${pills(d, 'orientation', ATTR.orientation)}</div>
        </section>
        <section><h3>Direction</h3>
          <div class="adv-field"><div class="lbl">Facing <span class="sub">Roadside signs only</span></div>
            <div class="compass">${compass.map((c) => c ? `<button class="pill-opt dir ${d.adv.facing.includes(c) ? 'is-on' : ''}" data-act="adv-toggle" data-field="facing" data-val="${c}" aria-pressed="${d.adv.facing.includes(c)}">${c}<span class="n">${fac[c] || 0}</span></button>` : `<span class="compass-c">${icon('target', 14)}</span>`).join('')}</div></div>
          <div class="adv-field"><div class="lbl">Read <span class="sub">The side of the road the sign faces drivers on</span></div>${pills(d, 'read', ATTR.read)}</div>
        </section>
        <section><h3>Audience</h3>
          <div class="adv-field"><div class="lbl">Impressions, at least</div>
            <div class="pills">${[null, 0.5e6, 1e6, 1.5e6, 2e6, 2.5e6].map((m) => `<button class="pill-opt ${d.adv.minImpressions === m ? 'is-on' : ''}" data-act="adv-min" data-val="${m ?? ''}">${m ? `${(m / 1e6).toFixed(1)}M` : 'Any'}</button>`).join('')}</div>
            <div class="t-caption" style="font-weight:400;margin-top:6px">Listings with no impressions on file are hidden by this filter.</div></div>
        </section>
        <section><h3>Content rules</h3>
          <div class="adv-field"><div class="lbl">Accepts <span class="sub">Hide signs whose owner turns these categories down</span></div>${pills(d, 'accepts', ATTR.restrictions)}</div>
        </section>
        <section><h3>${TERMS.owner} and state</h3>
          <div class="adv-field"><div class="lbl">Show listings from</div>
            ${OWNERS.map((o) => `<label class="checkbox adv-check"><input type="checkbox" data-act="adv-owner" data-id="${o.id}" ${d.ex.includes(o.id) ? '' : 'checked'}>${esc(o.name)}<span class="n">${ownerF[o.id] || 0}</span></label>`).join('')}</div>
          <div class="adv-field"><label class="checkbox adv-check"><input type="checkbox" data-act="adv-avail" ${d.avail ? 'checked' : ''}>Available only (not on hold)</label></div>
        </section>
      </div>
      ${v.advConfirm ? `<div class="adv-confirm" role="alert">${icon('alert', 16)}<span>These changes aren't applied yet.</span><button class="btn neutral sm" data-act="adv-discard">Discard</button></div>` : ''}
      <div class="adv-foot">
        <button class="btn tertiary" data-act="adv-clear" ${draftCount ? '' : 'disabled'}>Clear all</button>
        <button class="btn primary" data-act="adv-apply">Show ${plural(n, TERMS.listing, TERMS.listings)}${cov ? ` · ${cov.filter((c) => c.covered).length} of ${cov.length} ${TERMS.stores} covered` : ''}</button>
      </div>
    </aside>`;
}
function advDirty() {
  const d = app.view.advDraft, st = S();
  if (!d) return false;
  return JSON.stringify(d.adv) !== JSON.stringify(st.adv || emptyAdv()) || JSON.stringify([...d.ex].sort()) !== JSON.stringify([...st.excludeOwnerIds].sort()) || d.avail !== st.availableOnly;
}
// Closing with unapplied changes asks first instead of throwing them away.
function closeAdv() {
  if (advDirty() && !app.view.advConfirm) { app.view.advConfirm = true; renderAdv(); return; }
  app.view.advOpen = false; app.view.advConfirm = false; renderAdv();
}
function applyAdv() {
  app.view.advConfirm = false;
  const d = app.view.advDraft;
  app.view.advOpen = false;
  const n = advCount(d.adv) + (d.ex.length ? 1 : 0) + (d.avail ? 1 : 0);
  controlAction({ type: 'setFilters', adv: d.adv, excludeOwnerIds: d.ex, availableOnly: d.avail }, n ? `${plural(n, 'filter', 'filters')} applied` : 'Filters cleared');
  renderAdv();
}

// ---------- Popovers (chip menus) ----------
function renderPopover() {
  const host = $('#popover-root');
  if (!host) return;
  const v = app.view;
  if (!v.popover) { host.innerHTML = ''; return; }
  const anchor = document.querySelector(`#ws-header [data-pop="${v.popover}"], .toolbar [data-pop="${v.popover}"], .stats [data-pop="${v.popover}"], #receipt [data-pop="${v.popover}"], #summary-panel [data-pop="${v.popover}"]`) || (v.popover.startsWith('brief-') ? document.querySelector('[data-pop="brief-all"]') : null) || document.querySelector(`[data-pop="${v.popover}"]`);
  if (!anchor) { v.popover = null; host.innerHTML = ''; return; }
  const r = anchor.getBoundingClientRect();
  const s = S();
  let items = '';
  const item = (label, act, data, on) => `<button class="menu-item" data-act="${act}" ${Object.entries(data).map(([k, val]) => `data-${k}="${esc(val)}"`).join(' ')}>${label}${on ? `<span class="check">${icon('check', 16)}</span>` : ''}</button>`;
  if (v.popover === 'radius') items = `<div class="radius-ctl">${radiusControl('menu')}</div><div class="nav-divider" style="margin:2px 4px 5px"></div>`
    + [0.5, 1, 2, 5, 10, 25].map((m) => item(`Within ${milesLabel(m)}`, 'set-radius', { miles: m }, s.radiusMiles === m && !Object.keys(s.radiusOverrides).length)).join('');
  if (v.popover === 'brief-all') { host.innerHTML = briefAllPopover(r); return; }
  if (v.popover?.startsWith('brief-')) {
    const k = v.popover.slice(6);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 300));
    let body = '';
    if (k === 'client') body = `<label class="field-label" for="brief-client">Client</label><div class="field"><input id="brief-client" value="${esc(app.proposal.client || '')}" placeholder="Agency or brand"></div>`;
    if (k === 'flight') body = `${app.brief.flightEstimated ? `<p class="t-caption" style="font-weight:400;margin:0 0 8px"><span class="est-tag">Est.</span>Estimated. Change them if the client has exact dates.</p>` : ''}
      <div class="p-fields" style="margin:0"><div><label class="field-label" for="brief-start">Starts</label><div class="field"><input type="date" id="brief-start" value="${esc(app.quote.start)}"></div></div>
      <div><label class="field-label" for="brief-end">Ends</label><div class="field"><input type="date" id="brief-end" value="${esc(app.quote.end)}"></div></div></div>`;
    if (k === 'budget') body = `${app.brief.budgetNote ? `<p class="t-caption" style="font-weight:400;margin:0 0 8px">The request said "${esc(app.brief.budgetNote)}".</p>` : ''}
      <label class="field-label" for="brief-budget">Client budget</label><div class="field"><span class="muted">$</span><input id="brief-budget" inputmode="decimal" value="${esc(app.quote.budget)}" placeholder="For example 150k"></div>
      <label class="checkbox" style="margin-top:8px;font-size:13px"><input type="checkbox" id="brief-rough" ${app.brief.budgetRough ? 'checked' : ''}>It's a rough number</label>`;
    host.innerHTML = `<div class="menu brief-pop" style="position:fixed;left:${left}px;top:${r.bottom + 6}px;width:${k === 'flight' ? 300 : 260}px" role="dialog" aria-label="Edit ${k}">
      <div style="padding:8px 8px 4px">${body}</div>
      <div class="cols-foot"><button class="btn tertiary sm" data-act="brief-clear" data-k="${k}">Clear</button><button class="btn primary sm" data-act="brief-apply" data-k="${k}">Apply</button></div></div>`;
    host.querySelector('input')?.focus();
    return;
  }
  if (v.popover === 'columns') {
    const on = app.columns || DEFAULT_COLUMNS;
    const groups = [['Shown by default', LIST_COLUMNS.filter((c) => c.def)], ...['Placement', 'Direction', 'Where', 'Content and hours'].map((g) => [g, LIST_COLUMNS.filter((c) => c.group === g)])];
    const left = Math.max(8, Math.min(r.right - 280, window.innerWidth - 296));
    host.innerHTML = `<div class="menu cols-menu" style="position:fixed;left:${left}px;top:${r.bottom + 6}px;width:280px" role="dialog" aria-label="Columns">
      <div class="menu-label">${TERMS.Listing} is always shown</div>
      ${groups.map(([g, cs]) => `<div class="menu-label">${g}</div>${cs.map((col) => `<label class="checkbox adv-check col-opt"><input type="checkbox" data-act="col-toggle" data-key="${col.key}" ${on.includes(col.key) ? 'checked' : ''}>${col.label}${col.hint ? `<span class="n">${col.hint}</span>` : ''}</label>`).join('')}`).join('')}
      <div class="cols-foot"><span class="t-caption" style="font-weight:400">Wide tables scroll sideways.</span><button class="btn tertiary sm" data-act="col-reset">Reset</button></div>
    </div>`;
    return;
  }
  if (v.popover === 'tray') {
    const ids = s.proposalIds;
    const rows = ids.map((id) => LISTINGS.find((l) => l.id === id)).filter(Boolean);
    const total = rows.reduce((sum, l) => sum + (l.impressions || 0), 0);
    const missing = rows.filter((l) => l.impressions == null).length;
    const left = Math.max(8, Math.min(r.right - 360, window.innerWidth - 376));
    host.innerHTML = `<div class="menu tray" style="position:fixed;left:${left}px;top:${r.bottom + 6}px;width:360px" role="dialog" aria-label="In this proposal">
      <div class="tray-head"><span class="t-body-m">In this ${TERMS.proposal}</span><span class="t-caption">${plural(rows.length, TERMS.listing, TERMS.listings)}</span></div>
      ${rows.length ? `<div class="tray-list">${rows.map((l) => `<div class="tray-row"><div><div class="t-body-m" style="font-size:13px">${esc(l.name)}</div><div class="t-caption" style="font-weight:400">${esc(l.id)} · ${esc(l.owner.name)} · ${impressions(l.impressions)}</div></div>
        <button class="icon-btn" data-act="tray-remove" data-id="${esc(l.id)}" aria-label="Remove ${esc(l.name)}">${icon('x', 14)}</button></div>`).join('')}</div>
        <div class="tray-foot"><span class="t-caption">${impressions(total)} impressions${missing ? ` (${missing} without data)` : ''}</span></div>`
      : `<div class="tray-empty">${icon('fileText', 18)}<p>Nothing added yet. Use <strong>Add</strong> on a ${TERMS.listing} in the list.</p></div>`}
    </div>`;
    return;
  }
  if (v.popover === 'radius') { host.innerHTML = `<div class="menu" style="position:fixed;left:${r.left}px;top:${r.bottom + 6}px;width:260px">${items}</div>`; return; }
  if (v.popover === 'sort') items = ['distance', 'impressions', 'owner'].map((k) => item(sortLabel(k), 'set-sort', { key: k }, s.sort.key === k)).join('')
    + `<div class="nav-divider" style="margin:5px 4px"></div><div class="menu-label">Order</div>`
    + ['asc', 'desc'].map((d) => item(`${icon(d === 'asc' ? 'arrowUp' : 'arrowDown', 14)}${dirWord(s.sort.key, d).replace(/^./, (x) => x.toUpperCase())}`, 'set-sort-dir', { dir: d }, s.sort.direction === d)).join('');
  if (v.popover === 'owners') items = `<div class="menu-label">Show listings from</div>${OWNERS.map((o) => item(o.name, 'toggle-owner', { id: o.id }, !s.excludeOwnerIds.includes(o.id))).join('')}
    <div class="nav-divider" style="margin:5px 4px"></div><div class="menu-label">State</div>${item('Available only', 'toggle-available', {}, s.availableOnly)}`;
  if (v.popover === 'tag') items = ['all', ...allTags()].map((t) => item(t === 'all' ? 'All tags' : esc(t), 'set-tag', { tag: t }, v.tagFilter === t)).join('');
  if (v.popover === 'coverage') items = [['all', 'All'], ['covered', 'Covered'], ['none', 'No coverage']].map(([k, l]) => item(l, 'set-coverage', { cov: k }, v.coverageFilter === k)).join('');
  host.innerHTML = `<div class="menu" style="position:fixed;left:${r.left}px;top:${r.bottom + 6}px">${items}</div>`;
}

// ---------- CSV dialog ----------
function openCsvDialog(file) {
  app.dialog = { step: 'upload', fileName: null, rows: [], columns: [], mapping: {}, results: [], tagAll: '', useTagCol: true, drag: false, resolutions: {} };
  if (file) loadCsv(file.name, file.text);
  renderDialog();
}
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const clean = rows.filter((r) => r.some((x) => x.trim()));
  const head = (clean.shift() || []).map((h) => h.trim());
  return { columns: head, rows: clean.slice(0, 500).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()]))) };
}
function loadCsv(name, text) {
  const d = app.dialog;
  const { columns, rows } = parseCsv(text);
  d.fileName = name; d.columns = columns; d.rows = rows; d.step = 'map';
  const find = (re) => columns.find((c) => re.test(c)) || '';
  d.mapping = { address: find(/address|street|addr/i), name: find(/name|store|location/i), tag: find(/region|tag|group|area|district/i), city: find(/city|town/i) };
  d.tagAll = name === SAMPLE_CSV_NAME ? 'Brightline retail' : '';
  geocodeDialog();
}
function geocodeDialog() {
  const d = app.dialog;
  d.resolutions = {};
  if (!d.mapping.address) { d.results = []; return; }
  d.results = geocodeMany(d.rows.map((r) => ({ address: r[d.mapping.address] || '', city: d.mapping.city ? r[d.mapping.city] : '' })));
}
function dialogCounts() {
  const d = app.dialog;
  let found = 0, review = 0, skipped = 0, fixed = 0;
  d.results.forEach((g, i) => {
    const res = d.resolutions[i];
    if (g.status === 'found') found++;
    else if (res?.type === 'accept') fixed++;
    else if (res?.type === 'skip') skipped++;
    else review++;
  });
  return { found, review, skipped, fixed, total: d.rows.length, add: found + fixed };
}

function renderDialog() {
  let host = $('#dialog-root');
  if (!host) { host = document.createElement('div'); host.id = 'dialog-root'; document.body.appendChild(host); }
  const d = app.dialog;
  if (!d) { host.innerHTML = ''; return; }
  const c = d.step === 'map' ? dialogCounts() : null;
  const stepState = (n) => (d.step === 'upload' ? (n === 1 ? 'is-current' : '') : n === 1 ? 'is-done' : n === 2 ? (c.review ? 'is-current' : 'is-done') : (c.review ? '' : 'is-current'));
  const steps = `<div class="steps">${(d.source === 'paste' ? ['Paste', 'Find on the map', 'Review and tag'] : ['Upload', 'Match columns', 'Review and tag']).map((l, i) => `<span class="step ${stepState(i + 1)}"><span class="n">${stepState(i + 1) === 'is-done' ? icon('check', 12) : i + 1}</span>${l}</span>`).join('')}</div>`;
  let body = '';
  if (d.step === 'upload') {
    body = `${steps}
      <div class="dropzone big ${d.drag ? 'is-drag' : ''}" id="dropzone">
        ${icon('upload', 20)}
        <div class="fname">Drop a CSV of addresses here</div>
        <div class="sub">One row per place. Include a street address and a city if you have it. Names and tags are optional.</div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn neutral sm" data-act="csv-choose">Choose a file</button>
          <button class="btn tertiary sm" data-act="csv-sample">Use sample ${SAMPLE_CSV_NAME}</button>
        </div>
        <input type="file" id="csv-file" accept=".csv,text/csv" hidden>
      </div>`;
  } else {
    const opt = (cur, allowNone) => `${allowNone ? `<option value="" ${!cur ? 'selected' : ''}>None</option>` : ''}${d.columns.map((col) => `<option ${col === cur ? 'selected' : ''}>${esc(col)}</option>`).join('')}`;
    const banner = !d.mapping.address
      ? `<div class="banner error">${icon('alert', 16)}<div><strong>Pick the address column</strong><p>We need a street address to find each place.</p></div></div>`
      : c.review
        ? `<div class="banner warning">${icon('alert', 16)}<div><strong>${c.found + c.fixed} of ${c.total} addresses found</strong><p>${c.review} need a closer look. Fix them below or skip them. Nothing is added until you confirm.</p></div></div>`
        : `<div class="banner info">${icon('check', 16)}<div><strong>${c.add} of ${c.total} addresses ready</strong><p>${c.skipped ? `${c.skipped} skipped. ` : ''}Nothing is added until you confirm.</p></div></div>`;
    body = `${steps}
      ${d.source === 'retry'
        ? `<div class="dropzone">${icon('alert', 20)}<div class="fname">${plural(c.total, 'address', 'addresses')} left out last time</div><div class="sub">Pick a match or skip. The rest of your list is already added.</div></div>`
        : d.source === 'paste'
        ? `<div class="dropzone">${icon('list', 20)}<div class="fname">Pasted addresses</div><div class="sub">${plural(c.total, 'address', 'addresses')}. ${c.found} matched. <button class="link" style="font-size:12px" data-act="bulk-edit">Edit the list</button></div></div>`
        : `<div class="dropzone">${icon('file', 20)}<div class="fname">${esc(d.fileName)}</div><div class="sub">${c.total} rows, ${d.columns.length} columns. ${c.found} addresses matched. <button class="link" style="font-size:12px" data-act="csv-replace">Replace file</button></div></div>`}
      <div class="map-cols" ${d.source === 'paste' || d.source === 'retry' ? 'hidden' : ''}>
        <div><label class="field-label" for="map-address">Address column</label><div class="select-wrap"><select class="select" id="map-address" data-map="address">${opt(d.mapping.address, true)}</select>${icon('chevronDown', 16)}</div></div>
        <div><label class="field-label" for="map-name">Name column</label><div class="select-wrap"><select class="select" id="map-name" data-map="name">${opt(d.mapping.name, true)}</select>${icon('chevronDown', 16)}</div></div>
        <div><label class="field-label" for="map-tag">Tag column</label><div class="select-wrap"><select class="select" id="map-tag" data-map="tag">${opt(d.mapping.tag, true)}</select>${icon('chevronDown', 16)}</div></div>
      </div>
      ${d.mapping.city ? `<div class="t-caption" style="margin-top:-6px">City comes from the <strong>${esc(d.mapping.city)}</strong> column.</div>` : ''}
      ${banner}
      ${d.mapping.address ? `<div class="preview"><table class="grid">
        <thead><tr>${d.source === 'paste' ? '' : '<th>Name</th>'}<th>Address</th>${d.source === 'paste' ? '' : '<th>Tag</th>'}<th>Match</th></tr></thead>
        <tbody>${d.rows.map((row, i) => dialogRow(row, i)).join('')}</tbody>
      </table></div>` : ''}
      <div class="tag-all">
        <div class="f"><label class="field-label" for="tag-all">Tag every place with</label><div class="field"><input id="tag-all" value="${esc(d.tagAll)}" placeholder="For example, Spring stores"></div></div>
        ${d.mapping.tag ? `<label class="checkbox" style="padding-bottom:8px"><input type="checkbox" id="use-tag-col" ${d.useTagCol ? 'checked' : ''}>Also use the ${esc(d.mapping.tag)} column as a tag</label>` : ''}
      </div>`;
  }
  host.innerHTML = `
    <div class="scrim" data-act="dialog-scrim">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
        <div class="dialog-head"><div><h2 class="t-title" id="dlg-title">Add ${TERMS.locations} from a list</h2><p>We find each address on Google Maps, so you never type latitude or longitude.</p></div>
          <button class="icon-btn" data-act="dialog-close" aria-label="Close">${icon('x', 18)}</button></div>
        <div class="dialog-body">${body}</div>
        <div class="dialog-foot">
          <span class="t-caption" style="font-weight:400">Matched with Google Places. Nothing is saved until you add.</span>
          <div class="actions"><button class="btn tertiary" data-act="dialog-close">Cancel</button>
          <button class="btn primary lg" data-act="csv-commit" ${!c || !c.add ? 'disabled' : ''}>Add ${c ? plural(c.add, TERMS.location, TERMS.locations) : TERMS.locations}</button></div>
        </div>
      </div>
    </div>`;
  bindDialog();
}

function dialogRow(row, i) {
  const d = app.dialog;
  const g = d.results[i];
  const res = d.resolutions[i];
  const name = d.mapping.name ? row[d.mapping.name] : '';
  const addr = [row[d.mapping.address], d.mapping.city ? row[d.mapping.city] : ''].filter(Boolean).join(', ');
  const tag = d.mapping.tag ? row[d.mapping.tag] : '';
  let match;
  if (g.status === 'found') match = '<span class="pill success">Found</span>';
  else if (res?.type === 'accept') match = `<span class="pill success">Found</span><div class="review-hint">Using ${esc(g.suggestions[res.choice].label)} · <button class="link" data-act="row-reset" data-i="${i}">Change</button></div>`;
  else if (res?.type === 'skip') match = `<span class="pill" style="color:var(--text-secondary);border-color:var(--border-strong)">Skipped</span><div class="review-hint"><button class="link" data-act="row-reset" data-i="${i}">Undo</button></div>`;
  else if (g.status === 'review') {
    const s = g.suggestions;
    const hint = g.reason === 'missing_city' ? 'Add a city, or pick a match' : `Did you mean ${esc(s[0].label)}?`;
    match = `<span class="pill warning">Needs review</span><div class="review-hint">${hint}</div>
      <div class="review-hint">${s.length > 1 || g.reason === 'missing_city' ? `<select class="mini-select" id="sel-${i}" aria-label="Pick a match">${s.map((x, k) => `<option value="${k}">${esc(x.label)}</option>`).join('')}</select>` : ''}
        <button class="link" data-act="row-accept" data-i="${i}">${s.length > 1 || g.reason === 'missing_city' ? 'Use' : 'Use this'}</button> · <button class="link" data-act="row-skip" data-i="${i}">Skip</button></div>`;
  } else match = `<span class="pill warning">Not found</span><div class="review-hint">${d.source === 'paste' ? 'Check the spelling, or add a city.' : 'Check the address in the file, or skip it.'} · <button class="link" data-act="row-skip" data-i="${i}">Skip</button></div>`;
  if (d.source === 'paste') return `<tr><td class="name" style="font-size:13px">${esc(addr || '—')}</td><td>${match}</td></tr>`;
  return `<tr><td class="name" style="font-size:13px">${esc(name || '—')}</td><td>${esc(addr || '—')}</td><td>${tag ? `<span class="tag">${esc(tag)}</span>` : ''}</td><td>${match}</td></tr>`;
}

function bindDialog() {
  const d = app.dialog;
  const dz = $('#dropzone');
  if (dz) {
    dz.addEventListener('dragover', (e) => { e.preventDefault(); if (!d.drag) { d.drag = true; dz.classList.add('is-drag'); } });
    dz.addEventListener('dragleave', () => { d.drag = false; dz.classList.remove('is-drag'); });
    dz.addEventListener('drop', async (e) => {
      e.preventDefault(); d.drag = false;
      const f = e.dataTransfer.files[0];
      if (f) { loadCsv(f.name, await f.text()); renderDialog(); }
    });
    $('#csv-file').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (f) { loadCsv(f.name, await f.text()); renderDialog(); }
    });
  }
  document.querySelectorAll('[data-map]').forEach((sel) => sel.addEventListener('change', () => { d.mapping[sel.dataset.map] = sel.value; geocodeDialog(); renderDialog(); }));
  const ta = $('#tag-all');
  if (ta) ta.addEventListener('input', () => { d.tagAll = ta.value; });
  const cb = $('#use-tag-col');
  if (cb) cb.addEventListener('change', () => { d.useTagCol = cb.checked; });
}

function commitCsv() {
  const d = app.dialog;
  const c = dialogCounts();
  const locations = [];
  d.rows.forEach((row, i) => {
    const g = d.results[i];
    const res = d.resolutions[i];
    let position = null, address = '';
    if (g.status === 'found') { position = g.position; address = g.matched; }
    else if (res?.type === 'accept') { position = g.suggestions[res.choice].position; address = g.suggestions[res.choice].label; }
    if (!position) return;
    const name = (d.mapping.name && row[d.mapping.name]) || row[d.mapping.address];
    const tags = [d.tagAll.trim(), d.useTagCol && d.mapping.tag ? row[d.mapping.tag] : ''].filter(Boolean);
    // Same address = same location, so adding a list twice never duplicates a store.
    const pid = `store-${String(address || name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    locations.push({ id: `loc-${pid}`, place: { placeId: pid, name, address, category: 'Store', area: '', position }, role: 'client_location', tags, name });
  });
  const fileName = d.fileName;
  const userLine = d.source === 'paste' ? `Pasted ${plural(c.total, 'address', 'addresses')}.` : d.source === 'retry' ? `Reviewed ${plural(c.total, 'skipped address', 'skipped addresses')}.` : `Uploaded ${fileName} (${c.total} addresses).`;
  const total = c.total;
  const skipped = c.total - c.add;
  // Keep the rows that were not added, so "N need review" can reopen them.
  const leftover = [];
  d.rows.forEach((row, i) => {
    const g = d.results[i], res = d.resolutions[i];
    if (g.status === 'found' || res?.type === 'accept') return;
    leftover.push({ name: (d.mapping.name && row[d.mapping.name]) || '', address: [row[d.mapping.address], d.mapping.city ? row[d.mapping.city] : ''].filter(Boolean).join(', '), tag: d.mapping.tag ? row[d.mapping.tag] : '' });
  });
  const prevRows = d.source === 'retry' ? [] : (app.csvSummary?.skippedRows || []);
  const skippedRows = [...prevRows, ...leftover];
  app.dialog = null;
  app.csvSummary = { added: (app.csvSummary?.added || 0) + locations.length, skipped: skippedRows.length, skippedRows, tagAll: d.tagAll.trim() || app.csvSummary?.tagAll || '' };
  if (app.sim.inventoryError) {
    pushMsg({ kind: 'user', text: userLine });
    pushMsg({ kind: 'agent', text: 'The addresses are matched, but listings could not load, so nothing was added yet. Your file is kept. Try again in a moment.' });
    app.view.error = true;
    renderWorkspace();
    return;
  }
  const res = dispatch({ type: 'addLocations', locations }, { source: 'chat' });
  app.view.tab = 'locations';
  app.view.coverageFilter = 'all';
  app.view.tagFilter = 'all';
  if (app.proposal.title === 'New proposal') app.proposal.title = `${d.tagAll.trim() || (d.source === 'paste' ? 'Client' : fileName.replace(/\.csv$/i, ''))}, ${plural(locations.length, TERMS.store, TERMS.stores)}`;
  pushMsg({ kind: 'user', text: userLine });
  if (res) {
    const after = res.after;
    const cov = coverageByLocation(LISTINGS, after);
    const covered = cov.filter((x) => x.covered).length;
    const gaps = cov.length - covered;
    pushMsg({ kind: 'agent', text: `Added ${plural(locations.length, TERMS.location, TERMS.locations)}.${skipped ? ` ${skipped} need a second look, so I left them out for now.` : ''}` });
    pushMsg({ kind: 'summary', rows: [[`${TERMS.Locations} added`, locations.length], [`${TERMS.Listings} within ${milesLabel(after.radiusMiles)}`, searchListings(LISTINGS, after).length], [`${TERMS.stores[0].toUpperCase()}${TERMS.stores.slice(1)} covered`, `${covered} of ${cov.length}`]] });
    if (gaps) {
      pushMsg({ kind: 'agent', text: `${plural(gaps, 'store has', 'stores have')} no listing within ${milesLabel(after.radiusMiles)}. They are outlined in amber on the map. What should I do?` });
      pushMsg({ kind: 'quick', replies: [`Expand to ${after.radiusMiles + 1} miles for the ${gaps} gaps`, 'Best listing for each store', 'Show only stores without coverage'] });
    } else {
      pushMsg({ kind: 'agent', text: 'Every store has at least one listing nearby.' });
    }
    simulateLoad(800);
  }
  renderWorkspace();
}

// ---------- Toasts ----------
function toast(text, ms = 2600, action = null) {
  const t = { id: ++msgSeq, text, action };
  app.toasts.push(t);
  renderToasts();
  setTimeout(() => { app.toasts = app.toasts.filter((x) => x !== t); renderToasts(); }, ms);
}
function renderToasts() {
  let host = $('#toast-root');
  if (!host) { host = document.createElement('div'); host.id = 'toast-root'; host.className = 'toasts'; document.body.appendChild(host); }
  host.innerHTML = app.toasts.map((t) => `<div class="toast" role="status">${esc(t.text)}${t.action ? `<button data-act="${t.action.act}" data-toast="${t.id}">${esc(t.action.label)}</button>` : ''}</div>`).join('');
}

// ---------- Attach ----------
async function onAttach(e) {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const text = await f.text();
  if (/\.csv$/i.test(f.name)) { openCsvDialog({ name: f.name, text }); return; }
  send(text.slice(0, 4000)); // treated as pasted text: data, never instructions
}

// ========== Build the proposal: review → export → email ==========
// Modeled on the Core flow frames 6–8 (Figma IDEATION 55:1097, 56:883, 56:1126), in the 11.4.26 style and vocabulary.
// Quote and floor are internal. Exports read only the allow-list in domain.exportRows.
app.quote = { cpm: null, start: '', end: '', budget: '' };
app.exportSel = { sheet: true, deck: true, email: true };
app.previewTab = 'sheet';
app.email = null;          // { subject, body, edited }
app.stage = 'draft';       // hook for stages; win/loss stays pinned

const money = (n, dp = 0) => n == null ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
function fmtDate(v) { const t = Date.parse(v); return t ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : ''; }
function flightText() { return app.quote.start && app.quote.end ? `${fmtDate(app.quote.start)} – ${fmtDate(app.quote.end)}` : ''; }
function plan() { return calculatePlan(LISTINGS, S().proposalIds, app.quote); }
function clientName() { return app.proposal.client || 'the client'; }
function nearText() {
  const s = S();
  const ps = pois(), st = stores();
  if (ps.length === 1 && !st.length) return `${ps[0].place.name} · within ${milesLabel(s.radiusMiles)}`;
  if (st.length) return `${plural(st.length, 'client location', 'client locations')} · within ${milesLabel(s.radiusMiles)}`;
  return ps.length ? `${plural(ps.length, 'place', 'places')} · within ${milesLabel(s.radiusMiles)}` : '—';
}
function mixOf(lines) {
  const by = {};
  lines.forEach(({ listing: l }) => (by[l.media] = (by[l.media] || 0) + 1));
  return Object.entries(by).sort((a, b) => b[1] - a[1]);
}
function sizesNeeded(lines) {
  const by = {};
  lines.forEach(({ listing: l }) => (by[l.px] = (by[l.px] || 0) + 1));
  return Object.entries(by).sort((a, b) => b[1] - a[1]);
}

function openProposal(step) {
  if (!S().proposalIds.length) { toast(`Add ${TERMS.listings} first.`); return; }
  if (step === 'review') {
    // The proposal is a mode of the workspace now, so the chat stays alongside it.
    app.screen = 'workspace';
    if (!$('#messages')) workspaceShell();
    setMode('proposal');
    return;
  }
  app.screen = 'proposal';
  app.pstep = step;
  app.view.popover = null;
  mapPort = null;
  render();
}

function flowSteps(current) {
  const steps = [['find', 'Find listings'], ['review', TERMS.Proposal], ['export', 'Export'], ['email', 'Email']];
  const idx = steps.findIndex(([k]) => k === current);
  return `<ol class="flow-steps" aria-label="Proposal steps">${steps.map(([k, l], i) => `<li class="${i < idx ? 'is-done' : i === idx ? 'is-current' : ''}" ${i === idx ? 'aria-current="step"' : ''}>
    ${i < idx ? `<button data-act="flow-go" data-step="${k}">${icon('check', 12)}${l}</button>` : `<span>${i === idx ? '' : ''}${l}</span>`}</li>`).join('<li class="sep" aria-hidden="true">›</li>')}</ol>`;
}

function proposalHeader({ crumb, title, sub, actions }) {
  return `<header class="page-header ws-like">
    <div class="hdr-top">
      <div>
        <div class="crumbs"><button data-act="go-home">${TERMS.proposals}</button><span>›</span><span>${esc(app.proposal.client || 'New')}</span>${crumb ? `<span>›</span><span>${crumb}</span>` : ''}</div>
        <div class="title-row"><h1 class="t-title">${esc(title)}</h1></div>
        ${sub ? `<p class="ph-sub">${sub}</p>` : ''}
      </div>
      <div class="actions">${actions || ''}</div>
    </div>
    <div class="hdr-sub">${stepTabs()}</div>
  </header>`;
}

function renderProposal() {
  const step = app.pstep;
  root.innerHTML = `<div class="app">${navHtml()}<main class="content" id="p-main"></main></div><div id="popover-root"></div>`;
  if (step === 'review') renderReview();
  else if (step === 'export') renderExport();
  else renderEmailStep();
}

// ---------- 1. Review and quote ----------
function quoteFlagText(f, pl) {
  if (f.key === 'below-floor') return [`Below the floor of ${money(pl.floor, 2)} CPM`, 'A manager reviews this quote before it goes out. You can still export a draft.'];
  if (f.key === 'deep-discount') return ['More than 20% under the suggested CPM', `Suggested is ${money(pl.suggested, 2)}. Check this is on purpose.`];
  if (f.key === 'over-budget') return [`${money(f.amount)} over the budget`, 'Lower the CPM, shorten the flight, or remove listings.'];
  if (f.key === 'missing-impressions') return [`${plural(f.count, 'listing has', 'listings have')} no impressions on file`, 'They add nothing to the totals.'];
  if (f.key === 'no-dates') return ['No flight dates yet', 'Totals assume 4 weeks until you set dates.'];
  return [f.key, ''];
}
function renderReview() {
  const s = S();
  const pl = plan();
  const ex = s.excludeOwnerIds.map((id) => ownerById[id].name);
  const flags = pl.flags.map((f) => { const [h, b] = quoteFlagText(f, pl); return `<div class="banner ${f.level === 'review' ? 'error' : f.level === 'warn' ? 'warning' : 'info'} q-flag">${icon(f.level === 'info' ? 'info' : 'alert', 16)}<div><strong>${h}</strong><p>${b}</p></div></div>`; }).join('');
  $('#p-main').innerHTML = `
    ${proposalHeader({ back: 'find', backLabel: `Back to ${TERMS.listings}`, crumb: TERMS.Proposal, title: app.proposal.title, actions: `<button class="btn neutral" data-act="flow-go" data-step="find">${icon('plus', 16)}Add more ${TERMS.listings}</button>` })}
    <div class="body p-body">
      <section class="panel p-left" aria-label="Proposal summary">
        <div class="p-scroll">
          <div class="p-sec"><h2 class="t-heading">Details</h2>
            <dl class="kvs"><dt>Client</dt><dd>${esc(app.proposal.client || '—')}</dd><dt>Near</dt><dd>${esc(nearText())}</dd><dt>Excludes</dt><dd>${ex.length ? esc(ex.join(', ')) : 'None'}</dd></dl>
            <div class="p-fields">
              <div><label class="field-label" for="q-start">Flight starts</label><div class="field"><input type="date" id="q-start" data-q="start" value="${esc(app.quote.start)}"></div></div>
              <div><label class="field-label" for="q-end">Flight ends</label><div class="field"><input type="date" id="q-end" data-q="end" value="${esc(app.quote.end)}"></div></div>
              <div class="span2"><label class="field-label" for="q-budget">Client budget</label><div class="field"><span class="muted">$</span><input id="q-budget" data-q="budget" inputmode="decimal" placeholder="Not given yet" value="${esc(app.quote.budget)}"></div></div>
            </div>
          </div>
          <div class="p-sec"><div class="p-sec-head"><h2 class="t-heading">${TERMS.Listings}</h2><span class="tag">${pl.lines.length}</span></div>
            <dl class="kvs">${mixOf(pl.lines).map(([m, n]) => `<dt>${esc(m)}</dt><dd>${plural(n, TERMS.listing, TERMS.listings)}</dd>`).join('')}</dl>
            <div class="t-caption" style="margin:10px 0 6px">Creative sizes needed</div>
            <div class="chips-row">${sizesNeeded(pl.lines).map(([px, n]) => `<span class="tag">${esc(px)} ×${n}</span>`).join('')}</div>
          </div>
          <div class="p-sec q-sec"><div class="p-sec-head"><h2 class="t-heading">Quote</h2><span class="lock">${icon('alert', 12)}Internal only</span></div>
            <p class="t-caption" style="font-weight:400;margin:0 0 10px">Floor and suggested CPM never appear in an export.</p>
            <dl class="kvs"><dt>Floor CPM <span class="sub">weighted by impressions</span></dt><dd>${money(pl.floor, 2)}</dd>
              <dt>Suggested CPM <span class="sub">35% over floor</span></dt><dd>${money(pl.suggested, 2)}</dd></dl>
            <label class="field-label" for="q-cpm" style="margin-top:10px">Quoted CPM</label>
            <div class="field q-cpm ${pl.flags.some((f) => f.key === 'below-floor') ? 'is-flag' : ''}"><span class="muted">$</span><input id="q-cpm" data-q="cpm" inputmode="decimal" value="${app.quote.cpm != null ? app.quote.cpm : pl.suggested.toFixed(2)}" aria-describedby="q-help"></div>
            <div class="t-caption" id="q-help" style="font-weight:400;margin-top:6px">${app.quote.cpm == null ? 'Using the suggested CPM.' : `<button class="link" style="font-size:12px" data-act="q-reset">Use suggested ${money(pl.suggested, 2)}</button>`}</div>
            <dl class="kvs totals"><dt>Projected impressions</dt><dd>${impressions(pl.impressions)}</dd>
              <dt>Flight</dt><dd>${pl.weeks ? `${pl.weeks} weeks` : '4 weeks (assumed)'}</dd>
              <dt class="big">Estimated total</dt><dd class="big">${money(pl.total)}</dd>
              ${pl.budget ? `<dt>Budget</dt><dd>${money(pl.budget)}</dd>` : ''}</dl>
            ${flags}
          </div>
        </div>
        <div class="p-foot"><button class="btn primary lg" style="width:100%" data-act="flow-go" data-step="export">Continue to export ${icon('arrowRight', 16)}</button></div>
      </section>
      <section class="panel p-right" aria-label="${TERMS.Listings} in this proposal">
        <div class="panel-head"><span class="t-heading">${TERMS.Listings} in this ${TERMS.proposal}</span><div class="head-right">${columnsButton()}</div></div>
        <div class="p-map" id="p-map"></div>
        <div class="list-scroll">${reviewTable(pl)}</div>
        <div class="list-foot"><span>${plural(pl.lines.length, TERMS.listing, TERMS.listings)} · ${impressions(pl.impressions)} impressions · ${money(pl.total)} at ${money(pl.cpm, 2)} CPM</span></div>
      </section>
    </div>`;
  // Mini map: the proposal's listings and the places they're near.
  const mp = createMapPort($('#p-map'), { streets: app.sim.streets });
  mp.render({ anchors: s.anchors, results: pl.lines.map(({ listing }) => ({ listing, distanceMiles: 0, isNew: false })), coverage: [], mode: 'listings', proposalIds: s.proposalIds,
    radiusFor: (id) => effectiveRadius(s, id), overrides: {}, prevRadius: null, selectedLocationId: null, preview: null, fit: true, showRingLabels: false });
}
function reviewTable(pl) {
  const cols = visibleColumns().filter((c) => !['distance', 'status', 'impressions'].includes(c.key));
  return `<table class="grid sticky-grid is-wide">
    <thead><tr><th class="stick-l0 p-l0">${TERMS.Listing}</th>${cols.map((c) => `<th class="${c.num ? 'num' : ''}">${c.label}</th>`).join('')}
      <th class="num">Impressions <span class="sub-th">over the flight</span></th>${app.hideInternal ? '' : `<th class="num internal-th" title="Internal only">${icon('alert', 12)}Floor CPM</th>`}<th class="num">Est. cost</th><th class="stick-r"><span class="sr-only">Remove</span></th></tr></thead>
    <tbody>${pl.lines.map(({ listing: l, impressions: i, cost }) => {
      const r = { listing: l, distanceMiles: 0 };
      return `<tr><td class="stick-l0 p-l0"><div class="name">${esc(l.name)}</div><div class="id">${esc(l.id)} · ${esc(l.market)}</div></td>
        ${cols.map((c) => `<td class="${c.num ? 'num' : ''} nowrap">${c.cell ? c.cell(r, { multi: false }) : esc(l[c.key] ?? '—')}</td>`).join('')}
        <td class="num">${impressions(i)}</td>${app.hideInternal ? '' : `<td class="num internal-td">${money(l.floorCpm, 2)}</td>`}<td class="num">${money(cost)}</td>
        <td class="act stick-r"><button class="icon-btn" data-act="p-remove" data-id="${esc(l.id)}" aria-label="Remove ${esc(l.name)}" title="Remove from proposal">${icon('x', 16)}</button></td></tr>`;
    }).join('')}</tbody></table>`;
}

// ---------- 4. Review: the last look before anything leaves ----------
// Left: a "Ready to send?" checklist from the real state, then the formats to include.
// Right: exactly what the client gets. Built only from the export allow-list.
function readyChecks(pl) {
  const s = S();
  const q = app.quote;
  const checks = [];
  checks.push(q.start && q.end && app.brief.flightEstimated
    ? { lvl: 'warn', text: `Flight dates ${flightText()} are estimated`, act: ['brief', 'Confirm'] }
    : q.start && q.end
    ? { lvl: 'ok', text: `Flight ${flightText()} (${pl.weeks} weeks)` }
    : { lvl: 'warn', text: 'No flight dates yet. Totals assume 4 weeks.', act: ['brief', 'Set dates'] });
  if (pl.budget) checks.push(pl.total <= pl.budget
    ? { lvl: 'ok', text: `Within the ${money(pl.budget)} budget` }
    : { lvl: 'warn', text: `${money(pl.total - pl.budget)} over the ${money(pl.budget)} budget`, act: ['review', 'Adjust'] });
  else checks.push({ lvl: 'info', text: 'No budget given. The email states the total instead.', act: ['brief', 'Add budget'] });
  checks.push(pl.flags.some((f) => f.key === 'below-floor')
    ? { lvl: 'stop', text: 'The quote is below the floor. A manager reviews it before it goes out.', act: ['review', 'Change CPM'] }
    : { lvl: 'ok', text: `Quote of ${money(pl.cpm, 2)} CPM is at or above the floor` });
  const hold = pl.lines.filter(({ listing }) => listing.status === 'hold').length;
  checks.push(hold ? { lvl: 'warn', text: `${plural(hold, `${TERMS.listing} is`, `${TERMS.listings} are`)} on hold`, act: ['review', 'Review'] } : { lvl: 'ok', text: `All ${plural(pl.lines.length, TERMS.listing, TERMS.listings)} are available` });
  const missing = pl.lines.filter((x) => x.impressions == null).length;
  if (missing) checks.push({ lvl: 'info', text: `${plural(missing, `${TERMS.listing} has`, `${TERMS.listings} have`)} no impressions on file` });
  const sizes = sizesNeeded(pl.lines);
  checks.push({ lvl: 'info', text: `The client needs ${plural(sizes.length, 'creative size', 'creative sizes')}: ${sizes.map(([px]) => px).join(', ')}` });
  checks.push({ lvl: 'ok', text: 'Floor and suggested CPM are not in any file' });
  return checks;
}
function renderExport() {
  const pl = plan();
  const sel = app.exportSel;
  const ft = flightText() || 'Dates to confirm';
  const rows = exportRows(pl, ft);
  const fileBase = `${(app.proposal.client || 'Client').replace(/[^A-Za-z0-9]+/g, '_')}_Proposal`;
  const tab = sel[app.previewTab] ? app.previewTab : (['sheet', 'deck', 'email'].find((k) => sel[k]) || 'sheet');
  const checks = readyChecks(pl);
  const todo = checks.filter((x) => x.lvl === 'warn' || x.lvl === 'stop').length;
  const stop = checks.some((x) => x.lvl === 'stop');
  const lvlIcon = { ok: 'check', warn: 'alert', stop: 'alert', info: 'info' };
  const slides = pl.lines.length + 2;
  const opt = (k, title, file) => `<label class="inc-opt ${sel[k] ? 'is-on' : ''}"><span class="checkbox"><input type="checkbox" data-act="exp-sel" data-k="${k}" ${sel[k] ? 'checked' : ''}></span><span class="io-main"><span class="t-body-m">${title}</span><span class="desc">${file}</span></span></label>`;
  let preview = '';
  if (tab === 'sheet') {
    const totImp = pl.impressions, totCost = pl.total;
    preview = `<div class="file-card">
      <div class="fc-head">${icon('file', 16)}<span class="fn">${fileBase}.csv</span><span class="t-caption" style="font-weight:400">${plural(rows.length, 'row', 'rows')} · ${EXPORT_COLUMNS.length} columns</span></div>
      <div class="sheet-wrap"><table class="grid sheet"><thead><tr>${EXPORT_COLUMNS.map((col) => `<th class="${['Impressions', 'CPM', 'Est. cost'].includes(col) ? 'num' : ''}">${col}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${EXPORT_COLUMNS.map((col) => `<td class="${['Impressions', 'CPM', 'Est. cost'].includes(col) ? 'num' : ''}">${esc(col === 'CPM' || col === 'Est. cost' ? (r[col] === '' ? '' : `$${Number(r[col]).toLocaleString('en-US', { minimumFractionDigits: 2 })}`) : col === 'Impressions' && r[col] !== '' ? Number(r[col]).toLocaleString('en-US') : r[col])}</td>`).join('')}</tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="${EXPORT_COLUMNS.indexOf('Impressions')}">Total</td><td class="num">${Math.round(totImp).toLocaleString('en-US')}</td><td class="num">$${pl.cpm.toFixed(2)}</td><td class="num">${money(totCost, 2)}</td></tr></tfoot></table></div></div>`;
  } else if (tab === 'deck') {
    const mixTxt = mixOf(pl.lines).map(([m, n]) => `${n} ${m.toLowerCase()}${n === 1 ? '' : 's'}`).join(', ');
    preview = `<div class="fc-head plain">${icon('file', 16)}<span class="fn">${fileBase}.pptx</span><span class="t-caption" style="font-weight:400">${slides} slides</span></div>
      <div class="deck2">
        <figure class="slide2 cover"><span class="sn">1</span><div class="s-k">${TERMS.Proposal}</div><div class="s-t">${esc(app.proposal.title)}</div><div class="s-s">${esc(clientName())}${flightText() ? ` · ${esc(flightText())}` : ''}</div></figure>
        <figure class="slide2 summary"><span class="sn">2</span><div class="s-t">At a glance</div>
          <div class="s-stats"><div><b>${pl.lines.length}</b><span>${TERMS.listings}</span></div><div><b>${impressions(pl.impressions)}</b><span>impressions</span></div><div><b>${compactMoney(pl.total)}</b><span>at ${money(pl.cpm, 2)} CPM</span></div></div>
          <div class="s-s">${esc(mixTxt)} near ${esc(pois()[0]?.place.name || nearText())}</div></figure>
        ${pl.lines.map(({ listing: l, impressions: i, cost }, k) => `<figure class="slide2 photo"><span class="sn">${k + 3}</span><div class="s-ph">${placeholderPhoto(l)}</div>
          <div class="s-body"><div class="s-t sm">${esc(l.name)}</div><div class="s-s">${esc(l.media)} · ${esc(l.dims)} · ${esc(l.px)} · ${esc(l.facing ? `Faces ${l.facing}` : l.venue)}</div><div class="s-s">${impressions(i)} impressions · ${money(cost)}</div></div></figure>`).join('')}
      </div>`;
  } else {
    const em = emailDraft();
    preview = `<div class="mail-preview"><div class="mp-row"><span>Subject</span>${esc(em.subject)}</div><div class="mp-body">${esc(em.body).replace(/\n/g, '<br>')}</div></div>
      <p class="t-caption" style="font-weight:400;margin-top:8px">You can edit the email in the next step.</p>`;
  }
  const n = ['sheet', 'deck', 'email'].filter((k) => sel[k]).length;
  $('#p-main').innerHTML = `
    ${proposalHeader({ crumb: 'Review', title: 'Review before sending', sub: `Check what ${esc(clientName())} will get. Internal pricing is never included.`,
      actions: `<button class="btn neutral" data-act="save">Save</button><button class="btn primary" data-act="exp-generate" ${n ? '' : 'disabled'}>${n === 3 || sel.email ? 'Make files and draft email' : 'Make files'} ${icon('arrowRight', 16)}</button>` })}
    <div class="body p-body">
      <section class="panel p-left" aria-label="Ready to send">
        <div class="p-scroll">
          <div class="p-sec">
            <div class="ready-head ${stop ? 'is-stop' : todo ? 'is-todo' : 'is-ok'}">${icon(stop || todo ? 'alert' : 'check', 18)}<div><div class="t-heading">${stop ? 'Needs a manager first' : todo ? `${plural(todo, 'thing', 'things')} to check` : 'Ready to send'}</div>
              <div class="t-caption" style="font-weight:400">${plural(pl.lines.length, TERMS.listing, TERMS.listings)} · ${impressions(pl.impressions)} impressions · ${money(pl.total)}</div></div></div>
            <ul class="checks">${checks.map((x) => `<li class="ck ck-${x.lvl}">${icon(lvlIcon[x.lvl], 14)}<span>${esc(x.text)}</span>${x.act ? `<button class="link" data-act="flow-go" data-step="${x.act[0]}">${x.act[1]}</button>` : ''}</li>`).join('')}</ul>
          </div>
          <div class="p-sec"><h2 class="t-heading" style="margin-bottom:10px">Include</h2>
            <div class="inc-opts">
              ${opt('sheet', 'Spreadsheet', `${fileBase}.csv · one row per ${TERMS.listing}`)}
              ${opt('deck', 'Slide deck', `${fileBase}.pptx · ${slides} slides with photos`)}
              ${opt('email', 'Email draft', 'A short note to paste into your email')}
            </div>
          </div>
        </div>
      </section>
      <section class="panel p-right" aria-label="What the client gets">
        <div class="panel-head"><span class="t-heading">What ${esc(clientName())} will get</span>
          <div class="tabs" role="tablist">${[['sheet', 'Spreadsheet'], ['deck', `Deck · ${slides}`], ['email', 'Email']].map(([k, l]) => `<button class="tab ${tab === k ? 'is-active' : ''}" role="tab" aria-selected="${tab === k}" data-act="exp-tab" data-k="${k}" ${sel[k] ? '' : 'disabled title="Not included"'}>${l}</button>`).join('')}</div></div>
        <div class="p-preview">${n ? preview : '<div class="empty"><p>Pick at least one thing to include.</p></div>'}</div>
      </section>
    </div>`;
}

// ---------- 3. Email ----------
function emailDraft() {
  if (app.email?.edited) return app.email;
  const pl = plan();
  const mix = mixOf(pl.lines).map(([m, n]) => `${n} ${m.toLowerCase()}${n === 1 ? '' : 's'}`).join(', ');
  const near = pois()[0]?.place.name || (stores().length ? `your ${plural(stores().length, TERMS.location, TERMS.locations)}` : 'the area');
  const ft = flightText();
  const budgetLine = pl.budget ? (pl.total <= pl.budget ? `, within your ${money(pl.budget)} budget` : `, about ${money(pl.total)} in total`) : `, about ${money(pl.total)} in total`;
  const files = [app.exportSel.sheet && 'the spreadsheet has the full list', app.exportSel.deck && 'the deck has photos and creative sizes'].filter(Boolean);
  const subject = `${clientName()}: billboard proposal near ${near}`;
  const body = `Hi,\n\nThanks for the request. Here are ${plural(pl.lines.length, TERMS.listing, TERMS.listings)} near ${near} (${mix})${ft ? ` for ${ft}` : ''}.\n\nThe proposal projects ${impressions(pl.impressions)} impressions at a ${money(pl.cpm, 2)} CPM${budgetLine}.${files.length ? ` Attached: ${files.join(', and ')}.` : ''}\n\nLet me know what you would like to adjust.\n\nBest,\nPat`;
  app.email = { subject, body, edited: false };
  return app.email;
}
function exportFiles() {
  const base = `${(app.proposal.client || 'Client').replace(/[^A-Za-z0-9]+/g, '_')}_Proposal`;
  const files = [];
  if (app.exportSel.sheet) files.push({ name: `${base}.csv`, kind: 'sheet', size: `${Math.max(1, Math.round(toCsv(exportRows(plan(), flightText())).length / 1024))} KB` });
  if (app.exportSel.deck) files.push({ name: `${base}.pptx`, kind: 'deck', size: `${(0.4 + plan().lines.length * 0.3).toFixed(1)} MB` });
  return files;
}
function renderEmailStep() {
  const em = emailDraft();
  const files = exportFiles();
  const sent = app.stage === 'sent';
  $('#p-main').innerHTML = `
    ${proposalHeader({ crumb: 'Send', title: `Send to ${clientName()}`, sub: 'Copy the email, then paste it into your own mail. Nothing is sent from here.',
      actions: sent ? `<span class="pill success">Marked as sent</span>` : `<button class="btn secondary" data-act="mark-sent">${icon('check', 16)}Mark as sent</button>` })}
    <div class="body p-body">
      <section class="panel p-left wide" aria-label="Email draft">
        <div class="p-scroll"><div class="p-sec">
          <label class="field-label" for="em-subject">Subject</label>
          <div class="field"><input id="em-subject" data-em="subject" value="${esc(em.subject)}"></div>
          <label class="field-label" for="em-body" style="margin-top:12px">Message</label>
          <textarea id="em-body" class="em-body" data-em="body" rows="12">${esc(em.body)}</textarea>
          <div class="em-actions"><button class="btn primary" data-act="em-copy">${icon('fileText', 16)}Copy email</button>${em.edited ? '<button class="btn tertiary" data-act="em-reset">Reset text</button>' : ''}</div>
          ${files.length ? `<div class="t-caption" style="margin:16px 0 8px">Files to attach</div>${files.map((f) => `<div class="file-row">${icon('file', 16)}<span class="fn">${esc(f.name)}</span><span class="t-caption" style="font-weight:400">${f.size}</span><button class="btn neutral sm" data-act="em-download" data-kind="${f.kind}">Download</button></div>`).join('')}` : ''}
        </div></div>
      </section>
      <div class="em-arrow" aria-hidden="true">${icon('arrowRight', 18)}<span>Paste</span><span>Attach</span></div>
      <section class="p-right em-example" aria-label="Example of your email app">
        <div class="t-caption" style="display:flex;justify-content:space-between;margin-bottom:8px"><span>Your own email app (example)</span>${app.copied ? '<span class="pill success">Copied</span>' : ''}</div>
        <div class="mail-win"><div class="mw-bar"><i></i><i></i><i></i><span>New message</span></div>
          <div class="mp-row"><span>To</span><span class="muted">Your contact at ${esc(clientName())}</span></div>
          <div class="mp-row"><span>Subject</span>${esc(em.subject)}</div>
          <div class="mp-body">${esc(em.body).replace(/\n/g, '<br>')}</div>
          ${files.length ? `<div class="mw-files">${files.map((f) => `<span class="tag">${icon('attach', 12)}${esc(f.name)}</span>`).join('')}</div>` : ''}
          <div class="mw-foot"><span class="mw-send">Send</span><span class="t-caption" style="font-weight:400">Sent from your mail, not from Adkom</span></div>
        </div>
      </section>
    </div>`;
  ['em-subject', 'em-body'].forEach((id) => $(`#${id}`).addEventListener('input', (e) => {
    app.email = { ...app.email, [e.target.dataset.em]: e.target.value, edited: true };
    const ex = document.querySelector('.em-example .mp-body'); if (ex && e.target.dataset.em === 'body') ex.innerHTML = esc(e.target.value).replace(/\n/g, '<br>');
  }));
}
function downloadSheet() {
  const csv = toCsv(exportRows(plan(), flightText() || 'Dates to confirm'));
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = exportFiles().find((f) => f.kind === 'sheet').name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Scenarios (prototype only) ----------
function resetWorkspace({ title = 'New proposal', client = null } = {}) {
  app.screen = 'workspace';
  app.proposal = { title, client };
  app.history = [initialState()];
  app.idx = 0;
  app.messages = [];
  app.view = freshView();
  app.dialog = null;
  app.csvSummary = null;
  app.quote = { cpm: null, start: '', end: '', budget: '' };
  app.brief = { flightRough: '', flightEstimated: false, estimateWhy: '', budgetRough: false, budgetNote: '' };
  app.email = null; app.stage = 'draft'; app.copied = false;
  if (!$('#messages')) workspaceShell();
}
function greet() {
  pushMsg({ kind: 'agent', text: 'Tell me where the client wants to be, or search a place or address on the right. I will find it on the map for you.' });
  pushMsg({ kind: 'quick', replies: ['Near a stadium', 'Near an airport', "Around my client's stores", 'I have a list of addresses'] });
}
function startFromText(text) {
  resetWorkspace();
  app.view.mode = 'brief';
  app.briefNudged = false;
  app.homeDraft = '';
  renderWorkspace();
  send(text);
}
const SCENARIOS = {
  1: () => { app.screen = 'home'; app.homeDraft = ''; render(); },
  2: () => {
    const sim = app.sim.slow; app.sim.slow = false;
    resetWorkspace({ title: 'Black Friday campaign', client: 'Cobalt Agency' });
    send(SAMPLE_REQUESTS.vague, { instant: true });
    app.sim.slow = sim; renderWorkspace();
  },
  3: () => {
    SCENARIOS[2]();
    const sim = app.sim.slow; app.sim.slow = false;
    send('Go out to 2 miles and sort by impressions.', { instant: true });
    app.sim.slow = sim; renderWorkspace();
  },
  4: () => {
    resetWorkspace({ title: 'Black Friday campaign', client: 'Cobalt Agency' });
    greet();
    renderWorkspace();
    const input = $('#search-input');
    input.value = 'Harbor';
    app.view.query = 'Harbor'; app.view.showSearch = true; app.view.focusIdx = 0; app.view.addMenuFor = 'p-harbor-field';
    input.focus();
    renderWorkspace();
  },
  5: () => {
    resetWorkspace({ title: 'Brightline retail, 48 stores', client: 'Brightline Media' });
    pushMsg({ kind: 'user', text: 'I have a list of addresses.' });
    pushMsg({ kind: 'agent', text: 'Upload a CSV and I will find each address on the map. I can tag them all for you.' });
    renderWorkspace();
    openCsvDialog({ name: SAMPLE_CSV_NAME, text: sampleCsvText() });
  },
  6: () => {
    SCENARIOS[5]();
    const sim = app.sim.slow; app.sim.slow = false;
    commitCsv();
    app.sim.slow = sim; renderWorkspace();
  },
  // The end of the flow: Harbor Field with the top 5 added, then review → export → email.
  7: () => {
    SCENARIOS[3]();
    const sim = app.sim.slow; app.sim.slow = false;
    send('add the top 5', { instant: true });
    app.sim.slow = sim;
    app.quote = { cpm: null, start: '2026-11-09', end: '2026-11-30', budget: '150000' };
    app.brief = { flightRough: '', flightEstimated: false, estimateWhy: '', budgetRough: false, budgetNote: '' };
    app.email = null; app.stage = 'draft'; app.copied = false;
    openProposal('review');
  },
  8: () => { SCENARIOS[7](); openProposal('export'); },
  10: () => {
    resetWorkspace({ title: 'Black Friday campaign', client: 'Cobalt Agency' });
    app.view.mode = 'brief'; app.briefNudged = false;
    send(SAMPLE_REQUESTS.vague, { instant: true });
    renderWorkspace();
  },
  9: () => { SCENARIOS[7](); openProposal('email'); },
};
function openRecent(id) {
  if (id === 'harbor') return SCENARIOS[2]();
  if (id === 'brightline') return SCENARIOS[6]();
  if (id === 'marlow') {
    resetWorkspace({ title: 'Marlow downtown push', client: 'Quill & Co.' });
    send('near Harborview Mall', { instant: true });
    renderWorkspace();
  }
}

// ---------- Prototype panel ----------
function renderProto() {
  let host = $('#proto-root');
  if (!host) { host = document.createElement('div'); host.id = 'proto-root'; host.className = 'proto'; document.body.appendChild(host); }
  const frames = ['Start, any starting point', 'Vague request, found the place', 'Refine by chat: radius and sort', 'Search a place or address', 'Upload a CSV of addresses', 'Coverage and gaps', 'Proposal summary', 'Review before sending', 'Send: email draft', 'Brief: the request as search criteria'];
  host.innerHTML = `
    ${app.protoOpen ? `<div class="proto-panel" role="dialog" aria-label="Prototype controls">
      <div class="menu-label">Jump to a Figma frame (11.4.26)</div>
      ${frames.map((f, i) => `<button class="menu-item" data-act="scenario" data-n="${i + 1}"><span class="n">${i + 1}</span>${f}</button>`).join('')}
      <div class="menu-label">Paste into the search bar</div>
      <button class="menu-item" data-act="paste-sample">5 addresses, one needs review</button>
      <div class="menu-label">Paste a sample request</div>
      <button class="menu-item" data-act="sample" data-k="vague">Vague: near Harbor Field, no budget</button>
      <button class="menu-item" data-act="sample" data-k="specific">Specific: 3 markets, dates, $180k, no Apex</button>
      <button class="menu-item" data-act="sample" data-k="injection">Injection test: asks for floor prices</button>
      <div class="menu-label">States</div>
      <label class="toggle">Listings fail to load <input type="checkbox" data-act="sim-error" ${app.sim.inventoryError ? 'checked' : ''}></label>
      <label class="toggle">Show loading skeletons <input type="checkbox" data-act="sim-slow" ${app.sim.slow ? 'checked' : ''}></label>
      <div class="menu-label">Applied filter color</div>
      <div class="toggle" style="gap:6px;justify-content:flex-start;flex-wrap:wrap">${[['soft', 'A · Gray + green stroke'], ['wash', 'B · Light wash'], ['light', 'C · Light stroke'], ['neutral', 'D · Check only'], ['green', 'Saturated green'], ['check', 'Teal + green check'], ['teal', 'Teal (system)']].map(([k, l]) => `<button class="pill-opt ${app.chipColor === k ? 'is-on' : ''}" data-act="chip-color" data-k="${k}" style="height:26px">${l}</button>`).join('')}</div>
      <div class="menu-label">Map</div>
      <label class="toggle">Streets and street names <input type="checkbox" data-act="sim-streets" ${app.sim.streets ? 'checked' : ''}></label>
      <div class="menu-label">Mocked here</div>
      <div class="mock">Map is MapLibre with OpenFreeMap tiles (Google Maps in the north star). Places, geocoding, listings and owners are invented fixtures. The chat is scripted, with no model.</div>
    </div>` : ''}
    <button class="proto-btn" data-act="proto-toggle" aria-expanded="${app.protoOpen}" aria-label="Prototype controls" title="Prototype controls">${icon('play', 12)}</button>`;
}

// ---------- Events ----------
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  const v = app.view;

  // Close popovers and search when clicking elsewhere
  if (v.popover && !e.target.closest('.menu') && !e.target.closest('[data-pop]')) { v.popover = null; renderPopover(); }
  if (app.screen === 'workspace' && v.showSearch && !e.target.closest('#search-pop') && !e.target.closest('#search-wrap')) closeSearch();
  if (app.protoOpen && !e.target.closest('#proto-root')) { app.protoOpen = false; renderProto(); }
  if (!el) return;
  const act = el.dataset.act;
  const s = S();

  switch (act) {
    // Home
    case 'home-start': startFromText($('#home-input').value); break;
    case 'home-attach': $('#home-file').click(); break;
    case 'home-email': app.homeDraft = SAMPLE_REQUESTS.vague; renderHome(); $('#home-input').focus(); break;
    case 'home-search': resetWorkspace(); app.view.mode = 'brief'; app.briefNudged = false; greet(); renderWorkspace(); $('#bf-place')?.focus(); break;
    case 'home-csv': resetWorkspace(); greet(); renderWorkspace(); openCsvDialog(); break;
    case 'home-past': { const r = $('#recent'); r.scrollIntoView({ behavior: 'smooth', block: 'center' }); r.classList.remove('flash'); void r.offsetWidth; r.classList.add('flash'); break; }
    case 'open-recent': openRecent(el.dataset.id); break;
    case 'nav':
      if (el.dataset.to === 'Home') { if (app.screen !== 'home') { app.screen = 'home'; render(); } }
      else if (el.dataset.to === 'Proposals' && app.screen === 'workspace') toast('The proposals list is outside this prototype.');
      else toast(`${el.dataset.to} is outside this prototype.`);
      break;
    case 'nav-toggle': app.navExpanded = !navExpanded(); renderNav(); break;
    case 'go-home': app.screen = 'home'; render(); break;

    // Chat
    case 'send': sendComposer(); break;
    case 'quick': send(el.dataset.text); break;
    case 'undo': if (el.dataset.toast) { app.toasts = app.toasts.filter((x) => String(x.id) !== el.dataset.toast); renderToasts(); } if (undo()) { pushMsg({ kind: 'event', text: 'Undone' }); renderWorkspace(); } break;
    case 'revert': revertChip(el.dataset.key); break;
    case 'new-request': {
      // Never destructive: the old chat stays above a divider, added listings stay, and Undo brings the places back.
      const hadWork = s.anchors.length || app.messages.some((m) => m.kind === 'user');
      if (!hadWork) { app.messages = []; greet(); renderWorkspace(); break; }
      const r = dispatch({ type: 'reset', keepProposal: true }, { source: 'chat' });
      app.view = { ...freshView(), mapMode: v.mapMode, mapH: v.mapH };
      pushMsg({ kind: 'divider', text: 'New request', historyIdx: app.idx });
      greet();
      renderWorkspace();
      if (r) toast(`Started a new request.${s.proposalIds.length ? ` ${plural(s.proposalIds.length, TERMS.listing, TERMS.listings)} kept in the proposal.` : ''}`, 3600, { label: 'Undo', act: 'undo' });
      break;
    }
    case 'attach': $('#attach-file').click(); break;
    case 'open-csv': openCsvDialog(); break;
    case 'save': toast('Saved. Nothing is sent until you build the proposal.'); break;
    case 'build': openProposal('review'); break;
    case 'ws-mode': setMode(el.dataset.mode); break;
    case 'pview': setPview(el.dataset.pv); break;
    case 'p-expand': {
      const id = el.dataset.id, cur = new Set(v.expanded || []);
      cur.has(id) ? cur.delete(id) : cur.add(id);
      v.expanded = [...cur];
      renderSummaryPanel();
      break;
    }
    case 'p-on-map': {
      const id = el.dataset.id;
      setMode('find');
      setTimeout(() => openSignCard(id, { fly: true, scrollRow: true }), 80);
      break;
    }
    case 'adv-open-find': setMode('find'); openAdv(); break;
    case 'bf-add-place': {
      const q = $('#bf-place')?.value.trim();
      if (!q) break;
      const pl = PLACES.find((x) => x.name.toLowerCase() === q.toLowerCase()) || searchGazetteer(q)[0];
      if (!pl) { toast(`No place matches "${q}". Try a street address or a landmark nearby.`); break; }
      controlAction({ type: 'addPlace', place: pl, role: 'point_of_interest' }, `Added ${pl.name} to the brief`);
      if (app.proposal.title === 'New proposal') { app.proposal.title = `${pl.name.replace(/ Stadium$/, '')} campaign`; renderWorkspace(); }
      break;
    }
    case 'chat-toggle': app.chatCollapsed = !chatCollapsed(); applyModeLayout(); break;
    case 'toggle-internal': app.hideInternal = !app.hideInternal; renderWorkspace(); break;
    case 'brief-apply': {
      const k = el.dataset.k;
      if (k === 'client') { const v2 = $('#brief-client')?.value.trim(); app.proposal.client = v2 || null; }
      if (k === 'flight') { app.quote.start = $('#brief-start')?.value || ''; app.quote.end = $('#brief-end')?.value || ''; app.brief.flightEstimated = false; if (app.quote.start && app.quote.end) app.brief.flightRough = ''; }
      if (k === 'budget') { const b = parseMoney($('#brief-budget')?.value); app.quote.budget = b == null ? '' : String(b); app.brief.budgetRough = !!$('#brief-rough')?.checked; if (b != null) app.brief.budgetNote = ''; }
      if (!app.email?.edited) app.email = null;
      v.popover = null;
      renderWorkspace();
      break;
    }
    case 'brief-clear': {
      const k = el.dataset.k;
      if (k === 'flight') { app.quote.start = ''; app.quote.end = ''; }
      if (k === 'budget') { app.quote.budget = ''; app.brief.budgetRough = false; }
      v.popover = null;
      renderWorkspace();
      break;
    }

    // Toolbar
    case 'tab': v.tab = el.dataset.tab; v.popover = null; v.selectedLocationId = v.tab === 'locations' ? v.selectedLocationId : null; renderWorkspace(); break;
    case 'pop': v.popover = v.popover === el.dataset.pop ? null : el.dataset.pop; renderPopover(); break;
    case 'set-radius': v.popover = null; controlAction({ type: 'setRadius', miles: +el.dataset.miles }, `Radius set to ${milesLabel(+el.dataset.miles)}`); break;
    case 'set-sort-dir': v.popover = null; controlAction({ type: 'setSort', key: s.sort.key, direction: el.dataset.dir }, `Sorted by ${sortLabel(s.sort.key).toLowerCase()}, ${dirWord(s.sort.key, el.dataset.dir)}`); break;
    case 'set-sort': v.popover = null; controlAction({ type: 'setSort', key: el.dataset.key }, `Sorted by ${sortLabel(el.dataset.key).toLowerCase()}`); break;
    case 'toggle-owner': {
      const id = el.dataset.id;
      const ex = s.excludeOwnerIds.includes(id) ? s.excludeOwnerIds.filter((x) => x !== id) : [...s.excludeOwnerIds, id];
      controlAction({ type: 'setFilters', excludeOwnerIds: ex }, `${s.excludeOwnerIds.includes(id) ? 'Including' : 'Excluded'} ${ownerById[id].name}`);
      renderPopover();
      break;
    }
    case 'toggle-available': revertChip('availableOnly'); renderPopover(); break;
    case 'clear-filters': controlAction({ type: 'setFilters', excludeOwnerIds: [], availableOnly: false, onlyNew: false, adv: emptyAdv() }, 'Filters cleared'); break;
    case 'set-tag': v.popover = null; v.tagFilter = el.dataset.tag; renderWorkspace(); break;
    case 'adv-open': openAdv(); break;
    case 'adv-close': closeAdv(); break;
    case 'adv-discard': v.advOpen = false; v.advConfirm = false; renderAdv(); break;
    case 'adv-apply': applyAdv(); break;
    case 'adv-clear': v.advDraft = { adv: emptyAdv(), ex: [], avail: false }; renderAdv(); break;
    case 'adv-toggle': {
      const f = el.dataset.field, val = el.dataset.val, cur = v.advDraft.adv[f];
      v.advDraft.adv[f] = cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val];
      const sc = $('.adv-body')?.scrollTop; renderAdv(); if (sc != null) $('.adv-body').scrollTop = sc;
      break;
    }
    case 'adv-min': { v.advDraft.adv.minImpressions = el.dataset.val ? +el.dataset.val : null; const sc = $('.adv-body')?.scrollTop; renderAdv(); $('.adv-body').scrollTop = sc; break; }
    case 'map-toggle': { const m = app.view.mapMode || 'split'; setMapMode(m === 'split' ? 'collapsed' : 'split'); renderTop(); break; }
    case 'view-mode': setMapMode(el.dataset.mode); renderTop(); break;
    case 'review-skipped': {
      const rows = app.csvSummary?.skippedRows || [];
      if (!rows.length) break;
      app.dialog = { step: 'map', source: 'retry', fileName: 'Skipped addresses', columns: ['name', 'address', 'tag'], rows, mapping: { address: 'address', name: 'name', tag: 'tag', city: '' }, results: [], tagAll: app.csvSummary.tagAll || '', useTagCol: true, drag: false, resolutions: {} };
      geocodeDialog();
      renderDialog();
      break;
    }
    case 'toggle-gaps': v.coverageFilter = v.coverageFilter === 'none' ? 'all' : 'none'; v.tab = 'locations'; renderWorkspace(); break;
    case 'set-coverage': v.popover = null; v.coverageFilter = el.dataset.cov; renderWorkspace(); break;
    case 'filter-tag': v.tab = 'locations'; v.tagFilter = el.dataset.tag === 'Untagged' ? 'all' : el.dataset.tag; renderWorkspace(); break;
    case 'remove-anchor': { const a = s.anchors.find((x) => x.id === el.dataset.id); controlAction({ type: 'removeLocation', id: el.dataset.id }, `Removed ${a?.place.name}`); break; }
    case 'retry': v.error = false; renderWorkspace(); if (app.sim.inventoryError) toast('Listings are still failing. Turn off the failure in the Prototype menu.'); break;

    // List
    case 'sort-col': {
      const key = el.dataset.key;
      const dir = s.sort.key === key ? (s.sort.direction === 'asc' ? 'desc' : 'asc') : (key === 'impressions' ? 'desc' : 'asc');
      controlAction({ type: 'setSort', key, direction: dir }, `Sorted by ${sortLabel(key).toLowerCase()}, ${dirWord(key, dir)}`);
      break;
    }
    case 'add-proposal': {
      controlAction({ type: 'addToProposal', ids: [el.dataset.id] });
      const btn = $('.tray-btn'); if (btn) { btn.classList.remove('bump'); void btn.offsetWidth; btn.classList.add('bump'); }
      break;
    }
    case 'sel-row': {
      const id = el.dataset.id;
      const ids = results().map((r) => r.listing.id);
      let sel = new Set(v.selected);
      if (e.shiftKey && v.lastSel && ids.includes(v.lastSel)) {
        const [a, b] = [ids.indexOf(v.lastSel), ids.indexOf(id)].sort((x, y) => x - y);
        ids.slice(a, b + 1).forEach((x) => (el.checked ? sel.add(x) : sel.delete(x)));
      } else if (el.checked) sel.add(id); else sel.delete(id);
      v.selected = [...sel]; v.lastSel = id;
      renderList();
      break;
    }
    case 'sel-all': case 'sel-all-btn': {
      const ids = results().map((r) => r.listing.id);
      const allOn = ids.every((x) => v.selected.includes(x));
      v.selected = act === 'sel-all' && allOn ? [] : ids;
      renderList();
      break;
    }
    case 'sel-clear': v.selected = []; renderList(); break;
    case 'bulk-add': {
      const ids = v.selected.filter((id) => !s.proposalIds.includes(id));
      v.selected = [];
      controlAction({ type: 'addToProposal', ids }, `Added ${plural(ids.length, TERMS.listing, TERMS.listings)} to the ${TERMS.proposal}`);
      const btn = $('.tray-btn'); if (btn) { btn.classList.remove('bump'); void btn.offsetWidth; btn.classList.add('bump'); }
      break;
    }
    case 'bulk-remove': {
      const ids = v.selected.filter((id) => s.proposalIds.includes(id));
      v.selected = [];
      controlAction({ type: 'removeFromProposal', ids }, `Removed ${plural(ids.length, TERMS.listing, TERMS.listings)} from the ${TERMS.proposal}`);
      break;
    }
    case 'card-close': closeSignCard(); break;
    case 'col-reset': app.columns = null; renderList(); renderPopover(); break;
    case 'flow-go': {
      const st = el.dataset.step;
      const ws = { brief: 'brief', find: 'find', review: 'proposal' }[st];
      if (ws) {
        if (app.screen !== 'workspace') { app.screen = 'workspace'; root.innerHTML = ''; }
        if (!$('#messages')) workspaceShell();
        setMode(ws);
        break;
      }
      openProposal(st);
      break;
    }
    case 'p-remove': {
      controlAction({ type: 'removeFromProposal', ids: [el.dataset.id] }, `Removed ${LISTINGS.find((l) => l.id === el.dataset.id)?.name} from the ${TERMS.proposal}`);
      if (!S().proposalIds.length) { app.screen = 'workspace'; app.view.mode = 'find'; render(); toast(`The ${TERMS.proposal} is empty, so you're back to finding ${TERMS.listings}.`); }
      else if (app.screen === 'proposal') renderProposal(); else renderWorkspace();
      break;
    }
    case 'q-reset': app.quote.cpm = null; app.screen === 'proposal' ? renderProposal() : renderWorkspace(); break;
    case 'exp-tab': app.previewTab = el.dataset.k; renderProposal(); break;
    case 'exp-generate': app.email = app.email?.edited ? app.email : null; openProposal('email'); toast('Files ready. Copy the email and attach them.'); break;
    case 'em-copy': {
      const em = emailDraft();
      const text = `Subject: ${em.subject}

${em.body}`;
      (navigator.clipboard?.writeText(text) || Promise.reject()).then(() => { app.copied = true; renderProposal(); toast('Copied. Paste it into your email.'); }).catch(() => toast('Copy the text from the message box.'));
      break;
    }
    case 'em-reset': app.email = null; renderProposal(); break;
    case 'em-download': if (el.dataset.kind === 'sheet') downloadSheet(); else toast('Deck files come later in this prototype. The preview shows what it holds.'); break;
    case 'mark-sent': {
      app.stage = 'sent';
      const rec = RECENT_PROPOSALS.find((x) => x.title === app.proposal.title);
      if (rec) { rec.status = { label: 'Sent', tone: 'success' }; rec.when = 'Just now'; }
      else RECENT_PROPOSALS.unshift({ id: 'current', title: app.proposal.title, client: app.proposal.client || 'New client', when: 'Just now', status: { label: 'Sent', tone: 'success' } });
      renderProposal();
      toast('Marked as sent. Stages and win/loss come later.');
      break;
    }
    case 'msg-copy': {
      const i = +el.dataset.i;
      const start = app.messages.slice(0, i + 1).map((x) => x.kind).lastIndexOf('user') + 1;
      const text = app.messages.slice(start, i + 1).map((m) => m.kind === 'agent' || m.kind === 'note' ? m.text
        : m.kind === 'result' ? `${m.title}: ${m.body}` : m.kind === 'summary' ? m.rows.map(([k, val]) => `${k}: ${val}`).join('\n')
        : m.kind === 'criteria' ? `${m.title}: ${m.items.map((x) => x.label).join(', ')}` : m.kind === 'changed' ? `What changed: ${m.chips.map((x) => x.label).join(', ')}` : '').filter(Boolean).join('\n\n');
      (navigator.clipboard?.writeText(text) || Promise.reject()).then(() => toast('Reply copied.')).catch(() => toast('Could not reach the clipboard.'));
      break;
    }
    case 'msg-retry': {
      const ui = app.messages.map((x) => x.kind).lastIndexOf('user');
      if (ui < 0) break;
      const u = app.messages[ui];
      if (u.turnStart != null && app.idx > u.turnStart) app.idx = u.turnStart; // undo what that reply changed
      app.messages = app.messages.slice(0, ui + 1);
      app.messages.push({ id: ++msgSeq, kind: 'typing' });
      renderWorkspace();
      setTimeout(() => { app.messages = app.messages.filter((m) => m.kind !== 'typing'); handleReply(u.text); renderWorkspace(); }, 420);
      break;
    }
    case 'tray-remove': controlAction({ type: 'removeFromProposal', ids: [el.dataset.id] }, `Removed ${LISTINGS.find((l) => l.id === el.dataset.id)?.name} from the ${TERMS.proposal}`); renderPopover(); break;
    case 'remove-proposal': controlAction({ type: 'removeFromProposal', ids: [el.dataset.id] }); break;
    case 'loc-sort': { const k = el.dataset.key; v.locSort = { key: k, dir: v.locSort.key === k && v.locSort.dir === 'asc' ? 'desc' : 'asc' }; renderWorkspace(); break; }
    case 'view-location': selectLocation(el.dataset.id); break;
    case 'expand-location': {
      const loc = s.anchors.find((a) => a.id === el.dataset.id);
      const next = effectiveRadius(s, loc.id) + 1;
      v.selectedLocationId = loc.id;
      controlAction({ type: 'setRadius', miles: next, scope: loc.id }, `${loc.place.name} widened to ${milesLabel(next)}`);
      break;
    }

    // Search
    case 'sr-add': { e.stopPropagation(); v.addMenuFor = v.addMenuFor === el.dataset.id ? null : el.dataset.id; v.preview = placeById[el.dataset.id]; renderSearch(); updateMap(); break; }
    case 'add-as': e.stopPropagation(); addPlaceFromSearch(el.dataset.id, el.dataset.role); break;
    case 'category': v.category = v.category === el.dataset.cat ? null : el.dataset.cat; v.focusIdx = -1; v.addMenuFor = null; renderSearch(); break;

    // Dialog
    case 'dialog-close': app.dialog = null; renderDialog(); break;
    case 'dialog-scrim': if (e.target === el) { app.dialog = null; renderDialog(); } break;
    case 'csv-choose': $('#csv-file').click(); break;
    case 'csv-sample': loadCsv(SAMPLE_CSV_NAME, sampleCsvText()); renderDialog(); break;
    case 'csv-replace': app.dialog.step = 'upload'; renderDialog(); break;
    case 'bulk-review': e.stopPropagation(); openBulkReview(splitList(v.query)); break;
    case 'bulk-edit': {
      const text = app.dialog.pastedText;
      app.dialog = null; renderDialog();
      const input = $('#search-input');
      input.value = splitList(text).join('; ');
      v.query = input.value; v.showSearch = true;
      input.focus(); renderSearch();
      break;
    }
    case 'paste-sample': {
      app.protoOpen = false; renderProto();
      if (app.screen !== 'workspace') { resetWorkspace(); greet(); }
      renderWorkspace();
      const list = [0, 1, 6, 3].map((i) => [STORE_ROWS[i].street_address, STORE_ROWS[i].city].filter(Boolean).join(', ')).concat('Harborview Mall');
      const input = $('#search-input');
      input.value = list.join('; ');
      v.query = input.value; v.showSearch = true; v.tab = 'listings';
      input.focus(); renderWorkspace();
      break;
    }
    case 'row-accept': { const i = +el.dataset.i; const sel = $(`#sel-${i}`); app.dialog.resolutions[i] = { type: 'accept', choice: sel ? +sel.value : 0 }; renderDialog(); break; }
    case 'row-skip': app.dialog.resolutions[+el.dataset.i] = { type: 'skip' }; renderDialog(); break;
    case 'row-reset': delete app.dialog.resolutions[+el.dataset.i]; renderDialog(); break;
    case 'csv-commit': if (app.screen !== 'workspace') resetWorkspace(); commitCsv(); break;

    // Prototype
    case 'chip-color': app.chipColor = el.dataset.k; document.documentElement.dataset.chip = app.chipColor; renderProto(); break;
    case 'proto-toggle': app.protoOpen = !app.protoOpen; renderProto(); break;
    case 'scenario': app.protoOpen = false; SCENARIOS[+el.dataset.n](); renderProto(); break;
    case 'sample': app.protoOpen = false; resetWorkspace(); renderWorkspace(); send(SAMPLE_REQUESTS[el.dataset.k]); break;
  }
});
document.addEventListener('change', (e) => {
  // Fields that edit the brief or the quote carry data-q / data-bf rather than data-act.
  const el = e.target.closest('[data-act], [data-q], [data-bf]');
  if (!el) return;
  if (el.dataset.act === 'sim-error') { app.sim.inventoryError = el.checked; if (!el.checked) { app.view.error = false; renderWorkspace(); } }
  if (el.dataset.act === 'sim-slow') app.sim.slow = el.checked;
  if (el.dataset.act === 'toggle-outside') { app.view.showOutside = el.checked; updateMap(); }
  if (el.dataset.bf) {
    const k = el.dataset.bf;
    if (k === 'radius') { controlAction({ type: 'setRadius', miles: +el.value }, `Radius set to ${milesLabel(+el.value)}`); return; }
    if (k === 'rough') { app.brief.budgetRough = el.checked; renderWorkspace(); return; }
    if (k === 'client') { app.proposal.client = el.value.trim() || null; renderWorkspace(); return; }
    if (k === 'exclude') {
      const s0 = S(); const id = el.dataset.id;
      const ex = el.checked ? [...s0.excludeOwnerIds, id] : s0.excludeOwnerIds.filter((x) => x !== id);
      controlAction({ type: 'setFilters', excludeOwnerIds: ex }, `${el.checked ? 'Excluding' : 'Including'} ${ownerById[id].name}`);
      return;
    }
  }
  if (el.dataset.q) {
    // Quote fields apply on change (Enter, blur, or picking a date) so typing is never interrupted.
    const k = el.dataset.q;
    if (k === 'cpm') { const v = parseMoney(el.value); app.quote.cpm = v == null ? null : Math.round(v * 100) / 100; }
    else app.quote[k] = el.value;
    if (k === 'start' || k === 'end') app.brief.flightEstimated = false;
    if (!app.email?.edited) app.email = null;
    const focusId = document.activeElement?.id;
    app.screen === 'proposal' ? renderProposal() : renderWorkspace();
    if (focusId && focusId !== el.id) $(`#${focusId}`)?.focus();
    return;
  }
  if (el.dataset.act === 'exp-sel') { app.exportSel[el.dataset.k] = el.checked; if (!app.exportSel[app.previewTab]) app.previewTab = ['sheet', 'deck', 'email'].find((k) => app.exportSel[k]) || app.previewTab; app.email = app.email?.edited ? app.email : null; renderProposal(); }
  if (el.dataset.act === 'col-toggle') {
    const cur = new Set(app.columns || DEFAULT_COLUMNS);
    el.checked ? cur.add(el.dataset.key) : cur.delete(el.dataset.key);
    app.columns = LIST_COLUMNS.map((c) => c.key).filter((k) => cur.has(k));
    renderList();
  }
  if (el.dataset.act === 'adv-owner') { const d = app.view.advDraft, id = el.dataset.id; d.ex = el.checked ? d.ex.filter((x) => x !== id) : [...d.ex, id]; const sc = $('.adv-body').scrollTop; renderAdv(); $('.adv-body').scrollTop = sc; }
  if (el.dataset.act === 'adv-avail') { app.view.advDraft.avail = el.checked; const sc = $('.adv-body').scrollTop; renderAdv(); $('.adv-body').scrollTop = sc; }
  if (el.dataset.act === 'sim-streets') { app.sim.streets = el.checked; mapPort?.setStreets(el.checked); }
});
// Radius slider: live preview while dragging, one undoable change on release.
document.addEventListener('input', (e) => {
  if (e.target.matches?.('input[data-radius]')) onRadiusInput(e.target);
});
document.addEventListener('change', (e) => {
  if (e.target.matches?.('input[data-radius]')) onRadiusCommit(e.target);
});
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[role="button"][data-act]')) { e.preventDefault(); e.target.click(); return; }
  if (e.key === 'Enter' && e.target.id === 'bf-place') { e.preventDefault(); $('[data-act="bf-add-place"]')?.click(); return; }
  // ⌘Z / Ctrl+Z undoes outside text fields (⇧ redoes).
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && app.screen === 'workspace' && !e.target.matches?.('input, textarea, select')) {
    e.preventDefault();
    if (e.shiftKey ? redo() : undo()) { pushMsg({ kind: 'event', text: e.shiftKey ? 'Redone' : 'Undone' }); renderWorkspace(); }
    return;
  }
  if (e.key === 'Escape') {
    if (app.dialog) { app.dialog = null; renderDialog(); }
    else if (app.view.advOpen) { closeAdv(); }
    else if (app.view.cardId) { closeSignCard(); }
    else if (app.view.popover) { app.view.popover = null; renderPopover(); }
  }
});
window.addEventListener('resize', () => { if (app.view.popover) renderPopover(); });

document.documentElement.dataset.chip = app.chipColor;
// Start: ?frame=1..6 jumps straight to a Figma frame.
const frame = +new URLSearchParams(location.search).get('frame');
if (frame && SCENARIOS[frame]) SCENARIOS[frame]();
else render();
