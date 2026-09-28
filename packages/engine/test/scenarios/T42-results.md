# T42 engine acceptance scenario results

Status: REVIEW

Each listed acceptance ID maps to one Node test with that exact ID in its test name in [`engine-acceptance.test.ts`](./engine-acceptance.test.ts). There are 78 unique IDs, with no duplicate or unimplemented test declarations.

| Acceptance IDs | Result |
| --- | --- |
| AT-A01, AT-A02, AT-A03, AT-A04, AT-A05, AT-A06, AT-A07, AT-A08, AT-A09, AT-A10, AT-A11, AT-A12, AT-A13, AT-A14, AT-A15 | PASS (15) |
| AT-B01, AT-B02, AT-B03, AT-B04, AT-B05, AT-B06, AT-B07, AT-B08, AT-B09, AT-B10, AT-B11, AT-B12, AT-B13, AT-B14, AT-B15, AT-B16, AT-B17, AT-B18, AT-B19, AT-B20, AT-B21, AT-B22, AT-B23, AT-B24, AT-B25, AT-B26, AT-B27, AT-B28, AT-B29, AT-B30 | PASS (30) |
| AT-C01, AT-C02, AT-C03, AT-C04, AT-C05, AT-C06, AT-C07, AT-C08, AT-C09, AT-C10, AT-C11, AT-C12, AT-C13, AT-C14, AT-C15, AT-C16, AT-C17, AT-C18, AT-C19, AT-C20, AT-C21, AT-C22, AT-C23, AT-C24, AT-C25, AT-C26, AT-C27, AT-C28, AT-C29, AT-C30, AT-C31, AT-C32 | PASS (32) |
| AT-D20 | PASS (1) |
| AT-D01–AT-D19 | Not in T42 scope; owned by T60 |

## Verification

Command:

```powershell
node --experimental-strip-types --loader ./packages/engine/test/setup/ts-source-loader.mjs --test packages/engine/test/scenarios/engine-acceptance.test.ts
```

Result: 78 tests, 78 passed, 0 failed, 0 skipped. Full TAP output is preserved in [`T42-run.tap`](./T42-run.tap).

The harness seeds setup and command RNG, uses a fixed interaction identity/time source, runs every scenario twice, and deep-compares every intermediate snapshot, final state, and ordered event stream. It checks all 80 physical card IDs have exactly one zone owner and runs projection privacy checks after fixture creation and every state transition. Direct setup cases AT-A01–AT-A03 also run zone and projection checks on their initialized states.

AT-C24 follows R27: from HP 2, Dynamite damage 3 leaves a pending rescue that requires two Beer cards; using one Beer leaves rescue pending, and the second raises HP to 1. The final run includes the R27 runtime correction from T85. No remaining observed rule mismatch or open rule question was found in this test set.
