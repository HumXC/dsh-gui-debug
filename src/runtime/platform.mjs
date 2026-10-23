import fs from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { check, fail, cancelled } from './common.mjs';

export const normalizedEnv = env => Object.fromEntries(Object.entries(env ?? {}).map(([key, value]) => [key, value === null ? undefined : value]));
export class DshPlatform {
  constructor(ctx) { this.ctx = ctx; }
  async invocation(exec) {
    const agent = exec.agent;
    check(agent && this.ctx.agents.get(agent.id) === agent, 'INSTANCE_NOT_RUNNING', 'A live calling agent is required.');
    const session = this.ctx.sessions.get(agent.id);
    check(session, 'INSTANCE_NOT_RUNNING', 'Calling session no longer exists.');
    const raw = this.ctx.sandboxPolicy.resolve({ session });
    const workspaceRoot = await fs.realpath(raw.workspaceRoot);
    const mapping = await this.ctx.fs.processPathFromHostPath(workspaceRoot);
    check(mapping === workspaceRoot && path.resolve(raw.workspaceRoot) === workspaceRoot, 'SANDBOX_UNAVAILABLE', 'GUI runtime storage currently requires a shared local workspace with identical host/process paths.');
    const terminal = await this.ctx.subprocess.terminalEnvironment();
    check(terminal.platform === 'posix', 'UNSUPPORTED_OPERATION', 'The current GUI drivers require a Linux/POSIX execution world.');
    return { agent, session, sessionId: agent.id, workspaceRoot, isRoot: this.ctx.agents.roots().includes(agent), signal: exec.signal, callId: exec.callId };
  }
  currentPolicy(invocation, expected) {
    check(invocation.agent && this.ctx.agents.get(invocation.sessionId) === invocation.agent, 'INSTANCE_NOT_RUNNING', 'Calling agent has been disposed.');
    const session = this.ctx.sessions.get(invocation.sessionId);
    check(session && session === invocation.session, 'INSTANCE_NOT_RUNNING', 'Calling session no longer exists.');
    const raw = this.ctx.sandboxPolicy.resolve({ session });
    check(path.resolve(raw.workspaceRoot) === invocation.workspaceRoot, 'POLICY_MISMATCH', 'Workspace policy changed.');
    if (expected) check(raw.mode === expected.mode, 'POLICY_MISMATCH', 'Execution policy changed before spawn.');
    return raw;
  }
  async policy(invocation) {
    const raw = this.currentPolicy(invocation);
    if (raw.mode === 'danger-full-access') return { mode: raw.mode, enforcement: 'unconfined', workspaceRoot: invocation.workspaceRoot, raw };
    try {
      // Determine the configured runner without launching the target command. Every real spawn is confined again.
      const wrapped = await this.ctx.sandbox.confine(['true'], raw, invocation.signal);
      return { mode: raw.mode, enforcement: wrapped.enforcement, runner: path.basename(wrapped.argv[0]), workspaceRoot: invocation.workspaceRoot, raw };
    } catch (error) { fail('SANDBOX_UNAVAILABLE', `Cannot prepare the session sandbox: ${error.message}`); }
  }
  async resolve(executable, cwd, env, signal) {
    cancelled(signal);
    const command = executable.includes('/') && !path.isAbsolute(executable) ? path.resolve(cwd, executable) : executable;
    try { return await this.ctx.subprocess.resolveExecutable(command, normalizedEnv(env), signal); }
    catch { cancelled(signal); return undefined; }
  }
  async version(executable, args, invocation, env) {
    const signal = AbortSignal.any([invocation.signal, AbortSignal.timeout(5000)]), policy = await this.policy({ ...invocation, signal });
    const handle = await this.spawn({ argv: [executable, ...args], cwd: invocation.workspaceRoot, env }, invocation, policy, signal);
    let text = '';
    const drain = async stream => { if (stream) for await (const chunk of stream) if (text.length < 4096) text += Buffer.from(chunk).toString('utf8').slice(0, 4096 - text.length); };
    try { const [outcome] = await Promise.all([handle.done, drain(handle.stdout), drain(handle.stderr)]); cancelled(signal); return { ...outcome, text }; }
    finally { handle.terminate(); await handle.waitForExit(AbortSignal.timeout(5000)).catch(() => false); }
  }
  async spawn(request, invocation, policy, signal) {
    cancelled(signal);
    const current = await this.policy({ ...invocation, signal });
    check(current.mode === policy.mode && current.enforcement === policy.enforcement && current.runner === policy.runner, 'POLICY_MISMATCH', 'Execution policy changed before spawn.');
    const executable = await this.resolve(request.argv[0], request.cwd, request.env, signal);
    check(executable, 'DEPENDENCY_MISSING', `Executable is unavailable: ${request.argv[0]}.`);
    let argv = [executable, ...request.argv.slice(1)], confined;
    if (policy.mode !== 'danger-full-access') {
      try { confined = await this.ctx.sandbox.confine(argv, policy.raw, signal); argv = confined.argv; }
      catch (error) { fail('SANDBOX_UNAVAILABLE', `Cannot confine command: ${error.message}`); }
      check(confined.enforcement === policy.enforcement && path.basename(argv[0]) === policy.runner, 'POLICY_MISMATCH', 'Sandbox runner changed; create a new environment.');
    }
    cancelled(signal);
    // No asynchronous work may separate this current session check from the actual spawn.
    this.currentPolicy(invocation, policy);
    const handle = this.ctx.subprocess.spawn({ argv, cwd: request.cwd, env: normalizedEnv(request.env),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 1000, signal });
    return { stdout: handle.stdout, stderr: handle.stderr, done: handle.done, terminate: () => handle.terminate(), waitForExit: abort => handle.waitForExit(abort),
      denialSignatures: confined?.denialSignatures ?? [], runnerFailureRules: confined?.runnerFailureRules ?? [] };
  }
  desktop() {
    const env = process.env;
    let socketIdentity;
    if (env.WAYLAND_DISPLAY) {
      try {
        const socket = path.isAbsolute(env.WAYLAND_DISPLAY) ? env.WAYLAND_DISPLAY : path.join(env.XDG_RUNTIME_DIR ?? '', env.WAYLAND_DISPLAY);
        const canonical = realpathSync(socket), stat = lstatSync(canonical);
        socketIdentity = stat.isSocket() ? `${canonical}:${stat.dev}:${stat.ino}` : 'unavailable';
      } catch { socketIdentity = 'unavailable'; }
    }
    return { runtimeDirectory: env.XDG_RUNTIME_DIR, waylandDisplay: env.WAYLAND_DISPLAY, x11Display: env.DISPLAY, xauthority: env.XAUTHORITY, socketIdentity };
  }
  async confirm(invocation, request, signal) {
    check(invocation.isRoot && this.ctx.agents.roots().includes(invocation.agent), 'HOST_CONFIRMATION_UNAVAILABLE', 'Only the live root caller can request host access.');
    // Do not bypass a session that disables approval prompts. An unprojected policy is fail-closed.
    check(this.ctx.approval.overrideOf(invocation.session) === 'ask', 'HOST_CONFIRMATION_UNAVAILABLE', 'Host access requires this session to permit user confirmation prompts.');
    const allow = '允许本会话读取', questionId = `gui-debug-${request.instanceId}`;
    try {
      const answer = await this.ctx.userQuestions.ask({ agent: invocation.agent, signal,
        questions: [{ id: questionId, question: '允许此会话读取当前真实桌面吗？', detail: request.detail,
          options: [{ label: allow, description: `仅允许 ${request.scopes.join('、')}；结果会交给当前模型，可随时断开。` }, { label: '拒绝', description: '不连接或读取真实桌面。' }] }],
        wait: { callId: invocation.callId } });
      const selected = answer.answers?.find(item => item.id === questionId)?.selected;
      check(answer.answers?.length === 1 && selected?.length === 1 && selected[0] === allow, 'HOST_CONFIRMATION_REJECTED', 'The user did not approve host access.');
      return { questionId, selected: [allow] };
    } catch (error) {
      if (error.code?.startsWith('HOST_')) throw error;
      fail(signal.aborted ? 'CANCELLED' : 'HOST_CONFIRMATION_UNAVAILABLE', signal.aborted ? 'Host confirmation cancelled.' : `Human confirmation unavailable: ${error.message}`);
    }
  }
  async attach(file, name) {
    const data = await fs.readFile(file);
    return this.ctx.attachments.saveImage({ data, mediaType: 'image/png', name });
  }
}
