import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const KEEP_NAMES = [
    'hyper', 'kaluba', 'borees', 'sef', 'giox', 'inquisitor', 'kodak',
    'boulevard', 'rossfcdk', 'meltosik', 'OG', 'uncle', 'dor1an', 'v1nn',
    'wboy', 'mko1919', 'dava', 'jekunam', 'sane4ek8', 'labotryas', 'lukapaja',
    'hit', 'lzrn', 'peconi', 'maki', 'chevare', 'SPACE', 'cl1vlind', 'JKey',
    'hrk', 'dangerdim77', 'lumix', 'rodja', 'donatello', 'maslja', 'lx7ss',
    'noltzer', 'gangsta_panda', 'blueeyes', 'gaga', 'decade', 'special',
    'bomb1to', 'laikingdast', 'dm1trena', 'cofardi', 'ganger_29', 'hristian05',
    'duka', 'hotshot', 'kray', 'kraftvk', 'linox', 'nikkitta', 'paka', 'smidzii',
];

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
});

async function fetchAllPlayers() {
    const all = [];
    let from = 0; const PAGE = 1000;
    while (true) {
        const { data, error } = await sb.from('players').select('id, nickname').range(from, from + PAGE - 1);
        if (error) throw error;
        all.push(...data);
        if (data.length < PAGE) break;
        from += PAGE;
    }
    return all;
}

async function fetchAllPlayerStats() {
    const all = [];
    let from = 0; const PAGE = 1000;
    while (true) {
        const { data, error } = await sb.from('player_stats').select('player_id, matches_played, wins').range(from, from + PAGE - 1);
        if (error) throw error;
        all.push(...data);
        if (data.length < PAGE) break;
        from += PAGE;
    }
    return all;
}

const players = await fetchAllPlayers();
const stats = await fetchAllPlayerStats();
const statsById = new Map(stats.map((s) => [s.player_id, s]));

const lcWanted = new Set(KEEP_NAMES.map((n) => n.toLowerCase()));
const byNickname = new Map();
for (const p of players) {
    if (!p.nickname) continue;
    const lc = p.nickname.toLowerCase();
    if (!lcWanted.has(lc)) continue;
    if (!byNickname.has(lc)) byNickname.set(lc, []);
    byNickname.get(lc).push(p);
}

console.log('nickname,id_count,top_id,top_matches,top_wins');
for (const name of KEEP_NAMES) {
    const lc = name.toLowerCase();
    const ids = byNickname.get(lc) ?? [];
    ids.sort((a, b) => (statsById.get(b.id)?.matches_played ?? 0) - (statsById.get(a.id)?.matches_played ?? 0));
    const top = ids[0];
    const topStats = top ? statsById.get(top.id) : null;
    console.log(`${name},${ids.length},${top?.id ?? '-'},${topStats?.matches_played ?? 0},${topStats?.wins ?? 0}`);
}
