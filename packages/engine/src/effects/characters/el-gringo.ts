import type { EffectEventDraft } from "../api.js";
import type {
  CharacterAbilityInput,
  CharacterAbilityModule,
  CharacterEffectResult,
} from "../character-api.js";

type CharacterSeat = CharacterAbilityInput<"el_gringo">["state"]["seats"][number];

function uniqueSeat(
  state: CharacterAbilityInput<"el_gringo">["state"],
  playerId: string,
): CharacterSeat | undefined {
  const matches = state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function noEffect(): CharacterEffectResult {
  return { kind: "applied", events: [], steps: [] };
}

function randomIndex(length: number, input: CharacterAbilityInput<"el_gringo">): number {
  const sample = input.random.nextFloat();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError("RandomSource.nextFloat() must return a finite value in [0, 1).");
  }
  return Math.floor(sample * length);
}

/** C04 runs only from T65's post-R27 damage hook, after rescue has completed. */
export const elGringoAbility: CharacterAbilityModule<"el_gringo"> = (input) => {
  const hook = input.hook;
  if (
    hook.victimPlayerId !== input.playerId ||
    !hook.survivedAfterRescue ||
    !Number.isSafeInteger(hook.hpLost) ||
    hook.hpLost <= 0
  ) return noEffect();

  const sourcePlayerId = hook.source.playerId;
  if (
    hook.source.cause === "DYNAMITE" ||
    hook.source.card.cardInstanceId === null ||
    sourcePlayerId === null ||
    sourcePlayerId === input.playerId
  ) return noEffect();

  const victim = uniqueSeat(input.state, input.playerId);
  const source = uniqueSeat(input.state, sourcePlayerId);
  if (
    !victim || victim.public.characterId !== "el_gringo" || victim.public.eliminated || victim.public.hp <= 0 ||
    !source
  ) return noEffect();

  // Take without replacement: each actual HP lost can yield at most one card,
  // and an empty source hand naturally ends the loop early.
  const candidates = [...new Set(source.private.handCardInstanceIds)];
  const events: EffectEventDraft[] = [];
  for (let index = 0; index < hook.hpLost && candidates.length > 0; index += 1) {
    const cardInstanceId = candidates.splice(randomIndex(candidates.length, input), 1)[0]!;
    events.push({
      type: "CARD_TRANSFERRED",
      actorPlayerId: input.playerId,
      payload: {
        sourceCardInstanceId: hook.source.card.cardInstanceId,
        cardInstanceId,
        fromPlayerId: sourcePlayerId,
        fromZone: "hand",
        toPlayerId: input.playerId,
        toZone: "hand",
      },
    });
  }

  return { kind: "applied", events, steps: [] };
};
