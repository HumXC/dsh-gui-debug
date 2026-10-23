import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { check, fail } from './common.mjs';

export class WorkspaceStore {
  constructor(workspaceRoot) { this.workspaceRoot = path.resolve(workspaceRoot); this.base = path.join(this.workspaceRoot, '.dsh', 'gui-debug'); }
  async verify(target, { create = false, directory = false } = {}) {
    target = path.resolve(target);
    check(target === this.base || target.startsWith(`${this.base}${path.sep}`), 'INVALID_CONFIG', 'Runtime path escapes the plugin directory.');
    const relative = path.relative(this.workspaceRoot, directory ? target : path.dirname(target));
    let current = await fs.realpath(this.workspaceRoot);
    check(current === this.workspaceRoot, 'INVALID_CONFIG', 'Workspace must be resolved to its real path before creating runtime files.');
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (create) { try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
      let stat;
      try { stat = await fs.lstat(current); } catch (error) { if (!create && error.code === 'ENOENT') return false; throw error; }
      check(stat.isDirectory() && !stat.isSymbolicLink(), 'INVALID_CONFIG', 'Runtime directories cannot be symlinks.');
      if (process.getuid) check(stat.uid === process.getuid(), 'INVALID_CONFIG', 'Runtime directory must be owned by the current user.');
    }
    return true;
  }
  writable(policy) { check(policy.mode !== 'read-only', 'SANDBOX_DENIED', 'This operation needs writable workspace runtime storage.'); }
  async writeJSON(file, value, policy) {
    this.writable(policy); await this.verify(file, { create: true });
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    let created = false;
    try {
      const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      created = true;
      try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
      await this.verify(file); await fs.rename(temporary, file); created = false;
    } finally { if (created) await fs.unlink(temporary).catch(() => {}); }
  }
  async readJSON(file) {
    if (!await this.verify(file)) return undefined;
    let handle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      check(stat.isFile() && stat.size <= 1024 * 1024, 'INVALID_CONFIG', 'Invalid or oversized stored configuration.');
      return JSON.parse(await handle.readFile('utf8'));
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    finally { await handle?.close(); }
  }
  profilePath(profileId) {
    check(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(profileId), 'INVALID_CONFIG', 'Invalid profile id.');
    return path.join(this.base, 'profiles', `${profileId}.json`);
  }
  async profiles() {
    const directory = path.join(this.base, 'profiles');
    if (!await this.verify(directory, { directory: true })) return [];
    return (await fs.readdir(directory)).filter(name => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\.json$/.test(name)).map(name => name.slice(0, -5)).sort();
  }
  async deleteProfile(profileId, policy) {
    this.writable(policy); const file = this.profilePath(profileId);
    if (!await this.verify(file)) return;
    try { const stat = await fs.lstat(file); check(stat.isFile() && !stat.isSymbolicLink(), 'INVALID_CONFIG', 'Invalid profile file.'); await fs.unlink(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async instancePaths(instanceId, kind, settings, policy) {
    this.writable(policy);
    check((kind === 'managed' ? /^g[A-Za-z0-9_-]{8}$/ : /^host-[a-f0-9]{12}$/).test(instanceId), 'INVALID_CONFIG', 'Invalid instance id.');
    const root = path.join(this.base, 'instances', instanceId);
    const result = { root, artifactDirectory: path.join(root, 'artifacts'), cacheDirectory: path.join(root, 'cache'), driverLog: path.join(root, 'logs', 'driver.log') };
    if (kind === 'managed') Object.assign(result, { runtimeDirectory: path.join(root, 'runtime'), wmConfigDirectory: path.join(root, 'wm'), privateSettingsDirectory: path.join(root, 'settings') });
    for (const directory of [result.artifactDirectory, result.cacheDirectory, path.dirname(result.driverLog), ...(kind === 'managed' ? [result.runtimeDirectory, result.wmConfigDirectory, ...(settings === 'private' ? ['config', 'data', 'state'].map(name => path.join(result.privateSettingsDirectory, name)) : [])] : [])]) {
      await this.verify(directory, { create: true, directory: true }); await fs.chmod(directory, 0o700);
    }
    return result;
  }
  async readLog(file, cursor, maxBytes = 16384) {
    check(cursor === undefined || /^(0|[1-9]\d{0,14})$/.test(cursor), 'INVALID_CONFIG', 'Invalid log cursor.');
    if (!await this.verify(file)) return { text: '', nextCursor: '0', truncated: false };
    let handle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat(), offset = cursor === undefined ? Math.max(0, stat.size - maxBytes) : Number(cursor);
      check(stat.isFile() && offset <= stat.size, 'INVALID_CONFIG', 'Invalid log cursor or file.');
      const buffer = Buffer.alloc(Math.min(maxBytes, stat.size - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      return { text: buffer.subarray(0, bytesRead).toString('utf8'), nextCursor: String(offset + bytesRead), truncated: (cursor === undefined && offset > 0) || offset + bytesRead < stat.size };
    } catch (error) { if (error.code === 'ENOENT') return { text: '', nextCursor: '0', truncated: false }; throw error; }
    finally { await handle?.close(); }
  }
}
