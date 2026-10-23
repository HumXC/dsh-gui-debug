import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, renderResult } from '../index.mjs';

function mount(t) {
  const agent = { id: 'entry-root' }, tools = [], commands = [], listeners = new Map(), disposers = [];
  const ctx = {
    tools: { register: definition => tools.push(definition) },
    commands: { register: definition => commands.push(definition) },
    agents: { get: id => id === agent.id ? agent : undefined },
    on: (name, handler) => listeners.set(name, handler),
    effect: setup => disposers.push(setup()),
  };
  apply(ctx);
  t.after(async () => { for (const dispose of disposers.toReversed()) await dispose(); });
  return { agent, tools, commands, listeners };
}

test('entry registers one shared tool set and only a revoke human command', t => {
  const { tools, commands, listeners } = mount(t);
  assert.equal(tools.length, 9);
  assert.equal(new Set(tools.map(tool => tool.name)).size, 9);
  assert.ok(tools.every(tool => typeof tool.execute === 'function' && typeof tool.output.render === 'function'));
  assert.ok(tools.every(tool => tool.output.schema.type === 'object'));
  assert.deepEqual(commands.map(command => command.name), ['gui-debug-disconnect-host']);
  assert.deepEqual([...listeners.keys()].sort(), ['agent/disposed', 'session/event']);
});

test('human revoke command admits only the exact live agent object', async t => {
  const { agent, commands } = mount(t), command = commands[0];
  assert.equal((await command.handler({ agent: { id: agent.id } })).kind, 'error');
  assert.equal((await command.handler({ agent })).kind, 'success');
});

test('renderer emits the image once and keeps textual capture metadata', () => {
  const attachment = { attachmentId: 'image-example', mediaType: 'image/png', width: 320, height: 200, bytes: 128 };
  const result = { ok: true, value: { capture: { captureId: 'capture-example', width: 320, height: 200, attachment } } };
  const before = structuredClone(result), rendered = renderResult({}, result);
  assert.equal(rendered.length, 2);
  assert.equal(rendered[1].type, 'image'); assert.deepEqual(rendered[1].attachment, attachment);
  assert.equal(JSON.parse(rendered[0].text).value.capture.captureId, 'capture-example');
  assert.equal(JSON.parse(rendered[0].text).value.capture.attachment, undefined);
  assert.deepEqual(result, before);
});

test('renderer preserves structured failures without an image block', () => {
  const failure = { ok: false, error: { code: 'SANDBOX_DENIED', message: 'Write denied.' } };
  assert.deepEqual(renderResult({}, failure), [{ type: 'text', text: JSON.stringify(failure) }]);
});
