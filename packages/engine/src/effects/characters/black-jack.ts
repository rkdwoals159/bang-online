import { planDrawPileSupply } from "../draw-pile.js";
import type {
  BlackJackDrawSlotHookInput,
  CharacterAbilityInput,
  CharacterAbilityModule,
  CharacterEffectResult,
} from "../character-api.js";

type BlackJackInput = CharacterAbilityInput<"black_jack">;
type BlackJackSeat = BlackJackInput["state"]["seats"][number];

function noEffect(): CharacterEffectResult {
  return { kind: "applied", events: [], steps: [] };
}

function uniqueSeat(input: BlackJackInput, playerId: string): BlackJackSeat | undefined {
  const matches = input.state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function isPublicSecondTurnDraw(hook: BlackJackDrawSlotHookInput): boolean {
  return hook.kind === "draw_slot" &&
    hook.timing === "after" &&
    hook.distribution.kind === "normal_turn" &&
    hook.distribution.position === "second" &&
    hook.source.kind === "draw_pile" &&
    hook.visibility === "public";
}

/** C02 checks only the exposed second card; its bonus card remains a private draw. */
export const blackJackAbility: CharacterAbilityModule<"black_jack"> = (input) => {
  const hook = input.hook;
  if (!isPublicSecondTurnDraw(hook)) return noEffect();

  const player = uniqueSeat(input, input.playerId);
  if (
    !player ||
    player.public.characterId !== "black_jack" ||
    player.public.eliminated ||
    player.public.hp <= 0
  ) return noEffect();

  if (hook.card.suit !== "HEARTS" && hook.card.suit !== "DIAMONDS") return noEffect();

  const plan = planDrawPileSupply({
    drawPileCardInstanceIds: input.state.zones.drawPileCardInstanceIds,
    discardPileCardInstanceIds: input.state.zones.discardPileCardInstanceIds,
    requestedCount: 1,
    actorPlayerId: input.playerId,
    sourceCardInstanceId: null,
    destination: "hand",
    random: input.random,
  });

  return { kind: "applied", events: plan.events, steps: [] };
};
