import type { PlayCardLegalityErrorCode } from "../rules/legality.js";
import type { RandomSource } from "../random/shuffle.js";
import type { OpenInteractionInput } from "../resolution/index.js";
import type { EffectStep, GameState, JsonValue } from "../state/types.js";

/** Deeply immutable view of the persisted server-side snapshot given to effects. */
export type DeepReadonly<T> = T extends readonly unknown[]
  ? readonly DeepReadonly<T[number]>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/**
 * Engine-resolved target references. A hidden hand is named by owner only;
 * its card instance ID is never part of a hand target.
 */
export type EffectTarget =
  | { readonly kind: "player"; readonly playerId: string }
  | { readonly kind: "hand"; readonly playerId: string }
  | { readonly kind: "in_play_card"; readonly playerId: string; readonly cardInstanceId: string };

/** The target-related failures already produced by T11 legality checks. */
export type IllegalEffectTargetCode = Extract<
  PlayCardLegalityErrorCode,
  | "TARGET_NOT_ALLOWED"
  | "TARGET_NOT_FOUND"
  | "TARGET_NOT_ALIVE"
  | "TARGET_IS_SELF"
  | "TARGET_ZONE_REQUIRED"
  | "TARGET_CARD_REQUIRED"
  | "TARGET_CARD_NOT_IN_PLAY"
  | "TARGET_HAS_NO_CARDS"
  | "TARGET_OUT_OF_RANGE"
>;

/** A completed interaction mapped from T12's persisted continuation result. */
export interface EffectInteractionResponse {
  readonly playerId: string;
  readonly choice: string;
  readonly payload: Readonly<Record<string, JsonValue>>;
}

export interface CompletedEffectInteraction {
  readonly interactionId: string;
  readonly kind: string;
  readonly context: Readonly<Record<string, JsonValue>>;
  readonly responses: readonly EffectInteractionResponse[];
}

/**
 * The semantic part of T12's interaction input. The caller supplies the
 * interaction ID and timestamp when opening it through the resolver.
 */
export type EffectInteractionRequest = Omit<OpenInteractionInput, "interactionId" | "createdAt">;

/** Internal event draft; version, sequence, timestamp, and projection are assigned outside the card module. */
export interface EffectEventDraft {
  readonly type: string;
  readonly actorPlayerId: string | null;
  readonly payload: Readonly<Record<string, JsonValue>>;
}

export interface CardEffectInput {
  /** Server-only snapshot; effects must return events rather than mutate this object. */
  readonly state: DeepReadonly<GameState>;
  readonly actorPlayerId: string;
  readonly sourceCardInstanceId: string | null;
  /** Allocated by the caller so any T12 interaction can resume this frame. */
  readonly continuationFrameId: string;
  /** Targets resolved by the engine. Card effects still validate them against `state`. */
  readonly targets: readonly EffectTarget[];
  /** Every random choice must use this caller-injected, replayable source. */
  readonly random: RandomSource;
  /** Responses already persisted for this continuation, in completion order. */
  readonly completedInteractions: readonly CompletedEffectInteraction[];
}

export type CardEffectResult =
  /** The effect requires a target, but the caller supplied none. */
  | { readonly kind: "target_required" }
  /** A supplied target no longer satisfies the existing T11 target rules. */
  | { readonly kind: "invalid_target"; readonly code: IllegalEffectTargetCode }
  | {
      readonly kind: "applied";
      readonly events: readonly EffectEventDraft[];
      readonly steps: readonly EffectStep[];
    }
  | {
      /** The current effect actor must choose an option before the effect can continue. */
      readonly kind: "choice_required";
      readonly request: EffectInteractionRequest;
      readonly events: readonly EffectEventDraft[];
      readonly steps: readonly EffectStep[];
    }
  | {
      /** One or more affected players must respond before the effect can continue. */
      readonly kind: "response_required";
      readonly request: EffectInteractionRequest;
      readonly events: readonly EffectEventDraft[];
      readonly steps: readonly EffectStep[];
    };

/** Synchronous, deterministic-in-context contract for one card's effect. */
export type CardEffectModule = (input: CardEffectInput) => CardEffectResult;
