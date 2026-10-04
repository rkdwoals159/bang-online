// Test-only reference implementation before the performance audit.
import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.js";
import type { LegalActionProposal } from "../../../contracts/src/protocol.js";
import { applyMatchCommand, type ApplyMatchCommandContext, type EngineCommand } from "../../src/commands/index.js";
import { createEffectCommandHandlers } from "../../src/effects/runtime/index.js";
import { createEffectRegistry } from "../../src/effects/registry.js";
import type { GameState } from "../../src/state/types.js";

const CARD_TYPE_BY_DEFINITION_ID = new Map(
  BASE_PHYSICAL_CARDS.map(({ definitionId, typeId }) => [definitionId, typeId]),
);
const TARGETED_CARD_TYPES = new Set(["bang", "duel", "jail", "panic", "cat_balou"]);
const INTERACTION_TIMESTAMP = "2000-01-01T00:00:00.000Z";

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
    registry: createEffectRegistry(),
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
 * candidate to T14 with the base typed effect registry. Probe RNG and
 * interaction IDs are local throwaway inputs; they never alter the source
 * state or become part of a proposal.
 */
export function buildReferenceActionCandidates(
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
    const result = applyMatchCommand(state, actorPlayerId, command, makeProbeContext());
    if (!result.ok) return;
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
    const hand = actor.private.handCardInstanceIds;
    for (let first = 0; first < hand.length; first += 1) {
      for (let second = first + 1; second < hand.length; second += 1) {
        proposeIfAccepted({
          type: "USE_ABILITY",
          payload: {
            abilityId: "sid-ketchum",
            cardInstanceIds: [hand[first]!, hand[second]!],
          },
        });
      }
    }
  }

  proposeIfAccepted({ type: "END_TURN", payload: {} });
  return proposals;
}
