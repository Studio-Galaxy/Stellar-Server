// Gives every official Delhi station a real-world position, taken from OpenStreetMap station nodes.
//   node scripts/match-coords.ts            (from Server/)
// In:  data/osm-metro-*.json (newest), seed/delhi/network.source.json, seed/delhi/coords.manual.json (optional)
// Out: seed/delhi/coords.json  { stationId: { lon, lat, source, osmName } }  + a list of stations left unmatched.
// OSM is used only for positions; names, lines and order come from the official DMRC map.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

import { haversineKm as haversine, slug } from './lib.ts';

type Node = { type: 'node'; id: number; lat: number; lon: number; tags?: Record<string, string> };
const dataDir = new URL('../data/', import.meta.url), seedDir = new URL('../seed/delhi/', import.meta.url);

const osmFile = readdirSync(dataDir).filter((f) => /^osm-metro-.*\.json$/.test(f)).sort().at(-1);
if (!osmFile) throw new Error('No data/osm-metro-*.json found');
const osm = JSON.parse(readFileSync(new URL(osmFile, dataDir), 'utf8'));
const src = JSON.parse(readFileSync(new URL('network.source.json', seedDir), 'utf8'));
const manualFile = new URL('coords.manual.json', seedDir);
const manual: Record<string, { lon: number; lat: number; note?: string }> = existsSync(manualFile) ? JSON.parse(readFileSync(manualFile, 'utf8')) : {};

// Stations renamed recently: OSM may still carry the old name.
const FORMERLY: Record<string, string[]> = {
  'Dr. Baba Saheb Ambedkar Hospital': ['Rohini West'],
  'Rohini': ['Rohini East'],
  'Madhuban Chowk': ['Pitampura'],
  'Supreme Court': ['Pragati Maidan'],
  'Seva Teerth': ['Udyog Bhawan'],
  'Dwarka-Kakrola': ['Dwarka'],
  'Shree Ram Mandir Mayur Vihar': ['Mayur Vihar Pocket I', 'Mayur Vihar Pocket 1'],
  'Sarai Kale Khan-Nizamuddin': ['Hazrat Nizamuddin', 'Sarai Kale Khan Nizamuddin'],
  'Millennium City Centre Gurugram': ['HUDA City Centre', 'Millennium City Centre'],
  'Tughlakabad Rly Colony': ['Tughlakabad', 'Tughlakabad Railway Colony'],
  'Lal Quila': ['Lal Qila', 'Red Fort', 'Lal Quila Red Fort'],
  'Brig. Hoshiar Singh': ['Brigadier Hoshiyar Singh', 'Brigadier Hoshiar Singh'],
  'Dilli Haat-INA': ['INA', 'Dilli Haat INA'],
  'Guru Teg Bahadur Nagar': ['GTB Nagar', 'Guru Tegh Bahadur Nagar'],
  'Krishna Park Extn.': ['Krishna Park Extension'],
  'Delhi Cantt.': ['Delhi Cantonment', 'Delhi Cantt'],
  'Mundka Industrial Area (MIA)': ['Mundka Industrial Area'],
  'Ghevra Metro Station': ['Ghevra'],
  'Terminal 1-IGI Airport': ['Terminal 1 IGI Airport', 'IGI Airport Terminal 1'],
  'Airport (T-3)': ['IGI Airport', 'Airport', 'Indira Gandhi International Airport'],
  'Sikanderpur': ['Sikandarpur'],
  'Raja Nahar Singh (Ballabhgarh)': ['Raja Nahar Singh'],
  'Sant Surdas (Sihi)': ['Sant Surdas'],
  'Shaheed Sthal (New Bus Adda)': ['Shaheed Sthal', 'New Bus Adda'],
  'N.S.E.Z.': ['NSEZ', 'Noida Special Economic Zone'],
  'Depot Station': ['Depot', 'Greater Noida Depot'],
  'Yashobhoomi Dwarka Sector-25': ['Dwarka Sector 25', 'Yashobhoomi Dwarka Sector 25'],
  'Major Mohit Sharma Rajendra Nagar': ['Rajendra Nagar'],
  'Rohini Sector-18, 19': ['Rohini Sector 18'],
  'Pandit Shree Ram Sharma': ['Pandit Shree Ram Sharma', 'Pandit Shri Ram Sharma'],
  'Durgabai Deshmukh South Campus': ['South Campus', 'Durgabai Deshmukh South Campus'],
  'Sir M. Vishweshwaraiah Moti Bagh': ['Moti Bagh', 'Sir Vishweshwaraiah Moti Bagh'],
  'East Vinod Nagar-Mayur Vihar II': ['East Vinod Nagar - Mayur Vihar-II', 'Mayur Vihar II'],
  'Mandawali-West Vinod Nagar': ['Mandawali - West Vinod Nagar'],
  'Trilokpuri-Sanjay Lake': ['Trilokpuri Sanjay Lake'],
  'Nanaksar-Sonia Vihar': ['Sonia Vihar', 'Nanaksar Sonia Vihar'],
  'Okhla Bird Sanctuary': ['Okhla Bird Sanctuary'],
  'Uttari Pitampura-Prashant Vihar': ['North Pitampura - Prashant Vihar'],
  'Haiderpur Village': ['Haiderpur'],
  'Dhansa Bus Stand': ['Dhansa Bus Stand'],
  'GNIDA Office': ['GNIDA Office', 'Greater Noida Authority'],
  'Okhla NSIC': ['Okhla NSIC'],
  'Harkesh Nagar Okhla': ['Okhla', 'Harkesh Nagar'],
  'Jasola-Apollo': ['Jasola Apollo'],
  'Jasola Vihar Shaheen Bagh': ['Jasola Vihar Shaheen Bagh'],
  'Dabri Mor-Janakpuri South': ['Dabri Mor - Janakpuri South', 'Dabri Mor'],
  'ESI-Basaidarapur': ['ESI Hospital', 'ESI - Basai Darapur'],
  'Sadar Bazar Cantonment': ['Sadar Bazaar Cantonment'],
  // OpenStreetMap spellings (checked by hand against the data downloaded 2026-11-24)
  'Barakhamba Road': ['Barakhambha Road'],
  'Badkal Mor': ['Badhkal Mor'],
  'Jafrabad': ['Jaffrabad'],
  'Badarpur Border': ['Badarpur'],
  'Golf Course': ['Noida Golf Course'],
  'Anand Vihar ISBT': ['Anand Vihar'],
  'JLN Stadium': ['Jawaharlal Nehru Stadium'],
  'Maharaja Surajmal Stadium': ['Surajmal Stadium'],
  'Phase-1': ['DLF Phase 1'],
  'Phase-2': ['DLF Phase 2'],
  'Phase-3': ['Phase 3 Station', 'DLF Phase 3'],
  'IIT': ['IIT Delhi'],
  'New Delhi': ['New Delhi', 'New Delhi Airport Express Terminal'],
  ...Object.fromEntries([50, 51, 76, 81, 83, 101, 137, 142, 143, 144, 145, 146, 147, 148].map((n) => [`Sector-${n}`, [`Noida Sector ${n}`]])),
};

// Three ways to compare names, tried in order: exact words, words minus filler, letters only.
const STOP = new Set(['metro', 'station', 'stn', 'the', 'rly', 'railway']);
const words = (s: string) =>
  s.toLowerCase().replace(/\((red|yellow|blue|green|violet|pink|magenta|grey|orange|aqua)[^)]*line\)/g, ' ')
    .replace(/\bbazaar\b/g, 'bazar').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const keys = [
  (s: string) => words(s).sort().join(' '),
  (s: string) => words(s).filter((w) => !STOP.has(w)).sort().join(' '),
  (s: string) => words(s).join(''),
];

const isMetroStation = (t: Record<string, string> = {}) =>
  t.railway === 'station' || t.public_transport === 'station' || t.railway === 'stop' || t.public_transport === 'stop_position';
const nodes = (osm.elements as Node[]).filter((e) => e.type === 'node' && e.tags?.name && isMetroStation(e.tags));
const osmNames = (t: Record<string, string>) =>
  [t.name, t['name:en'], t.official_name, t.old_name, t.alt_name, t.short_name].filter(Boolean).flatMap((n) => n.split(';'));
const indexes = keys.map(() => new Map<string, Node[]>());
for (const n of nodes) for (const name of osmNames(n.tags!)) keys.forEach((k, i) => {
  const key = k(name);
  if (key) indexes[i].set(key, [...(indexes[i].get(key) ?? []), n]);
});
const lookup = (name: string) => {
  for (let i = 0; i < keys.length; i++) { const hit = indexes[i].get(keys[i](name)); if (hit) return hit; }
  return [];
};

const names = new Set<string>();
for (const l of src.lines) for (const s of l.stations) names.add(typeof s === 'string' ? s : s.name);

const coords: Record<string, { lon: number; lat: number; source: string; osmName?: string; spreadKm?: number }> = {};
const unmatched: string[] = [], spread: string[] = [];
for (const name of names) {
  const id = slug(name);
  if (manual[id]) { coords[id] = { lon: manual[id].lon, lat: manual[id].lat, source: 'manual' }; continue; }
  let hits: Node[] = [];
  for (const cand of [name, ...(FORMERLY[name] ?? [])]) {
    hits = lookup(cand);
    if (hits.length) break;
  }
  if (!hits.length) { unmatched.push(name); continue; }
  // Several nodes (one per line/platform) → keep the largest cluster and average it.
  const groups: Node[][] = [];
  for (const n of hits) {
    const g = groups.find((g) => haversine(g[0], n) < 0.8);
    if (g) g.push(n); else groups.push([n]);
  }
  groups.sort((a, b) => b.length - a.length);
  const g = groups[0];
  if (groups.length > 1) spread.push(`${name}: ${groups.length} separate places share this name — used the cluster of ${g.length}`);
  const lat = g.reduce((a, n) => a + n.lat, 0) / g.length, lon = g.reduce((a, n) => a + n.lon, 0) / g.length;
  coords[id] = { lon: +lon.toFixed(6), lat: +lat.toFixed(6), source: `osm:${osmFile}`, osmName: g[0].tags!.name };
}

// ---------- cross-check station order against OpenStreetMap route relations ----------
// Every pair of neighbouring stations in our (official) data should also be neighbours in some OSM route.
const idOfOsmNode = new Map<number, string>();
for (const name of names) for (const cand of [name, ...(FORMERLY[name] ?? [])]) for (const n of lookup(cand)) idOfOsmNode.set(n.id, slug(name));
const osmPairs = new Set<string>();
for (const r of osm.elements.filter((e: { type: string }) => e.type === 'relation')) {
  const seq = r.members.filter((m: { type: string; role: string }) => m.type === 'node' && m.role.startsWith('stop'))
    .map((m: { ref: number }) => idOfOsmNode.get(m.ref)).filter(Boolean) as string[];
  for (let i = 1; i < seq.length; i++) osmPairs.add([seq[i - 1], seq[i]].sort().join('|'));
}
const orderIssues: string[] = [];
let checked = 0;
for (const l of src.lines) {
  const ids = l.stations.map((s: string | { name: string }) => slug(typeof s === 'string' ? s : s.name));
  for (let i = 1; i < ids.length; i++) {
    checked++;
    if (!osmPairs.has([ids[i - 1], ids[i]].sort().join('|'))) orderIssues.push(`${l.id}: ${ids[i - 1]} → ${ids[i]} not adjacent in OSM`);
  }
}

writeFileSync(new URL('coords.json', seedDir), JSON.stringify(coords, null, 1) + '\n');
console.log(`matched ${Object.keys(coords).length}/${names.size} stations from ${osmFile}`);
console.log(`order check: ${checked - orderIssues.length}/${checked} neighbouring pairs also adjacent in OSM`);
if (spread.length) console.log('AMBIGUOUS NAMES\n' + spread.join('\n'));
if (unmatched.length) console.log(`UNMATCHED (${unmatched.length})\n` + unmatched.join('\n'));
if (orderIssues.length) console.log('ORDER DIFFERENCES\n' + orderIssues.join('\n'));
writeFileSync(new URL('coords.check.json', seedDir), JSON.stringify({ unmatched, ambiguous: spread, orderIssues }, null, 1) + '\n');
