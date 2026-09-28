import type { Catalog, CardColor, CardRank, PlayerCount, RoleId, Suit } from "./schema.js";

export type CatalogIssueCode =
  | "INVALID_TYPE"
  | "MISSING_FIELD"
  | "UNKNOWN_FIELD"
  | "INVALID_VALUE"
  | "DUPLICATE_ID"
  | "UNKNOWN_REFERENCE"
  | "UNKNOWN_ASSET_PATH"
  | "INCONSISTENT_COUNT";

export interface CatalogIssue {
  code: CatalogIssueCode;
  path: string;
  message: string;
}

export type CatalogValidationResult =
  | { ok: true; catalog: Catalog }
  | { ok: false; issues: CatalogIssue[] };

export interface ValidateCatalogOptions {
  /** Exact, normalized paths supplied by the asset manifest adapter. */
  knownAssetPaths: ReadonlySet<string> | readonly string[];
}

const CARD_COLORS: readonly CardColor[] = ["blue", "brown"];
const SUITS: readonly Suit[] = ["SPADES", "HEARTS", "DIAMONDS", "CLUBS"];
const ROLE_IDS: readonly RoleId[] = ["sheriff", "deputy", "outlaw", "renegade"];
const PLAYER_COUNTS: readonly PlayerCount[] = [4, 5, 6, 7];
const PLAYER_COUNT_KEYS = PLAYER_COUNTS.map(String);
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyText = (value: unknown, maxLength = 128): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;

const isId = (value: unknown): value is string =>
  typeof value === "string" && ID_PATTERN.test(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function issue(
  issues: CatalogIssue[],
  code: CatalogIssueCode,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function readObject(
  value: unknown,
  path: string,
  keys: readonly string[],
  issues: CatalogIssue[],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    issue(issues, "INVALID_TYPE", path, "Expected an object.");
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      issue(issues, "UNKNOWN_FIELD", `${path}.${key}`, "Field is not part of the catalog schema.");
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      issue(issues, "MISSING_FIELD", `${path}.${key}`, "Required field is missing.");
    }
  }
  return value;
}

function validateAssetPath(
  value: unknown,
  path: string,
  knownAssetPaths: ReadonlySet<string>,
  issues: CatalogIssue[],
): void {
  if (!isNonEmptyText(value, 512)) {
    issue(issues, "INVALID_TYPE", path, "Expected a non-empty asset path.");
    return;
  }

  const isRelativePath =
    !value.startsWith("/") &&
    !/^[a-z][a-z0-9+.-]*:/i.test(value) &&
    !/^[a-z]:/i.test(value) &&
    !value.includes("\\") &&
    !/[?#\u0000-\u001f]/.test(value) &&
    !value.split("/").some((segment) => segment === "" || segment === ".");

  if (!isRelativePath) {
    issue(issues, "INVALID_VALUE", path, "Asset paths must be normalized relative paths.");
    return;
  }
  if (!knownAssetPaths.has(value)) {
    issue(issues, "UNKNOWN_ASSET_PATH", path, `Asset path is not in the known asset set: ${value}`);
  }
}

function validateCardDefinition(
  value: unknown,
  path: string,
  knownAssetPaths: ReadonlySet<string>,
  issues: CatalogIssue[],
): void {
  const record = readObject(value, path, ["typeId", "name", "quantity", "color", "assetPath"], issues);
  if (!record) return;
  if (!isId(record.typeId)) issue(issues, "INVALID_VALUE", `${path}.typeId`, "Expected a stable lowercase identifier.");
  if (!isNonEmptyText(record.name)) issue(issues, "INVALID_VALUE", `${path}.name`, "Expected a non-empty name.");
  if (!isNonNegativeInteger(record.quantity)) issue(issues, "INVALID_VALUE", `${path}.quantity`, "Quantity must be a non-negative safe integer.");
  if (typeof record.color !== "string" || !CARD_COLORS.includes(record.color as CardColor)) {
    issue(issues, "INVALID_VALUE", `${path}.color`, "Color must be 'blue' or 'brown'.");
  }
  validateAssetPath(record.assetPath, `${path}.assetPath`, knownAssetPaths, issues);
}

function isCardRank(value: unknown): value is CardRank {
  return (
    (typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= 10) ||
    (typeof value === "string" && ["A", "J", "Q", "K"].includes(value))
  );
}

function validatePhysicalCard(value: unknown, path: string, issues: CatalogIssue[]): void {
  const record = readObject(value, path, ["definitionId", "typeId", "rank", "suit", "copyIndex"], issues);
  if (!record) return;
  if (!isId(record.definitionId)) issue(issues, "INVALID_VALUE", `${path}.definitionId`, "Expected a stable lowercase identifier.");
  if (!isId(record.typeId)) issue(issues, "INVALID_VALUE", `${path}.typeId`, "Expected a stable lowercase identifier.");
  if (!isCardRank(record.rank)) issue(issues, "INVALID_VALUE", `${path}.rank`, "Rank must be an integer from 2 to 10 or A, J, Q, K.");
  if (typeof record.suit !== "string" || !SUITS.includes(record.suit as Suit)) {
    issue(issues, "INVALID_VALUE", `${path}.suit`, "Suit must be SPADES, HEARTS, DIAMONDS, or CLUBS.");
  }
  if (!isNonNegativeInteger(record.copyIndex)) issue(issues, "INVALID_VALUE", `${path}.copyIndex`, "Copy index must be a non-negative safe integer.");
}

function validateRole(
  value: unknown,
  path: string,
  knownAssetPaths: ReadonlySet<string>,
  issues: CatalogIssue[],
): void {
  const record = readObject(value, path, ["id", "name", "countsByPlayerCount", "assetPath"], issues);
  if (!record) return;
  if (typeof record.id !== "string" || !ROLE_IDS.includes(record.id as RoleId)) {
    issue(issues, "INVALID_VALUE", `${path}.id`, "Unknown base-game role id.");
  }
  if (!isNonEmptyText(record.name)) issue(issues, "INVALID_VALUE", `${path}.name`, "Expected a non-empty name.");

  const counts = readObject(record.countsByPlayerCount, `${path}.countsByPlayerCount`, PLAYER_COUNT_KEYS, issues);
  if (counts) {
    for (const playerCount of PLAYER_COUNTS) {
      const count = counts[String(playerCount)];
      if (!isNonNegativeInteger(count)) {
        issue(issues, "INVALID_VALUE", `${path}.countsByPlayerCount.${playerCount}`, "Role count must be a non-negative safe integer.");
      }
    }
  }
  validateAssetPath(record.assetPath, `${path}.assetPath`, knownAssetPaths, issues);
}

function validateCharacter(
  value: unknown,
  path: string,
  knownAssetPaths: ReadonlySet<string>,
  issues: CatalogIssue[],
): void {
  const record = readObject(value, path, ["id", "name", "baseHealth", "ruleId", "assetPath"], issues);
  if (!record) return;
  if (!isId(record.id)) issue(issues, "INVALID_VALUE", `${path}.id`, "Expected a stable lowercase identifier.");
  if (!isNonEmptyText(record.name)) issue(issues, "INVALID_VALUE", `${path}.name`, "Expected a non-empty name.");
  if (!Number.isSafeInteger(record.baseHealth) || typeof record.baseHealth !== "number" || record.baseHealth <= 0) {
    issue(issues, "INVALID_VALUE", `${path}.baseHealth`, "Base health must be a positive safe integer.");
  }
  if (!isNonEmptyText(record.ruleId, 64)) issue(issues, "INVALID_VALUE", `${path}.ruleId`, "Expected a non-empty rules reference.");
  validateAssetPath(record.assetPath, `${path}.assetPath`, knownAssetPaths, issues);
}

function validateArray(
  value: unknown,
  path: string,
  issues: CatalogIssue[],
): unknown[] | undefined {
  if (!Array.isArray(value)) {
    issue(issues, "INVALID_TYPE", path, "Expected an array.");
    return undefined;
  }
  return value;
}

function validateUniqueIds(
  values: unknown[],
  field: string,
  path: string,
  issues: CatalogIssue[],
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (!isRecord(value) || !isId(value[field])) return;
    const id = value[field] as string;
    if (seen.has(id)) issue(issues, "DUPLICATE_ID", `${path}[${index}].${field}`, `Duplicate identifier '${id}'.`);
    else seen.add(id);
  });
}

/**
 * Validates catalog data and all cross-references without executing card or
 * character behavior. Asset paths are checked against the caller's manifest set.
 */
export function validateCatalog(
  value: unknown,
  options: ValidateCatalogOptions,
): CatalogValidationResult {
  const issues: CatalogIssue[] = [];
  const knownAssetPaths = new Set(options.knownAssetPaths);
  const top = readObject(
    value,
    "$",
    ["rulesetVersion", "cardDefinitions", "physicalCards", "roles", "characters"],
    issues,
  );
  if (!top) return { ok: false, issues };

  if (!isNonEmptyText(top.rulesetVersion, 64)) {
    issue(issues, "INVALID_VALUE", "$.rulesetVersion", "Expected a non-empty ruleset version.");
  }

  const cardDefinitions = validateArray(top.cardDefinitions, "$.cardDefinitions", issues);
  const physicalCards = validateArray(top.physicalCards, "$.physicalCards", issues);
  const roles = validateArray(top.roles, "$.roles", issues);
  const characters = validateArray(top.characters, "$.characters", issues);

  cardDefinitions?.forEach((entry, index) => validateCardDefinition(entry, `$.cardDefinitions[${index}]`, knownAssetPaths, issues));
  physicalCards?.forEach((entry, index) => validatePhysicalCard(entry, `$.physicalCards[${index}]`, issues));
  roles?.forEach((entry, index) => validateRole(entry, `$.roles[${index}]`, knownAssetPaths, issues));
  characters?.forEach((entry, index) => validateCharacter(entry, `$.characters[${index}]`, knownAssetPaths, issues));

  if (cardDefinitions) validateUniqueIds(cardDefinitions, "typeId", "$.cardDefinitions", issues);
  if (physicalCards) validateUniqueIds(physicalCards, "definitionId", "$.physicalCards", issues);
  if (roles) validateUniqueIds(roles, "id", "$.roles", issues);
  if (characters) validateUniqueIds(characters, "id", "$.characters", issues);

  if (cardDefinitions && physicalCards) {
    const definitionsById = new Map<string, Record<string, unknown>>();
    for (const definition of cardDefinitions) {
      if (isRecord(definition) && isId(definition.typeId)) definitionsById.set(definition.typeId, definition);
    }
    const physicalCountByTypeId = new Map<string, number>();
    physicalCards.forEach((card, index) => {
      if (!isRecord(card) || !isId(card.typeId)) return;
      const definition = definitionsById.get(card.typeId);
      if (!definition) {
        issue(issues, "UNKNOWN_REFERENCE", `$.physicalCards[${index}].typeId`, `Unknown card type '${card.typeId}'.`);
        return;
      }
      physicalCountByTypeId.set(card.typeId, (physicalCountByTypeId.get(card.typeId) ?? 0) + 1);
    });
    for (const [typeId, definition] of definitionsById) {
      if (!isNonNegativeInteger(definition.quantity)) continue;
      const physicalCount = physicalCountByTypeId.get(typeId) ?? 0;
      if (physicalCount !== definition.quantity) {
        issue(
          issues,
          "INCONSISTENT_COUNT",
          `$.cardDefinitions[${typeId}].quantity`,
          `Quantity is ${definition.quantity}, but ${physicalCount} physical card(s) reference this type.`,
        );
      }
    }
  }

  if (roles) {
    for (const playerCount of PLAYER_COUNTS) {
      let total = 0;
      let allCountsValid = true;
      for (const role of roles) {
        if (!isRecord(role) || !isRecord(role.countsByPlayerCount)) {
          allCountsValid = false;
          continue;
        }
        const count = role.countsByPlayerCount[String(playerCount)];
        if (!isNonNegativeInteger(count)) allCountsValid = false;
        else total += count;
      }
      if (allCountsValid && total !== playerCount) {
        issue(issues, "INCONSISTENT_COUNT", `$.roles`, `Role counts for ${playerCount} players must total ${playerCount}; got ${total}.`);
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, catalog: value as Catalog };
}
