/**
 * agent-lib.js — resolves and requires the EXISTING, working tally-agent/
 * modules (agent.js, config.js, cloud.js, tallyClient.js) rather than
 * reimplementing any of that logic here.
 *
 * Dev mode: tally-agent-gui/ and tally-agent/ are sibling directories, so we
 * require('../tally-agent/agent.js') directly off disk — no copy, no build
 * step, always the current source.
 *
 * Packaged mode: electron-builder's `extraResources` config (see
 * package.json) copies tally-agent/{agent,config,cloud,tallyClient}.js into
 * resources/tally-agent/ alongside the packaged app. We require from there
 * instead. Nothing is duplicated in this repo — the packaged copy is a
 * build-time artifact, not a checked-in file.
 *
 * This file computes NOTHING about Tally itself — it only locates and
 * requires the modules that do.
 */

const path = require('path');
const fs = require('fs');

function resolveTallyAgentDir() {
  const devPath = path.join(__dirname, '..', 'tally-agent');
  if (fs.existsSync(path.join(devPath, 'agent.js'))) {
    return devPath;
  }
  // Packaged: process.resourcesPath/tally-agent
  const packagedPath = path.join(process.resourcesPath, 'tally-agent');
  if (fs.existsSync(path.join(packagedPath, 'agent.js'))) {
    return packagedPath;
  }
  throw new Error(
    `Could not locate tally-agent/agent.js — checked ${devPath} and ${packagedPath}. ` +
    `Is tally-agent-gui/ still a sibling of tally-agent/?`
  );
}

const TALLY_AGENT_DIR = resolveTallyAgentDir();

const agent = require(path.join(TALLY_AGENT_DIR, 'agent.js'));   // performPair, fetchLedgers, runLedgerSync
const config = require(path.join(TALLY_AGENT_DIR, 'config.js')); // load, save, CONFIG_PATH
const cloud = require(path.join(TALLY_AGENT_DIR, 'cloud.js'));   // pairComplete, ingest (used indirectly via agent.performPair)
const tally = require(path.join(TALLY_AGENT_DIR, 'tallyClient.js')); // postXml, buildInfoRequest, parseInfo (for status checks)

module.exports = { TALLY_AGENT_DIR, agent, config, cloud, tally };
