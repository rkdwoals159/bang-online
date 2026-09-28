CREATE TABLE guest_sessions (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz
);

CREATE TABLE rooms (
  id text PRIMARY KEY,
  owner_player_id text NOT NULL REFERENCES guest_sessions(id) ON DELETE RESTRICT,
  invite_code_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting', 'starting', 'in_game', 'paused', 'completed', 'closed')),
  capacity smallint NOT NULL CHECK (capacity BETWEEN 4 AND 7),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE room_players (
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  player_id text NOT NULL REFERENCES guest_sessions(id) ON DELETE RESTRICT,
  seat_index smallint NOT NULL CHECK (seat_index BETWEEN 0 AND 6),
  ready boolean NOT NULL DEFAULT false,
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_presence_at timestamptz,
  PRIMARY KEY (room_id, player_id),
  UNIQUE (room_id, seat_index)
);

CREATE TABLE matches (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('playing', 'paused', 'completed', 'recovery_required')),
  version bigint NOT NULL CHECK (version >= 0),
  event_seq bigint NOT NULL CHECK (event_seq >= 0),
  ruleset_version text NOT NULL CHECK (length(ruleset_version) > 0),
  state_schema_version integer NOT NULL CHECK (state_schema_version > 0),
  state_json jsonb NOT NULL CHECK (jsonb_typeof(state_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

CREATE TABLE match_players (
  match_id text NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id text NOT NULL REFERENCES guest_sessions(id) ON DELETE RESTRICT,
  seat_index smallint NOT NULL CHECK (seat_index BETWEEN 0 AND 6),
  alive boolean NOT NULL,
  eliminated_at timestamptz,
  connection_state text NOT NULL DEFAULT 'disconnected'
    CHECK (connection_state IN ('connected', 'disconnected')),
  PRIMARY KEY (match_id, player_id),
  UNIQUE (match_id, seat_index),
  CHECK ((alive AND eliminated_at IS NULL) OR (NOT alive AND eliminated_at IS NOT NULL))
);

CREATE TABLE match_events (
  match_id text NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  event_seq bigint NOT NULL CHECK (event_seq > 0),
  event_id text NOT NULL UNIQUE,
  version bigint NOT NULL CHECK (version > 0),
  type text NOT NULL CHECK (length(type) > 0),
  actor_player_id text REFERENCES guest_sessions(id) ON DELETE SET NULL,
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, event_seq)
);

CREATE TABLE command_receipts (
  actor_player_id text NOT NULL REFERENCES guest_sessions(id) ON DELETE RESTRICT,
  command_id text NOT NULL,
  match_id text REFERENCES matches(id) ON DELETE RESTRICT,
  room_id text REFERENCES rooms(id) ON DELETE RESTRICT,
  request_hash text NOT NULL CHECK (length(request_hash) > 0),
  outcome_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_player_id, command_id),
  CHECK (match_id IS NULL OR room_id IS NULL)
);

CREATE TABLE outbox (
  event_id text PRIMARY KEY,
  aggregate_id text NOT NULL,
  aggregate_version bigint NOT NULL CHECK (aggregate_version >= 0),
  event_seq bigint NOT NULL CHECK (event_seq >= 0),
  kind text NOT NULL CHECK (kind IN ('match:changed', 'room:changed')),
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  CHECK (
    (kind = 'match:changed'
      AND payload_json ?& ARRAY['matchId', 'version', 'eventSeq']
      AND payload_json - ARRAY['matchId', 'version', 'eventSeq']::text[] = '{}'::jsonb)
    OR
    (kind = 'room:changed'
      AND payload_json ?& ARRAY['roomId', 'version']
      AND payload_json - ARRAY['roomId', 'version']::text[] = '{}'::jsonb)
  )
);

CREATE INDEX rooms_status_created_idx ON rooms(status, created_at);
CREATE INDEX room_players_player_idx ON room_players(player_id, room_id);
CREATE INDEX matches_status_updated_idx ON matches(status, updated_at);
CREATE INDEX match_players_player_idx ON match_players(player_id, match_id);
CREATE INDEX match_events_match_version_idx ON match_events(match_id, version);
CREATE INDEX outbox_unpublished_created_idx ON outbox(created_at, event_id) WHERE published_at IS NULL;
