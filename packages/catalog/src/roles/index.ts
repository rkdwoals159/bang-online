import type { RoleDefinition } from "../schema.js";

/** Base-game role definitions imported from outputs/development-plan/data/roles.json. */
export const roles = [
  {
    "id": "sheriff",
    "name": "Sheriff",
    "countsByPlayerCount": {
      "4": 1,
      "5": 1,
      "6": 1,
      "7": 1
    },
    "assetPath": "../assets/cards/roles/01_sceriffo.png"
  },
  {
    "id": "deputy",
    "name": "Deputy",
    "countsByPlayerCount": {
      "4": 0,
      "5": 1,
      "6": 1,
      "7": 2
    },
    "assetPath": "../assets/cards/roles/01_vice.png"
  },
  {
    "id": "outlaw",
    "name": "Outlaw",
    "countsByPlayerCount": {
      "4": 2,
      "5": 2,
      "6": 3,
      "7": 3
    },
    "assetPath": "../assets/cards/roles/01_fuorilegge.png"
  },
  {
    "id": "renegade",
    "name": "Renegade",
    "countsByPlayerCount": {
      "4": 1,
      "5": 1,
      "6": 1,
      "7": 1
    },
    "assetPath": "../assets/cards/roles/01_rinnegato.png"
  }
] satisfies readonly RoleDefinition[];
