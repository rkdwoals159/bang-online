import { planDrawPileSupply } from "../draw-pile.js";
import type {
  CharacterAbilityInput,
  CharacterAbilityModule,
  CharacterEffectResult,
} from "../character-api.js";

type BartInput = CharacterAbilityInput<"bart_cassidy">;
type BartSeat = BartInput["state"]["seats"][number];

function uniqueSeat(input: BartInput, playerId: string): BartSeat | undefined {
  const matches = input.state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function noEffect(): CharacterEffectResult {
  return { kind: "applied", events: [], steps: [] };
}

/** C01 runs from T66's damage-resolved hook after R27 rescue has completed. */
export const bartCassidyAbility: CharacterAbilityModule<"bart_cassidy"> = (input) => {
  const hook = input.hook;
  if (
    hook.kind !== "damage_resolved" ||
    hook.victimPlayerId !== input.playerId ||
    !hook.survivedAfterRescue ||
    !Number.isSafeInteger(hook.hpLost) ||
    hook.hpLost <= 0
  ) return noEffect();

  const victim = uniqueSeat(input, input.playerId);
  if (
    !victim ||
    victim.public.characterId !== "bart_cassidy" ||
    victim.public.eliminated ||
    victim.public.hp <= 0
  ) return noEffect();

  const plan = planDrawPileSupply({
    drawPileCardInstanceIds: input.state.zones.drawPileCardInstanceIds,
    discardPileCardInstanceIds: input.state.zones.discardPileCardInstanceIds,
    requestedCount: hook.hpLost,
    actorPlayerId: input.playerId,
    sourceCardInstanceId: hook.source.card.cardInstanceId,
    destination: "hand",
    random: input.random,
  });

  return { kind: "applied", events: plan.events, steps: [] };
};
