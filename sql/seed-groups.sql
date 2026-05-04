-- Seeds the 7 groups + a "Float Pool" (group 8) for unassigned players.
-- Idempotent: re-runnable. Player nicknames are matched case-insensitively
-- against the players table, so this resolves correctly to the canonical
-- player IDs left after cleanup.

insert into groups (id, name) values
    (1, 'Group 1'),
    (2, 'Group 2'),
    (3, 'Group 3'),
    (4, 'Group 4'),
    (5, 'Group 5'),
    (6, 'Group 6'),
    (7, 'Group 7'),
    (8, 'Float Pool')
on conflict (id) do nothing;

-- Keep the serial in sync so future inserts via API don't collide.
select setval('groups_id_seq', greatest((select max(id) from groups), 8), true);

insert into group_members (group_id, player_id, role)
select g.group_id, p.id, g.role
from (values
    (1, 'SPACE',         'core'),
    (1, 'cl1vlind',      'core'),
    (1, 'JKey',          'core'),
    (1, 'hrk',           'core'),
    (1, 'DangerDim77',   'core'),

    (2, 'borees',        'core'),
    (2, 'hyper',         'core'),
    (2, 'kaluba',        'core'),
    (2, 'giox',          'core'),
    (2, 'sef',           'core'),

    (3, 'boulevard',     'core'),
    (3, 'jekunam',       'core'),
    (3, 'labotryas',     'core'),
    (3, 'dava',          'core'),
    (3, 'sane4ek8',      'core'),
    (3, 'dm1trena',      'sub'),

    (4, 'lukapaja',      'core'),
    (4, 'peconi',        'core'),
    (4, 'lzrn',          'core'),
    (4, 'donatello',     'core'),
    (4, 'maki',          'core'),

    (5, 'noltzer',       'core'),
    (5, 'lx7ss',         'core'),
    (5, 'maslja',        'core'),
    (5, 'blueeyes',      'core'),
    (5, 'gangsta_panda', 'core'),

    (6, 'dor1an',        'core'),
    (6, 'wboy',          'core'),
    (6, 'uncle',         'core'),
    (6, 'bomb1to',       'core'),
    (6, 'laikingdast',   'core'),
    (6, 'v1nn',          'sub'),
    (6, 'mko1919',       'sub'),
    (6, 'nikkitta',      'sub'),

    (7, 'inquisitor',    'core'),
    (7, 'kodak',         'core'),
    (7, 'rossfcdk',      'core'),
    (7, 'meltosik',      'core'),
    (7, 'hotshot',       'core'),

    (8, 'OG',            'float'),
    (8, 'hit',           'float'),
    (8, 'chevare',       'float'),
    (8, 'lumix',         'float'),
    (8, 'rodja',         'float'),
    (8, 'gaga',          'float'),
    (8, 'decade',        'float'),
    (8, 'special',       'float'),
    (8, 'cofardi',       'float'),
    (8, 'ganger_29',     'float'),
    (8, 'hristian05',    'float'),
    (8, 'duka',          'float'),
    (8, 'kray',          'float'),
    (8, 'kraftvk',       'float'),
    (8, 'linox',         'float'),
    (8, 'paka',          'float'),
    (8, 'smidzii',       'float')
) as g(group_id, nick, role)
join players p on lower(p.nickname) = lower(g.nick)
on conflict (group_id, player_id) do nothing;
