import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const STATUS_UPCOMING = 1;
const STATUS_FINISHED = 3;

const RECENT_LIMIT = 10;
const MIN_H2H_FOR_USE = 5;
const W_H2H = 0.35;
const W_FORM = 0.40;
const W_OVERALL = 0.25;
const W_FORM_NO_H2H = 0.60;
const W_OVERALL_NO_H2H = 0.40;
const DRAW_BAND = 0.01;

const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
    process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
});

async function fetchAllRows(table, columns, applyFilter) {
    const PAGE = 1000;
    const all = [];
    let from = 0;
    while (true) {
        let q = supabase.from(table).select(columns).range(from, from + PAGE - 1);
        if (applyFilter) q = applyFilter(q);
        const { data, error } = await q;
        if (error) throw error;
        all.push(...data);
        if (data.length < PAGE) break;
        from += PAGE;
    }
    return all;
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

function relative(a, b, fallback = 0.5) {
    const sum = a + b;
    return sum === 0 ? fallback : a / sum;
}

function weightedFormScore(matches, playerId) {
    if (!matches.length) return 0.5;
    let wsum = 0, denom = 0;
    matches.forEach((m, idx) => {
        const w = matches.length - idx;
        const isP1 = m.player1_id === playerId;
        const own = isP1 ? m.score1 : m.score2;
        const opp = isP1 ? m.score2 : m.score1;
        if (own == null || opp == null) return;
        const pts = own > opp ? 1 : own < opp ? 0 : 0.5;
        wsum += w * pts;
        denom += w;
    });
    return denom ? wsum / denom : 0.5;
}

async function loadRecentForPlayer(playerId) {
    const { data, error } = await supabase
        .from('matches')
        .select('player1_id, player2_id, score1, score2, date')
        .or(`player1_id.eq.${playerId},player2_id.eq.${playerId}`)
        .eq('status', STATUS_FINISHED)
        .order('date', { ascending: false })
        .limit(RECENT_LIMIT);
    if (error) throw error;
    return data ?? [];
}

function predictMatch(match, ctx) {
    const p1Id = match.player1_id;
    const p2Id = match.player2_id;
    const ps1 = ctx.playerStats.get(p1Id);
    const ps2 = ctx.playerStats.get(p2Id);
    const r1 = ctx.recent.get(p1Id) ?? [];
    const r2 = ctx.recent.get(p2Id) ?? [];

    const form1 = weightedFormScore(r1, p1Id);
    const form2 = weightedFormScore(r2, p2Id);
    const relForm = relative(form1, form2);

    const overall1 = ps1 && ps1.matches_played
        ? (ps1.wins + 0.5 * ps1.draws) / ps1.matches_played : 0.5;
    const overall2 = ps2 && ps2.matches_played
        ? (ps2.wins + 0.5 * ps2.draws) / ps2.matches_played : 0.5;
    const relOverall = relative(overall1, overall2);

    const lo = Math.min(p1Id, p2Id);
    const hi = Math.max(p1Id, p2Id);
    const h2h = ctx.h2h.get(`${lo}:${hi}`);
    const haveH2H = h2h && h2h.matches_played >= MIN_H2H_FOR_USE;
    let h2hFactor = null;
    if (haveH2H) {
        const p1IsLo = p1Id === lo;
        const p1Wins = p1IsLo ? h2h.wins_p1 : h2h.wins_p2;
        h2hFactor = (p1Wins + 0.5 * h2h.draws) / h2h.matches_played;
    }

    let score = haveH2H
        ? W_H2H * h2hFactor + W_FORM * relForm + W_OVERALL * relOverall
        : W_FORM_NO_H2H * relForm + W_OVERALL_NO_H2H * relOverall;
    score = clamp01(score);

    let predictedWinnerId = null;
    if (Math.abs(score - 0.5) >= DRAW_BAND) {
        predictedWinnerId = score > 0.5 ? p1Id : p2Id;
    }
    const confidence = Number((Math.max(score, 1 - score) * 100).toFixed(2));

    // Bug #3: use h2h avg when 5+ matches, else player_stats; add ±0.3 variance
    const p1IsLo = p1Id === lo;
    let gf1Raw, gf2Raw;
    if (haveH2H) {
        gf1Raw = Number(p1IsLo ? h2h.avg_gf_p1 : h2h.avg_gf_p2);
        gf2Raw = Number(p1IsLo ? h2h.avg_gf_p2 : h2h.avg_gf_p1);
    } else {
        gf1Raw = Number(ps1?.avg_gf ?? 0);
        gf2Raw = Number(ps2?.avg_gf ?? 0);
    }
    let predScore1 = Math.max(0, Math.round(gf1Raw + (Math.random() * 0.6 - 0.3)));
    let predScore2 = Math.max(0, Math.round(gf2Raw + (Math.random() * 0.6 - 0.3)));

    // Bug #1: scores must strictly reflect the predicted winner
    if (predictedWinnerId === p1Id && predScore1 <= predScore2) {
        predScore1 = predScore2 + 1;
    } else if (predictedWinnerId === p2Id && predScore2 <= predScore1) {
        predScore2 = predScore1 + 1;
    }

    return {
        match_id: match.id,
        predicted_winner_id: predictedWinnerId,
        predicted_score1: predScore1,
        predicted_score2: predScore2,
        confidence,
    };
}

async function generatePredictions() {
    console.log('[predict] loading tracked players...');
    const players = await fetchAllRows('players', 'id');
    const trackedIds = new Set(players.map((p) => p.id));

    console.log('[predict] loading upcoming matches...');
    const upcoming = await fetchAllRows(
        'matches',
        'id, player1_id, player2_id, date',
        (q) => q.eq('status', STATUS_UPCOMING),
    );
    const tracked = upcoming.filter((m) =>
        trackedIds.has(m.player1_id) && trackedIds.has(m.player2_id),
    );
    console.log(`[predict] ${tracked.length}/${upcoming.length} upcoming matches involve tracked players`);
    if (!tracked.length) return;

    console.log('[predict] loading player_stats and h2h_stats...');
    const playerStatsRows = await fetchAllRows('player_stats', '*');
    const playerStats = new Map(playerStatsRows.map((s) => [s.player_id, s]));
    const h2hRows = await fetchAllRows('h2h_stats', '*');
    const h2h = new Map(h2hRows.map((r) => [`${r.player1_id}:${r.player2_id}`, r]));

    const involved = new Set();
    for (const m of tracked) {
        involved.add(m.player1_id);
        involved.add(m.player2_id);
    }
    console.log(`[predict] fetching recent form for ${involved.size} players...`);
    const recent = new Map();
    let i = 0;
    for (const pid of involved) {
        recent.set(pid, await loadRecentForPlayer(pid));
        i += 1;
        if (i % 25 === 0) console.log(`  recent: ${i}/${involved.size}`);
    }

    const ctx = { playerStats, h2h, recent };
    const rows = tracked.map((m) => predictMatch(m, ctx));
    console.log(`[predict] upserting ${rows.length} predictions...`);
    const CHUNK = 500;
    for (let j = 0; j < rows.length; j += CHUNK) {
        const batch = rows.slice(j, j + CHUNK);
        const { error } = await supabase.from('predictions')
            .upsert(batch, { onConflict: 'match_id' });
        if (error) throw new Error(`upsert predictions: ${error.message}`);
    }
    console.log('[predict] generated.');
}

async function evaluatePending() {
    console.log('[evaluate] loading unevaluated predictions...');
    const pending = await fetchAllRows(
        'predictions',
        'id, match_id, predicted_winner_id, predicted_score1, predicted_score2',
        (q) => q.is('evaluated_at', null),
    );
    if (!pending.length) {
        console.log('[evaluate] no unevaluated predictions.');
        return;
    }

    const matchIds = pending.map((p) => p.match_id);
    const matches = [];
    const BATCH = 500;
    for (let i = 0; i < matchIds.length; i += BATCH) {
        const batch = matchIds.slice(i, i + BATCH);
        const { data, error } = await supabase
            .from('matches')
            .select('id, status, score1, score2, player1_id, player2_id')
            .in('id', batch);
        if (error) throw error;
        matches.push(...data);
    }
    const matchById = new Map(matches.map((m) => [m.id, m]));

    const updates = [];
    const now = new Date().toISOString();
    for (const p of pending) {
        const m = matchById.get(p.match_id);
        if (!m || m.status !== STATUS_FINISHED) continue;
        let actualWinnerId = null;
        if (m.score1 > m.score2) actualWinnerId = m.player1_id;
        else if (m.score2 > m.score1) actualWinnerId = m.player2_id;
        const winnerCorrect = p.predicted_winner_id === actualWinnerId;
        const scoreCorrect = p.predicted_score1 === m.score1
            && p.predicted_score2 === m.score2;
        updates.push({
            id: p.id,
            match_id: p.match_id,
            predicted_winner_id: p.predicted_winner_id,
            predicted_score1: p.predicted_score1,
            predicted_score2: p.predicted_score2,
            winner_correct: winnerCorrect,
            score_correct: scoreCorrect,
            evaluated_at: now,
        });
    }
    console.log(`[evaluate] ${updates.length} predictions to mark.`);
    for (let j = 0; j < updates.length; j += BATCH) {
        const batch = updates.slice(j, j + BATCH);
        const { error } = await supabase.from('predictions')
            .upsert(batch, { onConflict: 'id' });
        if (error) throw new Error(`evaluate upsert: ${error.message}`);
    }
    console.log('[evaluate] done.');
}

async function main() {
    await generatePredictions();
    await evaluatePending();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
