import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const STATUS_FINISHED = 3;

// Canonical 56 player IDs — chosen as the most-active player ID for each
// requested nickname. Names alone aren't unique in the API, so we anchor on
// IDs to avoid pulling in hundreds of nickname collisions.
const KEEP_IDS = [
    812806, 835694, 835690, 835691, 835693, 839503, 839506, 838883, 839504,
    839505, 839507, 831773, 833798, 833797, 839485, 839487, 838884, 838886,
    810141, 839973, 839834, 839838, 839444, 839837, 839836, 839835, 839533,
    839541, 839534, 839540, 839537, 839010, 819920, 838788, 833594, 839370,
    836982, 836981, 839372, 836674, 839371, 839369, 831772, 831775, 838885,
    827594, 839723, 819937, 819924, 838450, 835588, 833800, 837458, 833799,
    812826, 810569,
];

const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
    process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
});

async function fetchAllRows(table, columns, extra) {
    const PAGE = 1000;
    const all = [];
    let from = 0;
    while (true) {
        let q = supabase.from(table).select(columns).range(from, from + PAGE - 1);
        if (extra) q = extra(q);
        const { data, error } = await q;
        if (error) throw error;
        all.push(...data);
        if (data.length < PAGE) break;
        from += PAGE;
    }
    return all;
}

async function resolveKeepIds() {
    const players = await fetchAllRows('players', 'id, nickname');
    const keepSet = new Set(KEEP_IDS);
    const matched = players.filter((p) => keepSet.has(p.id));
    const found = new Set(matched.map((p) => p.id));
    const missing = KEEP_IDS.filter((id) => !found.has(id));
    console.log(`Matched ${matched.length}/${KEEP_IDS.length} requested player ids in DB.`);
    if (missing.length) console.log(`IDs not found in DB: ${missing.join(', ')}`);
    return matched.map((p) => p.id);
}

async function deleteAllRows(table, pkColumn) {
    const { error } = await supabase.from(table).delete().gte(pkColumn, 0);
    if (error) throw new Error(`deleteAll ${table}: ${error.message}`);
}

async function deleteByIdsBatched(table, ids, idCol = 'id') {
    const BATCH = 500;
    for (let i = 0; i < ids.length; i += BATCH) {
        const batch = ids.slice(i, i + BATCH);
        const { error } = await supabase.from(table).delete().in(idCol, batch);
        if (error) throw new Error(`delete ${table}: ${error.message}`);
        if ((i / BATCH) % 10 === 0) {
            console.log(`  ${table}: deleted ${Math.min(i + BATCH, ids.length)}/${ids.length}`);
        }
    }
}

async function deleteMatchesNotInKeep(keepIds) {
    const keepSet = new Set(keepIds);
    console.log('Scanning matches for non-kept rows...');
    const matches = await fetchAllRows('matches', 'id, player1_id, player2_id');
    const toDelete = matches
        .filter((m) => !keepSet.has(m.player1_id) || !keepSet.has(m.player2_id))
        .map((m) => m.id);
    console.log(`Marking ${toDelete.length}/${matches.length} matches for deletion.`);
    await deleteByIdsBatched('matches', toDelete);
    console.log(`Matches kept: ${matches.length - toDelete.length}`);
    return matches.length - toDelete.length;
}

async function deleteNonKeptPlayers(keepIds) {
    const keepSet = new Set(keepIds);
    const players = await fetchAllRows('players', 'id');
    const toDelete = players.filter((p) => !keepSet.has(p.id)).map((p) => p.id);
    console.log(`Deleting ${toDelete.length}/${players.length} player rows.`);
    await deleteByIdsBatched('players', toDelete);
}

function buildPlayerStats(playerId, matches) {
    let wins = 0, draws = 0, losses = 0, gf = 0, ga = 0;
    for (const m of matches) {
        const isP1 = m.player1_id === playerId;
        const own = isP1 ? m.score1 : m.score2;
        const opp = isP1 ? m.score2 : m.score1;
        if (own == null || opp == null) continue;
        gf += own;
        ga += opp;
        if (own > opp) wins += 1;
        else if (own < opp) losses += 1;
        else draws += 1;
    }
    const played = wins + draws + losses;
    return {
        player_id: playerId,
        matches_played: played,
        wins, draws, losses,
        goals_for: gf, goals_against: ga,
        avg_gf: played ? Number((gf / played).toFixed(4)) : 0,
        avg_ga: played ? Number((ga / played).toFixed(4)) : 0,
    };
}

function buildH2HStats(a, b, matches) {
    let wins_p1 = 0, wins_p2 = 0, draws = 0, gf_p1 = 0, gf_p2 = 0;
    for (const m of matches) {
        const aIsP1 = m.player1_id === a;
        const aS = aIsP1 ? m.score1 : m.score2;
        const bS = aIsP1 ? m.score2 : m.score1;
        if (aS == null || bS == null) continue;
        gf_p1 += aS;
        gf_p2 += bS;
        if (aS > bS) wins_p1 += 1;
        else if (aS < bS) wins_p2 += 1;
        else draws += 1;
    }
    const played = wins_p1 + wins_p2 + draws;
    return {
        player1_id: a, player2_id: b,
        matches_played: played,
        wins_p1, wins_p2, draws,
        goals_for_p1: gf_p1, goals_for_p2: gf_p2,
        avg_gf_p1: played ? Number((gf_p1 / played).toFixed(4)) : 0,
        avg_gf_p2: played ? Number((gf_p2 / played).toFixed(4)) : 0,
    };
}

async function upsertChunked(table, rows, onConflict) {
    if (!rows.length) return;
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
        const batch = rows.slice(i, i + CHUNK);
        const { error } = await supabase.from(table).upsert(batch, onConflict ? { onConflict } : undefined);
        if (error) throw new Error(`upsert ${table}: ${error.message}`);
    }
}

async function recalcAll(keepIds) {
    const matches = await fetchAllRows(
        'matches',
        'player1_id, player2_id, score1, score2',
        (q) => q.eq('status', STATUS_FINISHED),
    );
    console.log(`  ${matches.length} finished matches feed the recalc.`);

    const byPlayer = new Map();
    for (const m of matches) {
        if (!byPlayer.has(m.player1_id)) byPlayer.set(m.player1_id, []);
        if (!byPlayer.has(m.player2_id)) byPlayer.set(m.player2_id, []);
        byPlayer.get(m.player1_id).push(m);
        byPlayer.get(m.player2_id).push(m);
    }
    const psRows = keepIds.map((pid) => buildPlayerStats(pid, byPlayer.get(pid) || []));
    await upsertChunked('player_stats', psRows, 'player_id');
    console.log(`  Wrote ${psRows.length} player_stats rows.`);

    const byPair = new Map();
    for (const m of matches) {
        const lo = Math.min(m.player1_id, m.player2_id);
        const hi = Math.max(m.player1_id, m.player2_id);
        const k = `${lo}:${hi}`;
        if (!byPair.has(k)) byPair.set(k, []);
        byPair.get(k).push(m);
    }
    const h2hRows = [...byPair.entries()].map(([k, ms]) => {
        const [a, b] = k.split(':').map(Number);
        return buildH2HStats(a, b, ms);
    });
    await upsertChunked('h2h_stats', h2hRows, 'player1_id,player2_id');
    console.log(`  Wrote ${h2hRows.length} h2h_stats rows.`);
}

async function main() {
    console.log('=== Cleanup ===');

    console.log('\n[1/6] Resolving keep ids...');
    const keepIds = await resolveKeepIds();
    if (keepIds.length === 0) {
        console.error('No matching players found. Aborting.');
        process.exit(1);
    }

    console.log('\n[2/6] Wiping h2h_stats...');
    await deleteAllRows('h2h_stats', 'id');

    console.log('\n[3/6] Wiping player_stats...');
    await deleteAllRows('player_stats', 'player_id');

    console.log('\n[4/6] Deleting matches with non-kept players...');
    await deleteMatchesNotInKeep(keepIds);

    console.log('\n[5/6] Deleting non-kept players...');
    await deleteNonKeptPlayers(keepIds);

    console.log('\n[6/6] Recalculating stats from scratch...');
    await recalcAll(keepIds);

    console.log('\n=== Done ===');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
