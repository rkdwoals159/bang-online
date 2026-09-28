import assert from "node:assert/strict";
import { test } from "node:test";
import { shuffle, type RandomSource } from "../../src/random/shuffle.ts";

function sequenceRandom(values: readonly number[]): RandomSource {
  let cursor = 0;
  return {
    nextFloat() {
      assert.ok(cursor < values.length, "shuffle requested more random values than expected");
      return values[cursor++]!;
    },
  };
}

test("same deck and injected random sequence produce the same order", () => {
  const deck = ["bang-1", "beer-1", "missed-1", "jail-1", "duel-1"];
  const sequence = [0, 0.7, 0.3, 0.8];

  const first = shuffle(deck, sequenceRandom(sequence));
  const second = shuffle(deck, sequenceRandom(sequence));

  assert.deepEqual(first, ["jail-1", "beer-1", "duel-1", "missed-1", "bang-1"]);
  assert.deepEqual(second, first);
  assert.deepEqual(deck, ["bang-1", "beer-1", "missed-1", "jail-1", "duel-1"]);
});

test("shuffle preserves card count and every unique card instance ID", () => {
  const deck = Array.from({ length: 80 }, (_, index) => `card-instance-${index + 1}`);
  const values = Array.from({ length: deck.length - 1 }, (_, index) => ((index * 37) % 97) / 97);

  const result = shuffle(deck, sequenceRandom(values));

  assert.equal(result.length, deck.length);
  assert.deepEqual([...result].sort(), [...deck].sort());
  assert.equal(new Set(result).size, deck.length);
});

test("empty and one-card inputs need no random draws", () => {
  const noDraws: RandomSource = {
    nextFloat() {
      assert.fail("shuffle must not draw randomness for fewer than two items");
    },
  };

  assert.deepEqual(shuffle([], noDraws), []);
  assert.deepEqual(shuffle(["only-card"], noDraws), ["only-card"]);
});

test("rejects values outside the injected random source contract", () => {
  for (const value of [-0.01, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => shuffle(["first", "second"], sequenceRandom([value])),
      { name: "RangeError" },
    );
  }
});
