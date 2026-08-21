// Unit tests for the watcher's trigger decision — the loop-breaker logic that
// decides when a project message may wake (and bill) the local AI CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldTrigger } from '../scripts/buildhall-watch.mjs';

const ctx = { names: ['claude', 'drmnana claude'], all: false, selfName: 'drmnana claude', agentBudgetLeft: 3 };
const human = (text) => ({ actor_type: 'human', username: 'someone', text });
const agent = (name, text) => ({ actor_type: 'ai', agent_name: name, text });

test('mentions of the agent name trigger', () => {
  assert.ok(shouldTrigger(human('claude, are you here?'), ctx));
  assert.ok(shouldTrigger(human('hey Claude what do you think'), ctx));
  assert.ok(shouldTrigger(human('drmnana claude: review this'), ctx));
});

test('unrelated human chatter does not trigger in mention mode', () => {
  assert.ok(!shouldTrigger(human('let us ship the feature tomorrow'), ctx));
  assert.ok(!shouldTrigger(human('claudette is a nice name'), ctx), 'partial word must not match');
});

test('agents trigger agents while the chain budget lasts', () => {
  assert.ok(shouldTrigger(agent('x codex', 'claude please respond'), ctx), 'agent mention triggers with budget');
  assert.ok(!shouldTrigger(agent('x codex', 'claude please respond'), { ...ctx, agentBudgetLeft: 0 }), 'budget exhausted — wait for a human');
  assert.ok(!shouldTrigger(agent('x codex', 'no mention here'), ctx), 'agent without mention does not trigger in mention mode');
  assert.ok(shouldTrigger(agent('x codex', 'anything'), { ...ctx, all: true }), '--all + budget lets agents converse');
});

test('the agent never answers its own messages', () => {
  assert.ok(!shouldTrigger(agent('drmnana claude', 'claude should I reply to myself?'), ctx));
  assert.ok(!shouldTrigger(agent('Drmnana Claude', 'anything'), { ...ctx, all: true }), 'case-insensitive self match');
});

test('--all triggers on any human message', () => {
  assert.ok(shouldTrigger(human('no mention here'), { ...ctx, all: true }));
});

test('regex-special agent names are treated literally', () => {
  assert.ok(shouldTrigger(human('gpt-4.1 take a look'), { names: ['gpt-4.1'], all: false }));
  assert.ok(!shouldTrigger(human('gpt-401 take a look'), { names: ['gpt-4.1'], all: false }));
});
