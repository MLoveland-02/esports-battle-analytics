import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const API_BASE = 'https://football.esportsbattle.com/api';
const STATUS_FINISHED = 3;
const LOOKBACK_DAYS = 365;

const DEFAULT_HEADERS = {
    accept: '*/*',
    'content-type': 'application/json',
    referer: 'https://football.esportsbattle.com/en/schedule',
    'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
};

const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
});

// ---------- API helpers ----------

async function apiGet(pathname) {
    const url = `${API_BASE}${pathname}`;
    const res = await fetch(url, { headers: DEFAULT_HEADERS });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
    return res.json();
}

function fmtDay(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}/${m}/${day}`;
}

function unwrap(body) {
    if (Array.isArray(body)) return body;
    return body?.data ?? body?.items ?? body?.tournaments ?? body?.matches ?? [];
}

async function fetchTournamentsForDay(dateStr) {
    const dateFrom = `${dateStr}+00:00`;
    const dateTo = `${dateStr}+23:59`;
    const collected = [];
    let page = 1;
    while (true) {
        const body = await apiGet(
            `/tournaments?page=${page}&dateFrom=${dateFrom}&dateTo=${dateTo}`,
        );
        const items = unwrap(body);
        if (!items.length) break;
        collected.push(...items);
        const totalPages = Number(body?.totalPages ?? 0);
        if (totalPages > 0 && page >= totalPages) break;
        if (totalPages === 0) break;
        page += 1;
    }
    return collected;
}

async function fetchAllTournaments() {
    const seen = new Map();
    const today = new Date();
    for (let i = 0; i < LOOKBACK_DAYS; i += 1) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const dateStr = fmtDay(d);
        let items;
        try {
            items = await fetchTournamentsForDay(dateStr);
        } catch (err) {
            console.error(`[err] day ${dateStr}: ${err.message}`);
            continue;
        }
        let added = 0;
        for (const t of items) {
            if (t?.id != null && !seen.has(t.id)) {
                seen.set(t.id, t);
                added += 1;
            }
        }
        console.log(`[day] ${dateStr}: ${items.length} returned, ${added} new`);
    }
    return [...seen.values()];
}

async function fetchTournamentMatches(tournamentId) {
    const body = await apiGet(`/tournaments/${tournamentId}/matches`);
    return unwrap(body);
}

// ---------- shape mappers ----------

function mapTournament(t) {
    return {
        id: t.id,
        name: t.name ?? t.title ?? t.token_international ?? null,
        date: t.date ?? t.start_date ?? null,
        status: t.status_id ?? t.status ?? null,
    };
}

function mapPlayer(p) {
    return {
        id: p.id,
        nickname: p.nickname ?? null,
        photo: p.photo ?? null,
    };
}

function firstHalf(scores) {
    if (!Array.isArray(scores) || scores.length === 0) return null;
    const v = parseInt(scores[0], 10);
    return Number.isFinite(v) ? v : null;
}

function mapMatch(m) {
    const p1 = m.participant1 ?? {};
    const p2 = m.participant2 ?? {};
    return {
        id: m.id,
        tournament_id: m.tournament?.id ?? null,
        date: m.date ?? null,
        status: m.status_id ?? null,
        player1_id: p1.id ?? null,
        player2_id: p2.id ?? null,
        score1: p1.score ?? null,
        score2: p2.score ?? null,
        half_score1: firstHalf(p1.prevPeriodsScores),
        half_score2: firstHalf(p2.prevPeriodsScores),
        team1: p1.team?.token_international ?? null,
        team2: p2.team?.token_international ?? null,
    };
}

// ---------- DB helpers ----------

async function alreadyComplete(tournamentId) {
    // Skip rules:
    //   1. If we've already logged a scrape for this tournament AND have no
    //      matches stored, treat it as "no tracked players involved" — don't
    //      re-fetch.
    //   2. Otherwise, skip only when every stored match is finished. Live or
    //      upcoming matches get re-fetched on each cycle.
    const { data: matches, error: e1 } = await supabase
        .from('matches')
        .select('status')
        .eq('tournament_id', tournamentId);
    if (e1) throw e1;
    if (matches?.length) {
        return matches.every((m) => m.status === STATUS_FINISHED);
    }
    const { data: log, error: e2 } = await supabase
        .from('scrape_log')
        .select('id')
        .eq('tournament_id', tournamentId)
        .limit(1);
    if (e2) throw e2;
    return Boolean(log?.length);
}

async function loadNickToCanonId() {
    // Each tournament in the API may issue a NEW player_id for the same
    // nickname. We map every appearance of a tracked nickname back to one
    // canonical id (the one already in our players table). Without this, the
    // ID-only filter rejects ~99% of valid matches.
    const map = new Map(); // lower nickname -> canonical id
    const PAGE = 1000;
    let from = 0;
    while (true) {
        const { data, error } = await supabase
            .from('players').select('id, nickname').range(from, from + PAGE - 1);
        if (error) throw error;
        for (const p of data) {
            if (!p.nickname) continue;
            const lc = p.nickname.toLowerCase();
            // Stable choice: prefer the smallest canonical id if duplicates
            // ever appear (shouldn't after cleanup).
            if (!map.has(lc) || map.get(lc) > p.id) map.set(lc, p.id);
        }
        if (data.length < PAGE) break;
        from += PAGE;
    }
    return map;
}

async function upsertChunked(table, rows, conflictTarget) {
    if (!rows.length) return;
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const { error } = await supabase
            .from(table)
            .upsert(slice, conflictTarget ? { onConflict: conflictTarget } : undefined);
        if (error) throw new Error(`upsert ${table}: ${error.message}`);
    }
}

async function fetchAllMatchesForPlayer(playerId) {
    const { data, error } = await supabase
        .from('matches')
        .select('player1_id, player2_id, score1, score2')
        .or(`player1_id.eq.${playerId},player2_id.eq.${playerId}`)
        .eq('status', STATUS_FINISHED);
    if (error) throw error;
    return data ?? [];
}

async function fetchAllMatchesForPair(a, b) {
    const { data, error } = await supabase
        .from('matches')
        .select('player1_id, player2_id, score1, score2')
        .or(
            `and(player1_id.eq.${a},player2_id.eq.${b}),and(player1_id.eq.${b},player2_id.eq.${a})`,
        )
        .eq('status', STATUS_FINISHED);
    if (error) throw error;
    return data ?? [];
}

// ---------- aggregations ----------

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
        wins,
        draws,
        losses,
        goals_for: gf,
        goals_against: ga,
        avg_gf: played ? Number((gf / played).toFixed(4)) : 0,
        avg_ga: played ? Number((ga / played).toFixed(4)) : 0,
    };
}

function buildH2HStats(a, b, matches) {
    // a < b is the canonical ordering; values suffixed _p1 belong to `a`.
    let wins_p1 = 0, wins_p2 = 0, draws = 0;
    let gf_p1 = 0, gf_p2 = 0;
    for (const m of matches) {
        const aIsP1 = m.player1_id === a;
        const aScore = aIsP1 ? m.score1 : m.score2;
        const bScore = aIsP1 ? m.score2 : m.score1;
        if (aScore == null || bScore == null) continue;
        gf_p1 += aScore;
        gf_p2 += bScore;
        if (aScore > bScore) wins_p1 += 1;
        else if (aScore < bScore) wins_p2 += 1;
        else draws += 1;
    }
    const played = wins_p1 + wins_p2 + draws;
    return {
        player1_id: a,
        player2_id: b,
        matches_played: played,
        wins_p1,
        wins_p2,
        draws,
        goals_for_p1: gf_p1,
        goals_for_p2: gf_p2,
        avg_gf_p1: played ? Number((gf_p1 / played).toFixed(4)) : 0,
        avg_gf_p2: played ? Number((gf_p2 / played).toFixed(4)) : 0,
    };
}

async function recalcPlayerStats(playerIds) {
    const rows = [];
    for (const pid of playerIds) {
        const matches = await fetchAllMatchesForPlayer(pid);
        rows.push(buildPlayerStats(pid, matches));
    }
    await upsertChunked('player_stats', rows, 'player_id');
}

async function recalcH2HStats(pairs) {
    const rows = [];
    for (const [a, b] of pairs) {
        const matches = await fetchAllMatchesForPair(a, b);
        rows.push(buildH2HStats(a, b, matches));
    }
    await upsertChunked('h2h_stats', rows, 'player1_id,player2_id');
}

// ---------- main ----------

async function processTournament(rawTournament, nickToCanonId) {
    const tournament = mapTournament(rawTournament);
    if (tournament.id == null) return;

    if (await alreadyComplete(tournament.id)) {
        console.log(`[skip] tournament ${tournament.id} fully finished`);
        return;
    }

    console.log(`[fetch] tournament ${tournament.id} ${tournament.name ?? ''}`);
    const rawMatches = await fetchTournamentMatches(tournament.id);

    const players = new Map();
    const matchRows = [];
    const playerIdSet = new Set();
    const pairSet = new Set();

    for (const raw of rawMatches) {
        const match = mapMatch(raw);
        if (match.player1_id == null || match.player2_id == null) continue;
        const p1Raw = raw.participant1 ?? {};
        const p2Raw = raw.participant2 ?? {};
        if (!p1Raw.nickname || !p2Raw.nickname) continue;
        const canon1 = nickToCanonId.get(p1Raw.nickname.toLowerCase());
        const canon2 = nickToCanonId.get(p2Raw.nickname.toLowerCase());
        if (!canon1 || !canon2) continue;
        // Remap participant ids to the canonical ids we already have stored.
        match.player1_id = canon1;
        match.player2_id = canon2;
        matchRows.push(match);

        // Always upsert the canonical player rows with the latest nickname/photo.
        players.set(canon1, { id: canon1, nickname: p1Raw.nickname, photo: p1Raw.photo ?? null });
        players.set(canon2, { id: canon2, nickname: p2Raw.nickname, photo: p2Raw.photo ?? null });

        playerIdSet.add(canon1);
        playerIdSet.add(canon2);

        const lo = Math.min(canon1, canon2);
        const hi = Math.max(canon1, canon2);
        pairSet.add(`${lo}:${hi}`);
    }

    await upsertChunked('tournaments', [tournament], 'id');
    await upsertChunked('players', [...players.values()], 'id');
    await upsertChunked('matches', matchRows, 'id');

    const pairs = [...pairSet].map((k) => k.split(':').map(Number));
    await recalcPlayerStats([...playerIdSet]);
    await recalcH2HStats(pairs);

    await upsertChunked(
        'scrape_log',
        [{
            tournament_id: tournament.id,
            scraped_at: new Date().toISOString(),
            match_count: matchRows.length,
        }],
    );

    const finishedCount = matchRows.filter((m) => m.status === STATUS_FINISHED).length;
    console.log(
        `[done] tournament ${tournament.id}: ${matchRows.length} matches ` +
        `(${finishedCount} finished), ${players.size} players, ${pairs.length} h2h pairs`,
    );
}

async function main() {
    console.log('Loading tracked nicknames -> canonical ids...');
    const nickToCanonId = await loadNickToCanonId();
    console.log(`Tracking ${nickToCanonId.size} nicknames.`);
    if (nickToCanonId.size === 0) {
        console.error('No tracked players in DB. Seed players first or run cleanup.js.');
        process.exit(1);
    }

    console.log('Fetching tournaments...');
    const tournaments = await fetchAllTournaments();
    console.log(`Found ${tournaments.length} tournaments.`);

    let ok = 0, failed = 0;
    for (const t of tournaments) {
        try {
            await processTournament(t, nickToCanonId);
            ok += 1;
        } catch (err) {
            failed += 1;
            console.error(`[err] tournament ${t?.id}: ${err.message}`);
        }
    }
    console.log(`Done. processed=${ok} failed=${failed}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
