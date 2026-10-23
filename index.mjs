import { fileURLToPath } from 'node:url';
import { GuiEngine } from './dist/src/runtime/engine.mjs';
import { DshPlatform } from './dist/src/runtime/platform.mjs';
import { toolDeclarations } from './dist/src/tools.js';

export const inject = ['tools', 'commands', 'agents', 'sessions', 'sandboxPolicy', 'subprocess', 'sandbox', 'fs', 'attachments', 'userQuestions', 'approval'];
const outputSchema = {
  type: 'object', additionalProperties: false,
  properties: { ok: { type: 'boolean' }, value: { type: 'object', additionalProperties: true }, error: { type: 'object', additionalProperties: true } },
  required: ['ok'],
};
export function renderResult(args, result) {
  const attachment = result.ok ? result.value.capture?.attachment : undefined;
  const textResult = structuredClone(result);
  if (textResult.ok && textResult.value.capture) delete textResult.value.capture.attachment;
  return [{ type: 'text', text: JSON.stringify(textResult) }, ...(attachment ? [{ type: 'image', attachment }] : [])];
}
export function apply(ctx) {
  const engine = new GuiEngine(new DshPlatform(ctx), { resourceRoot: fileURLToPath(new URL('.', import.meta.url)) });
  const cleanup = new Set();
  const track = promise => {
    const task = Promise.resolve(promise).catch(error => console.warn('[gui-debug] Cleanup failed:', String(error.message).slice(0, 512)));
    cleanup.add(task); task.then(() => cleanup.delete(task));
  };
  for (const tool of toolDeclarations) ctx.tools.register({
    name: tool.name, description: tool.description, parameters: tool.parameters,
    output: { schema: outputSchema, render: renderResult },
    execute: (args, exec) => engine.execute(tool.name, args, exec),
  });
  ctx.commands.register({
    name: 'gui-debug-disconnect-host', description: '撤销本会话所有 host 桌面读取授权，取消观测任务并保留截图和日志。',
    handler: async ({ agent }) => {
      if (ctx.agents.get(agent.id) !== agent) return { kind: 'error', text: '调用会话已经结束。' };
      await engine.revokeHosts(agent.id);
      return { kind: 'success', text: '本会话的 host 读取授权已撤销，截图和日志已保留。' };
    },
  });
  ctx.on('agent/disposed', ({ agent }) => { track(engine.closeSession(agent.id)); });
  ctx.on('session/event', (session, event) => {
    if (event.type === 'sandbox/mode') track(engine.closeSession(session.id));
    if (event.type === 'approval/policy' && event.data.policy === 'never') track(engine.revokeHosts(session.id));
  });
  ctx.effect(() => async () => { await engine.closeAll(); await Promise.allSettled([...cleanup]); });
}
