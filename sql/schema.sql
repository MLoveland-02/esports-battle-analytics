-- Esports Battle Analytics — schema

create table if not exists tournaments (
    id     integer primary key,
    name   text,
    date   timestamptz,
    status integer
);

create table if not exists players (
    id       integer primary key,
    nickname text,
    photo    text
);

create table if not exists matches (
    id            integer primary key,
    tournament_id integer references tournaments(id),
    date          timestamptz,
    status        integer,
    player1_id    integer references players(id),
    player2_id    integer references players(id),
    score1        integer,
    score2        integer,
    half_score1   integer,
    half_score2   integer,
    team1         text,
    team2         text
);

create table if not exists player_stats (
    player_id       integer primary key references players(id),
    matches_played  integer,
    wins            integer,
    draws           integer,
    losses          integer,
    goals_for       integer,
    goals_against   integer,
    avg_gf          numeric,
    avg_ga          numeric
);

create table if not exists h2h_stats (
    id             serial primary key,
    player1_id     integer references players(id),
    player2_id     integer references players(id),
    matches_played integer,
    wins_p1        integer,
    wins_p2        integer,
    draws          integer,
    goals_for_p1   integer,
    goals_for_p2   integer,
    avg_gf_p1      numeric,
    avg_gf_p2      numeric,
    constraint h2h_stats_pair_unique unique (player1_id, player2_id)
);

create table if not exists scrape_log (
    id            serial primary key,
    tournament_id integer,
    scraped_at    timestamptz,
    match_count   integer
);

create index if not exists idx_matches_tournament on matches(tournament_id);
create index if not exists idx_matches_player1    on matches(player1_id);
create index if not exists idx_matches_player2    on matches(player2_id);
create index if not exists idx_matches_status     on matches(status);
create index if not exists idx_h2h_player1        on h2h_stats(player1_id);
create index if not exists idx_h2h_player2        on h2h_stats(player2_id);

create table if not exists predictions (
    id                  serial primary key,
    match_id            integer not null references matches(id),
    predicted_winner_id integer references players(id),
    predicted_score1    integer,
    predicted_score2    integer,
    confidence          numeric,
    winner_correct      boolean,
    score_correct       boolean,
    evaluated_at        timestamptz,
    constraint predictions_match_id_unique unique (match_id)
);

create index if not exists idx_predictions_match  on predictions(match_id);
create index if not exists idx_predictions_winner on predictions(predicted_winner_id);

create table if not exists groups (
    id         serial primary key,
    name       text not null,
    created_at timestamptz not null default now()
);

create table if not exists group_members (
    id         serial primary key,
    group_id   integer not null references groups(id),
    player_id  integer not null references players(id),
    role       text    not null,
    created_at timestamptz not null default now(),
    constraint group_members_unique unique (group_id, player_id),
    constraint group_members_role_check check (role in ('core', 'sub', 'float'))
);

create index if not exists idx_group_members_group  on group_members(group_id);
create index if not exists idx_group_members_player on group_members(player_id);
