import path from 'node:path';
import { declarations, declaration, validateArgs, validateConfig, resolveConfig, effectiveConfig, resolveHostOptions, validateEnv } from './config.mjs';
import { WorkspaceStore } from './storage.mjs';
import { ProcessScope } from './processes.mjs';
import { createManagedDriver, createHostDriver, unwrap, removeOwnedSockets } from './drivers.mjs';
import { prepareAction } from './geometry.mjs';
import { check, fail, cancelled, errorValue, id, compactId, now, digest, page, redact, secretValues, policyKey, sleep, unavailableCapabilities } from './common.mjs';

const statusOnly = ({ mode, enforcement, workspaceRoot, runner }) => ({ mode, enforcement, workspaceRoot, ...(runner ? { runner } : {}) });
const emptySnapshot = state => ({ state, capabilities: unavailableCapabilities('Environment has not become ready.'), outputs: [], layoutRevision: 'initial' });
export class GuiEngine {
  constructor(platform, { resourceRoot }) { this.platform = platform; this.resourceRoot = resourceRoot; this.instances = new Map(); this.pending = new Map(); this.sessionScopes = new Map(); this.reservations = new Map(); this.closed = false; this.lifetime = new AbortController(); }
  owned(invocation) { return [...this.instances.values()].filter(record => record.owner === invocation.sessionId); }
  get(instanceId, invocation) {
    const record = this.instances.get(instanceId);
    check(record && record.owner === invocation.sessionId && record.invocation.workspaceRoot === invocation.workspaceRoot, 'INSTANCE_NOT_FOUND', 'Instance not found in this calling session.');
    return record;
  }
  async execute(name, args, exec) {
    let invocation;
    try {
      check(!this.closed, 'INSTANCE_NOT_RUNNING', 'Plugin is shutting down.'); validateArgs(name, args);
      invocation = await this.platform.invocation(exec);
      let sessionScope = this.sessionScopes.get(invocation.sessionId);
      if (!sessionScope) { sessionScope = new AbortController(); this.sessionScopes.set(invocation.sessionId, sessionScope); }
      invocation = { ...invocation, sessionScope, signal: AbortSignal.any([...(invocation.signal ? [invocation.signal] : []), this.lifetime.signal, sessionScope.signal]) }; cancelled(invocation.signal);
      const store = new WorkspaceStore(invocation.workspaceRoot), policy = await this.platform.policy(invocation);
      let value;
      switch (name) {
        case 'gui_debug_drivers': value = await this.drivers(args, invocation, policy); break;
        case 'gui_debug_profile': value = await this.profile(args, store, policy); break;
        case 'gui_debug_start': value = await this.start(args, invocation, store, policy); break;
        case 'gui_debug_host': value = args.action === 'connect' ? await this.connectHost(args, invocation, store, policy) : await this.disconnectHost(args, invocation); break;
        case 'gui_debug_exec': value = await this.serial(this.get(args.instanceId, invocation), () => this.exec(args, invocation)); break;
        case 'gui_debug_capture': value = await this.serial(this.get(args.instanceId, invocation), () => this.capture(this.get(args.instanceId, invocation), invocation, args)); break;
        case 'gui_debug_input': value = await this.serial(this.get(args.instanceId, invocation), () => this.input(args, invocation)); break;
        case 'gui_debug_inspect': value = await this.inspect(args, invocation); break;
        case 'gui_debug_stop': value = await this.stop(args, invocation); break;
        default: fail('UNSUPPORTED_OPERATION', 'Unknown GUI tool.');
      }
      return { ok: true, value: redact(value, this.owned(invocation).flatMap(record => secretValues(record.config?.env))) };
    } catch (error) {
      const secrets = invocation ? this.owned(invocation).flatMap(record => secretValues(record.config?.env)) : [];
      return { ok: false, error: redact(errorValue(error), secrets) };
    }
  }
  async serial(record, operation) {
    const previous = record.queue ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation); record.queue = result.catch(() => {}); return result;
  }
  async requirePolicy(record, invocation, scope) {
    cancelled(invocation.signal);
    const current = await this.platform.policy(invocation);
    if (record.policyKey !== policyKey(current)) { await this.closeRecord(record); fail('POLICY_MISMATCH', 'Execution policy changed; reconnect or start a new instance.'); }
    if (record.kind === 'host') {
      check(record.active && record.consent, 'HOST_ACCESS_REVOKED', 'Host access has been revoked.');
      check(!scope || record.consent.scopes.includes(scope), 'HOST_CONFIRMATION_REQUIRED', `Host ${scope} was not granted. Request a new connection with the required scope.`);
      if (record.consent.configDigest !== digest({ options: record.options, executables: record.executables }) || record.consent.displayIdentity !== digest(this.platform.desktop())) {
        await this.closeRecord(record);
        fail('HOST_ACCESS_REVOKED', 'Desktop connection or frozen host configuration changed; request confirmation again.');
      }
    }
    return current;
  }
  context(record, invocation, signal = invocation.signal) {
    const common = { instanceId: record.id, workspaceRoot: invocation.workspaceRoot, paths: record.paths, executables: record.executables, sandbox: statusOnly(record.policy), signal };
    if (record.kind === 'managed') return { ...common, processes: record.processes.operation(signal), lifetimeSignal: record.processes.lifetime.signal, parentDisplay: this.platform.desktop() };
    return { ...common, display: { ...record.desktop, identity: record.consent.displayIdentity }, consent: record.consent,
      helpers: {
        run: async (scope, request) => {
          await this.requirePolicy(record, invocation, scope);
          check(Object.values(record.executables).includes(request.argv[0]), 'UNSUPPORTED_OPERATION', 'Host helpers must match the frozen observed-tool configuration.');
          return record.processes.launch({ ...request, role: 'helper' }, signal);
        },
        terminateHelpers: async () => { const result = await record.processes.terminateAll(); return result.ok && result.value.remainingProcessIds.length === 0 ? { ok: true, value: null } : { ok: false, error: { code: 'STOP_FAILED', message: 'Some observation helpers have not exited.' } }; },
      } };
  }
  summary(record) {
    const identity = { instanceId: record.id, driverId: record.driverId, kind: record.kind, createdAt: record.createdAt };
    if (record.kind === 'host') return { ...identity, state: record.active ? 'connected' : 'disconnected', access: { scopes: [...(record.consent?.scopes ?? record.grantedScopes ?? [])], confirmedAt: record.confirmedAt } };
    const applicationCounts = { starting: 0, running: 0, exited: 0, failed: 0 };
    for (const application of record.applications.values()) applicationCounts[application.state]++;
    return { ...identity, state: record.state, applicationCounts };
  }
  details(record) {
    const snapshot = record.snapshot;
    return { ...this.summary(record), ...snapshot, state: this.summary(record).state,
      ...(record.kind === 'host' && !record.consent?.scopes.includes('inspect') ? { outputs: [], windows: undefined } : {}),
      ...(record.kind === 'managed' ? { effectiveConfig: effectiveConfig(record.config), desktopSettings: record.config.desktopSettings } : { effectiveOptions: record.options }),
      artifactDirectory: record.paths.artifactDirectory, sandbox: statusOnly(record.policy), warnings: record.warnings };
  }
  async persist(record) {
    try {
      const policy = await this.platform.policy(record.invocation);
      if (policy.mode === 'read-only') return;
      await record.store.writeJSON(path.join(record.paths.root, 'instance.json'), redact(this.details(record), secretValues(record.config?.env)), policy);
    } catch { /* Cleanup must not create writes under a revoked policy or disposed agent. */ }
  }
  async lookup(metadata, options, invocation, env = {}) {
    const executables = {}, dependencies = [];
    const required = metadata.kind === 'managed' ? [metadata.id, 'waylandInfo', ...(metadata.id === 'sway' ? ['swaymsg'] : [])] : ['waylandInfo', 'grim'];
    for (const tool of metadata.externalTools) {
      const executable = options.executables?.[tool.id] ?? tool.executable;
      const found = await this.platform.resolve(executable, invocation.workspaceRoot, env, invocation.signal);
      if (found) executables[tool.id] = found;
      /** @type {import('../api.ts').DependencyStatus} */
      const dependency = { id: tool.id, executable, ...(found ? { resolvedPath: found } : {}), status: found ? 'found' : 'missing', requiredFor: required.includes(tool.id) ? ['start'] : tool.requiredFor ?? [] };
      if (found && tool.id === 'cage') {
        try {
          const result = await this.platform.version(found, ['-v'], invocation, env);
          const match = result.text.match(/cage(?:\s+version)?\s+(\d+)\.(\d+)\.(\d+)/i);
          if (match) dependency.version = match.slice(1).join('.');
          if (result.exitCode !== 0 || !match || (Number(match[1]) === 0 && (Number(match[2]) < 3 || (Number(match[2]) === 3 && Number(match[3]) < 1)))) {
            dependency.status = 'incompatible'; dependency.reason = 'Empty start requires a verifiable Cage version >= 0.3.1.';
          }
        } catch (error) { cancelled(invocation.signal); dependency.status = 'incompatible'; dependency.reason = String(error.message).slice(0, 512); }
      }
      dependencies.push(dependency);
    }
    return { executables, dependencies, ready: dependencies.filter(item => required.includes(item.id)).every(item => item.status === 'found') };
  }
  /** @returns {import('../api.ts').ProbeReport} */
  probeReport(metadata, probe) {
    return { driverId: metadata.id, ready: probe.ready, dependencies: probe.dependencies,
      capabilities: unavailableCapabilities('Preflight only; actual display protocols and operation scope are checked when connected.'),
      warnings: ['No environment was started. Dependency presence is not a protocol or rendering guarantee.'] };
  }
  async drivers(args, invocation, policy) {
    if (args.action === 'list') return { drivers: [...declarations.values()].map(({ id, kind, title, description }) => ({ id, kind, title, description })) };
    const metadata = declaration(args.action === 'check' ? args.config.driver.id : args.driverId);
    if (args.action === 'describe') return { driver: { id: metadata.id, kind: metadata.kind, title: metadata.title, description: metadata.description, optionsSchema: metadata.optionsSchema, defaultConfig: metadata.defaultConfig, externalTools: metadata.externalTools.map(tool => ({ ...tool, found: false })), notes: metadata.notes } };
    if (args.action === 'check') validateConfig(args.config);
    const config = metadata.kind === 'managed' ? resolveConfig(invocation.workspaceRoot, args.config) : { options: resolveHostOptions(args.config.driver.options), env: {} };
    const probe = await this.lookup(metadata, config.options, invocation, config.env);
    return this.probeReport(metadata, probe);
  }
  async profile(args, store, policy) {
    if (args.action === 'list') {
      const records = [];
      for (const key of await store.profiles()) { const record = await store.readJSON(store.profilePath(key)); if (record) records.push({ id: record.id, ...(record.description ? { description: record.description } : {}) }); }
      return { profiles: records };
    }
    const file = store.profilePath(args.profileId);
    if (args.action === 'delete') { await store.deleteProfile(args.profileId, policy); return { deletedProfileId: args.profileId }; }
    if (args.action === 'get') { const profile = await store.readJSON(file); check(profile, 'PROFILE_NOT_FOUND', 'Profile not found.'); validateConfig(profile.config); return { profile }; }
    validateConfig(args.config);
    const profile = { id: args.profileId, ...(args.description === undefined ? {} : { description: args.description }), config: structuredClone(args.config) };
    await store.writeJSON(file, profile, policy); return { profile };
  }
  async source(args, store) {
    if (args.source?.kind === 'profile') {
      const profile = await store.readJSON(store.profilePath(args.source.profileId)); check(profile, 'PROFILE_NOT_FOUND', 'Profile not found.'); return profile.config;
    }
    return args.source?.config;
  }
  capacity(invocation) {
    const active = this.owned(invocation).filter(record => record.kind === 'host' ? record.active : ['starting', 'running', 'stopping'].includes(record.state)).length;
    const reserved = [...this.reservations.values()].filter(reservation => reservation.owner === invocation.sessionId).length;
    check(active + reserved < 16, 'INVALID_CONFIG', 'Stop or disconnect an instance before exceeding 16 active environments per session.');
  }
  async withCapacity(invocation, operation) {
    cancelled(invocation.signal); this.capacity(invocation);
    const token = Symbol('instance reservation');
    this.reservations.set(token, { owner: invocation.sessionId, sessionScope: invocation.sessionScope });
    const releaseCapacity = () => this.reservations.delete(token);
    try { return await operation({ ...invocation, releaseCapacity }); }
    finally { releaseCapacity(); }
  }
  start(args, invocation, store, policy) {
    return this.withCapacity(invocation, reserved => this.startReserved(args, reserved, store, policy));
  }
  async startReserved(args, invocation, store, policy) {
    store.writable(policy);
    const config = resolveConfig(invocation.workspaceRoot, await this.source(args, store), args.overrides);
    const metadata = declaration(config.driverId), probe = await this.lookup(metadata, config.options, invocation, config.env);
    check(probe.ready, probe.dependencies.some(item => item.status === 'incompatible') ? 'DEPENDENCY_INCOMPATIBLE' : 'DEPENDENCY_MISSING', 'Required compositor/geometry tools are missing or incompatible. Use driver executable options or start DSH with compatible tools on PATH.', { dependencyIds: probe.dependencies.filter(item => item.status !== 'found' && item.requiredFor.includes('start')).map(item => item.id) });
    cancelled(invocation.signal);
    const instanceId = compactId('g'), paths = await store.instancePaths(instanceId, 'managed', config.desktopSettings, policy);
    cancelled(invocation.signal);
    const record = { id: instanceId, owner: invocation.sessionId, invocation, driverId: metadata.id, kind: 'managed', createdAt: now(), state: 'starting', config, executables: probe.executables,
      policy, policyKey: policyKey(policy), store, paths, applications: new Map(), captures: new Map(), snapshot: emptySnapshot('starting'), warnings: [] };
    record.processes = new ProcessScope(this.platform, invocation, policy, store); record.processes.stopTimeoutMs = config.stopTimeoutMs;
    check(metadata.kind === 'managed', 'UNSUPPORTED_OPERATION', 'Expected a managed driver.');
    record.driver = createManagedDriver(metadata, { resourceRoot: this.resourceRoot, probe: async () => ({ ok: true, value: this.probeReport(metadata, probe) }) });
    this.instances.set(instanceId, record); invocation.releaseCapacity();
    const signal = AbortSignal.any([invocation.signal, AbortSignal.timeout(config.startupTimeoutMs)]);
    try {
      const started = unwrap(await record.driver.start(this.context(record, invocation, signal), config));
      cancelled(signal); record.handle = started.handle; record.snapshot = started.snapshot; record.state = 'running';
      started.handle.process.done.then(async outcome => {
        if (record.state === 'running') { record.state = outcome.ok && outcome.value.exitCode === 0 ? 'exited' : 'failed'; await this.closeRecord(record); }
      }).catch(() => {});
      await this.persist(record); return { instance: this.details(record) };
    } catch (error) {
      record.state = 'failed'; await this.closeRecord(record);
      error.instanceId = instanceId; throw error;
    }
  }
  async exec(args, invocation) {
    const record = this.get(args.instanceId, invocation);
    check(record.kind === 'managed', 'UNSUPPORTED_OPERATION', 'Host connections cannot execute applications.');
    await this.requirePolicy(record, invocation);
    check(record.state === 'running', 'INSTANCE_NOT_RUNNING', 'Environment is not running.');
    check(record.applications.size < 256, 'INVALID_CONFIG', 'Application history limit reached; create a new instance.'); validateEnv(args.env, record.config.desktopSettings);
    const applicationId = id('app'), logPath = path.join(record.paths.root, 'logs', `${applicationId}.log`);
    const command = { executable: args.command.executable, args: [...(args.command.args ?? [])] };
    const application = { applicationId, instanceId: record.id, command, state: 'starting', createdAt: now(), logPath };
    record.applications.set(applicationId, application);
    const signal = AbortSignal.any([invocation.signal, AbortSignal.timeout(args.startupTimeoutMs ?? record.config.startupTimeoutMs)]);
    let process;
    try {
      const started = unwrap(await record.driver.exec(this.context(record, invocation, signal), record.handle, { applicationId, command,
        cwd: path.resolve(invocation.workspaceRoot, args.cwd ?? record.config.cwd), env: args.env ?? {}, startupTimeoutMs: args.startupTimeoutMs ?? record.config.startupTimeoutMs, logPath }));
      process = started.process; cancelled(signal); Object.assign(application, started.application);
      process.done.then(async result => {
        application.state = result.ok ? 'exited' : 'failed';
        if (result.ok) {
          if (typeof result.value.exitCode === 'number') application.exitCode = result.value.exitCode;
          if (typeof result.value.signal === 'string') application.signal = result.value.signal;
        }
        await this.persist(record);
      }).catch(() => {});
      await this.persist(record); return { application: { ...application } };
    } catch (error) { if (process) await process.terminate(); application.state = 'failed'; await this.persist(record); fail(error.code === 'CANCELLED' || error.code === 'TIMEOUT' ? error.code : 'EXEC_FAILED', error.message, { instanceId: record.id, applicationId }); }
  }
  async refresh(record, invocation, scope = 'inspect') {
    await this.requirePolicy(record, invocation, scope);
    check(record.kind === 'host' ? record.active : record.state === 'running', 'INSTANCE_NOT_RUNNING', 'Environment/connection is not running.');
    record.snapshot = unwrap(await record.driver.inspect(this.context(record, invocation), record.handle));
  }
  async capture(record, invocation, args = {}) {
    await this.requirePolicy(record, invocation, 'capture');
    check(record.kind === 'host' ? record.active : record.state === 'running', 'INSTANCE_NOT_RUNNING', 'Environment/connection is not running.');
    /** @type {import('../driver.ts').DriverCapture} */
    const image = unwrap(await record.driver.capture(this.context(record, invocation), record.handle, args.target ?? { kind: 'output' }, args.includeCursor ?? false));
    await this.requirePolicy(record, invocation, 'capture');
    const attachment = await this.platform.attach(image.path, path.basename(image.path));
    await this.requirePolicy(record, invocation, 'capture');
    const width = attachment.width, height = attachment.height, mapping = image.imageToLayout;
    const capture = { captureId: id('capture'), instanceId: record.id, path: image.path, attachmentId: attachment.attachmentId, mimeType: image.mimeType, width, height, capturedAt: now(), layoutRevision: image.layoutRevision,
      ...(mapping ? { imageToLayout: { a: mapping.a * image.width / width, b: mapping.b * image.width / width, c: mapping.c * image.height / height, d: mapping.d * image.height / height, e: mapping.e, f: mapping.f } } : {}), attachment };
    record.snapshot.layoutRevision = image.layoutRevision; record.captures.set(capture.captureId, capture);
    while (record.captures.size > 64) record.captures.delete(record.captures.keys().next().value);
    return { capture };
  }
  async input(args, invocation) {
    const record = this.get(args.instanceId, invocation);
    invocation = { ...invocation, signal: AbortSignal.any([invocation.signal, record.processes.lifetime.signal]) };
    check(record.kind === 'managed', 'UNSUPPORTED_OPERATION', 'Host connections do not accept input.'); await this.refresh(record, invocation);
    const duration = args.actions.reduce((total, action) => total + (action.type === 'wait' ? action.durationMs : action.type === 'key' ? action.holdMs ?? 0 : action.type === 'drag' ? action.durationMs ?? 300 : 0), 0);
    check(duration <= 30000, 'INVALID_CONFIG', 'Explicit action durations exceed 30 seconds.');
    for (const action of args.actions) prepareAction(action, record);
    let completedActions = 0, failedAction;
    for (const action of args.actions) {
      try {
        if (action.type === 'wait') {
          // Waiting does not consume geometry. Keep authorization/cancellation live without
          // launching display helpers; the next input action still refreshes its layout.
          await this.requirePolicy(record, invocation);
          await sleep(action.durationMs, invocation.signal);
        } else {
          await this.refresh(record, invocation);
          const prepared = prepareAction(action, record);
          unwrap(await record.driver.input(this.context(record, invocation), record.handle, prepared));
        }
        completedActions++;
      } catch (error) { failedAction = { index: completedActions, ...errorValue(error) }; break; }
    }
    let capture, captureError;
    if (args.captureAfter === true) {
      try { ({ capture } = await this.capture(record, invocation)); } catch (error) { captureError = errorValue(error); }
    }
    return { instanceId: record.id, completedActions, ...(failedAction ? { failedAction } : {}), ...(capture ? { capture } : {}), ...(captureError ? { captureError } : {}) };
  }
  async inspect(args, invocation) {
    if (args.action === 'list') { const result = page(this.owned(invocation).map(record => this.summary(record)), args.limit, args.cursor); return { instances: result.items, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) }; }
    const record = this.get(args.instanceId, invocation);
    return this.serial(record, async () => {
      if (args.action === 'applications') { check(record.kind === 'managed', 'UNSUPPORTED_OPERATION', 'Host does not manage applications.'); const result = page([...record.applications.values()], args.limit, args.cursor); return { applications: result.items, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) }; }
      if (args.action === 'logs') {
        if (record.kind === 'host') await this.requirePolicy(record, invocation, 'inspect');
        const application = args.source?.kind === 'application' ? record.applications?.get(args.source.applicationId) : undefined;
        if (args.source?.kind === 'application') check(application, 'APPLICATION_NOT_FOUND', 'Application not found in the owned instance.');
        return { instanceId: record.id, ...(application ? { applicationId: application.applicationId } : {}), ...await record.store.readLog(application?.logPath ?? record.paths.driverLog, args.cursor, args.maxBytes) };
      }
      if (record.kind === 'host' || record.state === 'running') await this.refresh(record, invocation);
      return { instance: this.details(record) };
    });
  }
  async stop(args, invocation) {
    const record = this.get(args.instanceId, invocation);
    check(record.kind === 'managed', 'UNSUPPORTED_OPERATION', 'Host cannot be stopped; disconnect its plugin reference instead.');
    // Cancellation is immediate; queued work is allowed to settle before final status is persisted.
    record.processes.lifetime.abort();
    return this.serial(record, async () => { const remainingProcessIds = await this.closeRecord(record); return { instanceId: record.id, state: remainingProcessIds.length ? 'failed' : 'stopped', remainingProcessIds, artifactDirectory: record.paths.artifactDirectory }; });
  }
  connectHost(args, invocation, store, policy) {
    return this.withCapacity(invocation, reserved => this.connectHostReserved(args, reserved, store, policy));
  }
  async connectHostReserved(args, invocation, store, policy) {
    check(invocation.isRoot, 'HOST_CONFIRMATION_UNAVAILABLE', 'Delegated agents cannot request or reuse host consent.');
    store.writable(policy);
    const options = resolveHostOptions(args.options), metadata = declaration('host'), probe = await this.lookup(metadata, options, invocation);
    check(probe.ready, 'DEPENDENCY_MISSING', 'The host observation helpers are missing.', { dependencyIds: probe.dependencies.filter(item => item.status !== 'found').map(item => item.id) });
    const desktop = this.platform.desktop();
    check(desktop.runtimeDirectory && desktop.waylandDisplay, 'PROTOCOL_UNAVAILABLE', 'No compatible existing Wayland connection is available to this DSH process.');
    const instanceId = id('host'), scopes = [...new Set(args.scopes)], frozen = structuredClone({ options, executables: probe.executables }), configDigest = digest(frozen), displayIdentity = digest(desktop);
    const pending = new AbortController(), signal = AbortSignal.any([invocation.signal, pending.signal, AbortSignal.timeout(120000)]);
    this.pending.set(instanceId, { owner: invocation.sessionId, controller: pending });
    try {
      const receipt = await this.platform.confirm(invocation, { instanceId, scopes, detail: `会话：${invocation.sessionId}\n用途：${args.reason}\n桌面：${desktop.waylandDisplay}\n范围：${scopes.join(', ')}\n工具与配置：${JSON.stringify(frozen)}\n截图或信息会作为工具结果交给模型。仅本会话连接有效，可随时断开。` }, signal);
      cancelled(signal); check(!this.closed && this.pending.has(instanceId), 'HOST_ACCESS_REVOKED', 'Pending host connection was revoked.');
      const latest = await this.platform.policy(invocation);
      check(policyKey(latest) === policyKey(policy) && digest(this.platform.desktop()) === displayIdentity, 'POLICY_MISMATCH', 'Desktop or policy changed during confirmation.');
      const paths = await store.instancePaths(instanceId, 'host', 'inherit', policy);
      cancelled(signal);
      const consent = Object.freeze({ sessionId: invocation.sessionId, instanceId, scopes: Object.freeze(scopes), displayIdentity, configDigest, confirmedAt: now() });
      const record = { id: instanceId, owner: invocation.sessionId, invocation, driverId: 'host', kind: 'host', createdAt: now(), active: true, options: frozen.options, executables: Object.freeze(frozen.executables), desktop,
        policy, policyKey: policyKey(policy), store, paths, consent, confirmedAt: consent.confirmedAt, grantedScopes: scopes, captures: new Map(), warnings: [], snapshot: emptySnapshot('connected') };
      check(metadata.kind === 'host', 'UNSUPPORTED_OPERATION', 'Expected a host driver.');
      record.processes = new ProcessScope(this.platform, invocation, policy, store);
      record.driver = createHostDriver(metadata, { probe: async () => ({ ok: true, value: this.probeReport(metadata, probe) }) });
      this.instances.set(instanceId, record);
      invocation.releaseCapacity();
      try {
        await store.writeJSON(path.join(paths.root, 'consent.json'), { request: { instanceId, reason: args.reason, scopes, configDigest, displayIdentity }, ...receipt, confirmedAt: consent.confirmedAt, sessionId: invocation.sessionId }, policy);
        const started = unwrap(await record.driver.connect(this.context(record, invocation, signal), record.options)); cancelled(signal); record.handle = started.handle; record.snapshot = started.snapshot;
        await this.persist(record); return { instance: this.details(record) };
      } catch (error) { await this.closeRecord(record); throw error; }
    } finally { this.pending.delete(instanceId); }
  }
  async disconnectHost(args, invocation) {
    const record = this.get(args.instanceId, invocation); check(record.kind === 'host', 'UNSUPPORTED_OPERATION', 'Use gui_debug_stop for managed instances.');
    await this.closeRecord(record); return { disconnectedInstanceId: record.id };
  }
  async closeRecord(record) {
    if (record.closing) return record.closing;
    record.active = false;
    if (record.kind === 'host') record.consent = undefined;
    else if (!['failed', 'exited', 'stopped'].includes(record.state)) record.state = 'stopping';
    record.processes.lifetime.abort();
    record.closing = (async () => {
      let remainingProcessIds;
      if (record.kind === 'managed' && record.handle) remainingProcessIds = unwrap(await record.driver.stop(this.context(record, record.invocation), record.handle, record.config.stopTimeoutMs)).remainingProcessIds;
      else remainingProcessIds = unwrap(await record.processes.terminateAll()).remainingProcessIds;
      if (record.kind === 'managed') {
        if (!remainingProcessIds.length) await removeOwnedSockets(record.paths.runtimeDirectory);
        if (remainingProcessIds.length) record.state = 'failed';
        else if (!['failed', 'exited'].includes(record.state)) record.state = 'stopped';
      }
      await this.persist(record);
      if (remainingProcessIds.length) record.closing = undefined;
      return remainingProcessIds;
    })().catch(error => { record.closing = undefined; throw error; });
    return record.closing;
  }
  async revokeHosts(sessionId) {
    for (const [key, pending] of this.pending) if (pending.owner === sessionId) { pending.controller.abort(); this.pending.delete(key); }
    const records = [...this.instances.values()].filter(record => record.owner === sessionId && record.kind === 'host');
    await Promise.allSettled(records.map(record => this.closeRecord(record)));
  }
  async closeSession(sessionId) {
    const sessionScope = this.sessionScopes.get(sessionId);
    this.sessionScopes.delete(sessionId); sessionScope?.abort();
    for (const [token, reservation] of this.reservations) if (reservation.owner === sessionId) this.reservations.delete(token);
    for (const [key, pending] of this.pending) if (pending.owner === sessionId) { pending.controller.abort(); this.pending.delete(key); }
    // Snapshot before awaiting cleanup: operations admitted under a new policy have a new scope.
    const records = [...this.instances.values()].filter(record => record.owner === sessionId);
    for (const record of records) { record.active = false; record.processes.lifetime.abort(); }
    await Promise.all(records.map(async record => {
      let remaining;
      try { remaining = await this.closeRecord(record); } catch { /* Keep failed cleanup ranges available for retry. */ }
      if (remaining?.length === 0 && this.instances.get(record.id) === record) this.instances.delete(record.id);
      else {
        // A failed range needs ownership paths and its raw handles, not a disposed Agent/Session graph.
        record.invocation = { sessionId: record.owner, workspaceRoot: record.invocation.workspaceRoot, signal: record.processes.lifetime.signal };
        record.processes.invocation = record.invocation;
        if (remaining && record.handle?.process && !remaining.includes(record.handle.process.processId)) record.handle = undefined;
      }
    }));
  }
  async closeAll() {
    this.closed = true; this.lifetime.abort();
    const owners = new Set([...this.sessionScopes.keys(), ...[...this.instances.values()].map(record => record.owner), ...[...this.pending.values()].map(pending => pending.owner)]);
    await Promise.allSettled([...owners].map(owner => this.closeSession(owner)));
    this.pending.clear(); this.reservations.clear(); this.sessionScopes.clear();
  }
}
