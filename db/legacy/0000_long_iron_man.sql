CREATE TABLE `command_receipts` (
	`actor_player_id` text NOT NULL,
	`command_id` text NOT NULL,
	`match_id` text,
	`room_id` text,
	`request_hash` text NOT NULL,
	`outcome_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`actor_player_id`, `command_id`),
	FOREIGN KEY (`actor_player_id`) REFERENCES `guest_sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "command_receipts_request_hash_check" CHECK(length("command_receipts"."request_hash") > 0),
	CONSTRAINT "command_receipts_outcome_json_check" CHECK(json_valid("command_receipts"."outcome_json")),
	CONSTRAINT "command_receipts_single_aggregate_check" CHECK("command_receipts"."match_id" IS NULL OR "command_receipts"."room_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE `commit_guards` (
	`marker_id` text PRIMARY KEY NOT NULL,
	`aggregate_id` text NOT NULL,
	`expected_version` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "commit_guards_expected_version_check" CHECK("commit_guards"."expected_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE `guest_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`last_seen_at` text,
	CONSTRAINT "guest_sessions_display_name_length_check" CHECK(length("guest_sessions"."display_name") BETWEEN 1 AND 256)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_sessions_token_hash_unique` ON `guest_sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `invite_attempts` (
	`bucket_hash` text PRIMARY KEY NOT NULL,
	`failures_json` text DEFAULT '[]' NOT NULL,
	`last_invalid_at` integer,
	`last_activity_at` integer NOT NULL,
	`retry_delay_ms` integer DEFAULT 0 NOT NULL,
	`retry_at` integer,
	`version` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "invite_attempts_failures_json_check" CHECK(json_valid("invite_attempts"."failures_json") AND json_type("invite_attempts"."failures_json") = 'array'),
	CONSTRAINT "invite_attempts_retry_delay_ms_check" CHECK("invite_attempts"."retry_delay_ms" >= 0),
	CONSTRAINT "invite_attempts_version_check" CHECK("invite_attempts"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE `invite_lookup_reservations` (
	`reservation_id` text PRIMARY KEY NOT NULL,
	`bucket_hash` text NOT NULL,
	`reserved_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`bucket_hash`) REFERENCES `invite_attempts`(`bucket_hash`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "invite_reservations_expiry_check" CHECK("invite_lookup_reservations"."expires_at" > "invite_lookup_reservations"."reserved_at")
);
--> statement-breakpoint
CREATE INDEX `invite_reservations_expiry_idx` ON `invite_lookup_reservations` (`expires_at`);--> statement-breakpoint
CREATE TABLE `match_events` (
	`match_id` text NOT NULL,
	`event_seq` integer NOT NULL,
	`event_id` text NOT NULL,
	`version` integer NOT NULL,
	`type` text NOT NULL,
	`actor_player_id` text,
	`payload_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`match_id`, `event_seq`),
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_player_id`) REFERENCES `guest_sessions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "match_events_event_seq_check" CHECK("match_events"."event_seq" > 0),
	CONSTRAINT "match_events_version_check" CHECK("match_events"."version" > 0),
	CONSTRAINT "match_events_type_check" CHECK(length("match_events"."type") > 0),
	CONSTRAINT "match_events_payload_json_check" CHECK(json_valid("match_events"."payload_json") AND json_type("match_events"."payload_json") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `match_events_event_id_unique` ON `match_events` (`event_id`);--> statement-breakpoint
CREATE INDEX `match_events_match_version_idx` ON `match_events` (`match_id`,`version`);--> statement-breakpoint
CREATE TABLE `match_players` (
	`match_id` text NOT NULL,
	`player_id` text NOT NULL,
	`seat_index` integer NOT NULL,
	`alive` integer NOT NULL,
	`eliminated_at` text,
	`connection_state` text DEFAULT 'disconnected' NOT NULL,
	PRIMARY KEY(`match_id`, `player_id`),
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_id`) REFERENCES `guest_sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "match_players_seat_index_check" CHECK("match_players"."seat_index" BETWEEN 0 AND 6),
	CONSTRAINT "match_players_alive_check" CHECK("match_players"."alive" IN (0, 1)),
	CONSTRAINT "match_players_connection_state_check" CHECK("match_players"."connection_state" IN ('connected', 'disconnected')),
	CONSTRAINT "match_players_eliminated_check" CHECK(("match_players"."alive" = 1 AND "match_players"."eliminated_at" IS NULL) OR ("match_players"."alive" = 0 AND "match_players"."eliminated_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `match_players_match_seat_unique` ON `match_players` (`match_id`,`seat_index`);--> statement-breakpoint
CREATE INDEX `match_players_player_idx` ON `match_players` (`player_id`,`match_id`);--> statement-breakpoint
CREATE TABLE `matches` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`status` text NOT NULL,
	`version` integer NOT NULL,
	`event_seq` integer NOT NULL,
	`ruleset_version` text NOT NULL,
	`state_schema_version` integer NOT NULL,
	`state_json` text NOT NULL,
	`room_version` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "matches_status_check" CHECK("matches"."status" IN ('playing', 'paused', 'completed', 'recovery_required')),
	CONSTRAINT "matches_version_check" CHECK("matches"."version" >= 0),
	CONSTRAINT "matches_event_seq_check" CHECK("matches"."event_seq" >= 0),
	CONSTRAINT "matches_ruleset_version_check" CHECK(length("matches"."ruleset_version") > 0),
	CONSTRAINT "matches_state_schema_version_check" CHECK("matches"."state_schema_version" > 0),
	CONSTRAINT "matches_state_json_check" CHECK(json_valid("matches"."state_json") AND json_type("matches"."state_json") = 'object'),
	CONSTRAINT "matches_room_version_check" CHECK("matches"."room_version" IS NULL OR "matches"."room_version" >= 0)
);
--> statement-breakpoint
CREATE INDEX `matches_status_updated_idx` ON `matches` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `matches_room_latest_idx` ON `matches` (`room_id`,"room_version" desc,"created_at" desc,"started_at" desc,"id" desc);--> statement-breakpoint
CREATE TABLE `outbox` (
	`cursor` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`aggregate_version` integer NOT NULL,
	`event_seq` integer NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`published_at` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "outbox_aggregate_version_check" CHECK("outbox"."aggregate_version" >= 0),
	CONSTRAINT "outbox_event_seq_check" CHECK("outbox"."event_seq" >= 0),
	CONSTRAINT "outbox_kind_check" CHECK("outbox"."kind" IN ('match:changed', 'room:changed')),
	CONSTRAINT "outbox_payload_json_check" CHECK(json_valid("outbox"."payload_json") AND json_type("outbox"."payload_json") = 'object'),
	CONSTRAINT "outbox_retry_count_check" CHECK("outbox"."retry_count" >= 0),
	CONSTRAINT "outbox_payload_kind_check" CHECK((
    ("outbox"."kind" = 'match:changed'
      AND json_type("outbox"."payload_json", '$.matchId') = 'text'
      AND json_type("outbox"."payload_json", '$.version') = 'integer'
      AND json_type("outbox"."payload_json", '$.eventSeq') = 'integer')
    OR
    ("outbox"."kind" = 'room:changed'
      AND json_type("outbox"."payload_json", '$.roomId') = 'text'
      AND json_type("outbox"."payload_json", '$.version') = 'integer')
  ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_event_id_unique` ON `outbox` (`event_id`);--> statement-breakpoint
CREATE INDEX `outbox_unpublished_cursor_idx` ON `outbox` (`cursor`) WHERE "outbox"."published_at" IS NULL;--> statement-breakpoint
CREATE TABLE `room_players` (
	`room_id` text NOT NULL,
	`player_id` text NOT NULL,
	`seat_index` integer NOT NULL,
	`ready` integer DEFAULT 0 NOT NULL,
	`joined_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`last_presence_at` text,
	PRIMARY KEY(`room_id`, `player_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_id`) REFERENCES `guest_sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "room_players_seat_index_check" CHECK("room_players"."seat_index" BETWEEN 0 AND 6),
	CONSTRAINT "room_players_ready_check" CHECK("room_players"."ready" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_players_room_seat_unique` ON `room_players` (`room_id`,`seat_index`);--> statement-breakpoint
CREATE INDEX `room_players_player_idx` ON `room_players` (`player_id`,`room_id`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_player_id` text NOT NULL,
	`invite_code_hash` text NOT NULL,
	`status` text DEFAULT 'waiting' NOT NULL,
	`capacity` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`owner_player_id`) REFERENCES `guest_sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "rooms_status_check" CHECK("rooms"."status" IN ('waiting', 'starting', 'in_game', 'paused', 'completed', 'closed')),
	CONSTRAINT "rooms_capacity_check" CHECK("rooms"."capacity" BETWEEN 4 AND 7),
	CONSTRAINT "rooms_version_check" CHECK("rooms"."version" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_invite_code_hash_unique` ON `rooms` (`invite_code_hash`);--> statement-breakpoint
CREATE INDEX `rooms_status_created_idx` ON `rooms` (`status`,`created_at`);