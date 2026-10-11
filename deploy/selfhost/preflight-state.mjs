import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { decodeMatchState } from './state-validator.mjs';
const base = `${homedir()}/.bang-online`;
const require = createRequire(`${base}/current/package.json`);
const { Client } = require('pg');
const environment = Object.fromEntries((await readFile(`${base}/config/server.env`, 'utf8')).split('\n')
  .filter(line => line.includes('=') && !line.startsWith('#')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const client = new Client({ connectionString: environment.DATABASE_URL });
await client.connect();
try {
  const { rows } = await client.query('SELECT status,version,event_seq,ruleset_version,state_schema_version,state_json FROM matches');
  const result = { total: rows.length, valid: 0, invalid: 0, invalidActive: 0, active: 0 };
  for (const row of rows) {
    const active = ['playing', 'paused'].includes(row.status);
    if (active) result.active++;
    try {
      const state = decodeMatchState(row.state_json);
      if (state.status !== row.status || state.version !== Number(row.version) || state.eventSeq !== Number(row.event_seq) ||
          state.schemaVersion !== row.state_schema_version || state.rulesetVersion !== row.ruleset_version) throw new Error('metadata');
      result.valid++;
    } catch { result.invalid++; if (active) result.invalidActive++; }
  }
  console.log(JSON.stringify(result));
  if (result.invalidActive) process.exitCode = 1;
} finally { await client.end(); }
