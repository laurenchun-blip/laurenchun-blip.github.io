// All user-facing nouns live here. Terminology is a placeholder until the sales team confirms it.
export const TERMS = {
  listing: 'listing',
  listings: 'listings',
  Listing: 'Listing',
  Listings: 'Listings',
  location: 'location',
  locations: 'locations',
  Location: 'Location',
  Locations: 'Locations',
  store: 'store',
  stores: 'stores',
  poi: 'point of interest',
  pois: 'points of interest',
  proposal: 'proposal',
  Proposal: 'Proposal',
  proposals: 'Proposals',
  owner: 'Owner',
  impressions: 'Impressions',
  user: 'sales executive',
};

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

export function miles(n) {
  const v = Math.round(n * 10) / 10;
  return `${v} ${v === 1 ? 'mile' : 'miles'}`;
}

export function mi(n) {
  return `${(Math.round(n * 10) / 10).toFixed(1)} mi`;
}

export function shortMi(n) {
  const v = Math.round(n * 10) / 10;
  return `${v} mi`;
}

export function impressions(n) {
  if (n == null) return '—';
  return `${(n / 1e6).toFixed(1)}M`;
}
