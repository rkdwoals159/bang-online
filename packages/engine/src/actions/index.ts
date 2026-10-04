import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.js";
import type { LegalActionProposal } from "../../../contracts/src/protocol.js";
import { applyMatchCommand, validateAbility, validatePlayCard, type ApplyMatchCommandContext, type EngineCommand } from "../commands/index.js";
import { createEffectCommandHandlers } from "../effects/runtime/index.js";
import { createEffectRegistry } from "../effects/registry.js";
import type { GameState } from "../state/types.js";

const CARD_TYPE_BY_DEFINITION_ID = new Map(
  BASE_PHYSICAL_CARDS.map(({ definitionId, typeId }) => [definitionId, typeId]),
);
const TARGETED_CARD_TYPES = new Set(["bang", "duel", "jail", "panic", "cat_balou"]);
const INTERACTION_TIMESTAMP = "2000-01-01T00:00:00.000Z";
// Modules are pure. Reuse the immutable registrations; probe identities stay local.
const PROBE_REGISTRY = createEffectRegistry();
// These effects add no legality beyond T14's pure gate on an idle play turn.
// Cards that draw, choose, or affect every player still use full effect probes.
const PURE_GATE_CARD_TYPES = new Set([
  "bang", "beer", "duel", "jail", "barrel", "dynamite", "mustang", "scope",
  "volcanic", "schofield", "remington", "carabine", "winchester",
]);

type CandidateCommand = Extract<EngineCommand, { type: "PLAY_CARD" | "USE_ABILITY" | "END_TURN" }>;

function resolutionIsIdle(state: GameState): boolean {
  const resolution = state.resolution;
  return resolution.effectQueue.length === 0 &&
    resolution.continuations.length === 0 &&
    resolution.pendingInteraction === null &&
    resolution.pendingDeath === null &&
    resolution.victoryCheckDeferredByEffectId === null;
}

function makeProbeContext(): ApplyMatchCommandContext {
  let interactionIndex = 0;
  const handlers = createEffectCommandHandlers({
    registry: PROBE_REGISTRY,
    nextInteractionIdentity: () => {
      interactionIndex += 1;
      return {
        interactionId: `legal-action-probe-${interactionIndex}`,
        createdAt: INTERACTION_TIMESTAMP,
      };
    },
  });
  return {
    random: { nextFloat: () => 0.5 },
    interaction: {
      interactionId: "legal-action-probe-turn-discard",
      createdAt: INTERACTION_TIMESTAMP,
    },
    handlers,
  };
}

/**
 * Builds complete normal-command proposals by submitting each deterministic
 * card candidate to T14 with the base typed effect registry. Sid costs use
 * T14's pure validation: discarding two cards and capped healing require no
 * speculative effect execution. Probe RNG and
 * interaction IDs are local throwaway inputs; they never alter the source
 * state or become part of a proposal.
 */
export function buildLegalActionCandidates(
  state: GameState,
  actorPlayerId: string,
): LegalActionProposal[] {
  if (state.status !== "playing" || state.turn.currentPlayerId !== actorPlayerId ||
      state.turn.phase !== "play" || !resolutionIsIdle(state)) return [];

  const actorMatches = state.seats.filter((seat) => seat.public.playerId === actorPlayerId);
  if (actorMatches.length !== 1 || actorMatches[0]!.public.eliminated) return [];
  const actor = actorMatches[0]!;
  const livingSeats = [...state.seats]
    .filter((seat) => !seat.public.eliminated)
    .sort((left, right) => left.public.seatIndex - right.public.seatIndex);
  const proposals: LegalActionProposal[] = [];

  const proposeIfAccepted = (command: CandidateCommand): void => {
    if (command.type === "PLAY_CARD") {
      const legal = validatePlayCard(state, actorPlayerId, command);
      if (!legal.ok) return;
      if (!PURE_GATE_CARD_TYPES.has(legal.cardTypeId) &&
          !applyMatchCommand(state, actorPlayerId, command, makeProbeContext()).ok) return;
    } else if (!applyMatchCommand(state, actorPlayerId, command, makeProbeContext()).ok) return;
    switch (command.type) {
      case "PLAY_CARD":
        proposals.push({ type: "PLAY_CARD", payload: command.payload });
        break;
      case "USE_ABILITY":
        proposals.push({ type: "USE_ABILITY", payload: command.payload });
        break;
      case "END_TURN":
        proposals.push({ type: "END_TURN", payload: command.payload });
        break;
    }
  };

  for (const cardInstanceId of actor.private.handCardInstanceIds) {
    const card = state.zones.cardsByInstanceId[cardInstanceId];
    if (!card || card.cardInstanceId !== cardInstanceId) continue;
    const physicalType = CARD_TYPE_BY_DEFINITION_ID.get(card.cardDefinitionId);
    if (!physicalType) continue;
    const convertedToBang = physicalType === "missed" && actor.public.characterId === "calamity_janet";
    const effectiveType = convertedToBang ? "bang" : physicalType;
    if (effectiveType === "missed") continue;

    if (!TARGETED_CARD_TYPES.has(effectiveType)) {
      proposeIfAccepted({
        type: "PLAY_CARD",
        payload: {
          cardInstanceId,
          ...(convertedToBang ? { asCardType: "bang" } : {}),
        },
      });
      continue;
    }

    for (const target of livingSeats) {
      if (effectiveType === "panic" || effectiveType === "cat_balou") {
        proposeIfAccepted({
          type: "PLAY_CARD",
          payload: {
            cardInstanceId,
            targetPlayerId: target.public.playerId,
            targetZone: "HAND",
          },
        });
        for (const targetCardInstanceId of target.public.inPlayCardInstanceIds) {
          proposeIfAccepted({
            type: "PLAY_CARD",
            payload: {
              cardInstanceId,
              targetPlayerId: target.public.playerId,
              targetZone: "IN_PLAY",
              targetCardInstanceId,
            },
          });
        }
        continue;
      }

      proposeIfAccepted({
        type: "PLAY_CARD",
        payload: {
          cardInstanceId,
          targetPlayerId: target.public.playerId,
          ...(convertedToBang ? { asCardType: "bang" } : {}),
        },
      });
    }
  }

  if (actor.public.characterId === "sid_ketchum") {
    // Validate each cost's ownership once instead of traversing all 80 card
    // locations for every pair in a simulated effect. Malformed costs fail closed.
    const locations = new Map<string, number>();
    const record = (ids: readonly string[]) => ids.forEach((id) => locations.set(id, (locations.get(id) ?? 0) + 1));
    record(state.zones.drawPileCardInstanceIds);
    record(state.zones.discardPileCardInstanceIds);
    record(state.zones.revealedPoolCardInstanceIds);
    for (const seat of state.seats) {
      record(seat.private.handCardInstanceIds);
      record(seat.public.inPlayCardInstanceIds);
    }
    const hand = actor.private.handCardInstanceIds.filter((id) => {
      const card = state.zones.cardsByInstanceId[id];
      return locations.get(id) === 1 && card?.cardInstanceId === id && CARD_TYPE_BY_DEFINITION_ID.has(card.cardDefinitionId);
    });
    for (let first = 0; first < hand.length; first += 1) {
      for (let second = first + 1; second < hand.length; second += 1) {
        const command: Extract<EngineCommand, { type: "USE_ABILITY" }> = {
          type: "USE_ABILITY",
          payload: {
            abilityId: "sid-ketchum",
            cardInstanceIds: [hand[first]!, hand[second]!],
          },
        };
        if (!validateAbility(state, actorPlayerId, command)) {
          proposals.push({ type: command.type, payload: command.payload });
        }
      }
    }
  }

  proposeIfAccepted({ type: "END_TURN", payload: {} });
  return proposals;
}
