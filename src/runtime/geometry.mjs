import fs from 'node:fs/promises';
import { check, digest } from './common.mjs';

export function parseWaylandInfo(text) {
  const protocols = new Set([...text.matchAll(/interface:\s*'([^']+)'/g)].map(match => match[1]));
  const outputs = [];
  for (const block of text.split(/(?=^interface:)/m)) {
    if (!/^interface:\s*'wl_output'/.test(block)) continue;
    const name = block.match(/^\s+name:\s*'?([^'\n]+)'?\s*$/m)?.[1]?.trim();
    const modes = block.split(/\bmode:\s*/).slice(1);
    const current = modes.find(mode => /flags:[^\n]*\bcurrent\b/.test(mode));
    const width = current?.match(/\bwidth:\s*(\d+)\s*px/)?.[1];
    const height = current?.match(/\bheight:\s*(\d+)\s*px/)?.[1];
    const scale = Number(block.match(/\bscale:\s*(\d+)/)?.[1] ?? 1);
    const position = block.match(/\bx:\s*(-?\d+)\s*,\s*y:\s*(-?\d+)/);
    const transform = block.match(/output_transform:\s*([^,\n]+)/)?.[1]?.trim() ?? 'normal';
    if (!name || !width || !height || scale <= 0) continue;
    const rotated = /(^|[^0-9])(90|270)(°|$)/.test(transform);
    outputs.push({ id: name, name, globalId: block.match(/^interface:[^\n]*\bname:\s*(\d+)/)?.[1], x: Number(position?.[1] ?? 0), y: Number(position?.[2] ?? 0), width: Number(rotated ? height : width) / scale, height: Number(rotated ? width : height) / scale, scale,
      physicalWidth: Number(width), physicalHeight: Number(height), transform });
  }
  for (const block of text.split(/\bxdg_output_v1\b/).slice(1)) {
    const globalId = block.match(/\boutput:\s*(\d+)/)?.[1];
    const logical = block.match(/logical_x:\s*(-?\d+),\s*logical_y:\s*(-?\d+)/);
    const size = block.match(/logical_width:\s*(\d+),\s*logical_height:\s*(\d+)/);
    const output = outputs.find(item => item.globalId === globalId);
    if (output && logical && size && Number(size[1]) > 0 && Number(size[2]) > 0) Object.assign(output, { x: Number(logical[1]), y: Number(logical[2]), width: Number(size[1]), height: Number(size[2]) });
  }
  for (const output of outputs) delete output.globalId;
  return { protocols, outputs };
}
export function parseSwayOutputs(raw) {
  return raw.filter(output => output.active && output.current_mode && output.rect).map(output => ({
    id: output.name, name: output.name, x: output.rect.x, y: output.rect.y, width: output.rect.width, height: output.rect.height,
    scale: output.scale ?? 1, physicalWidth: output.current_mode.width, physicalHeight: output.current_mode.height, transform: output.transform ?? 'normal',
  }));
}
export const publicOutputs = outputs => outputs.map(({ id, name, x, y, width, height, scale }) => ({ id, name, x, y, width, height, scale }));
export const revision = outputs => digest(outputs);
export function swayWindows(tree) {
  const result = [];
  const visit = node => {
    if ((node.app_id || node.window_properties || node.pid) && node.id !== undefined) result.push({ id: String(node.id), title: String(node.name ?? '').slice(0, 512), appId: String(node.app_id ?? node.window_properties?.class ?? ''), focused: node.focused === true });
    for (const child of [...(node.nodes ?? []), ...(node.floating_nodes ?? [])]) visit(child);
  };
  visit(tree); return result.slice(0, 256);
}
export function captureRegion(outputs, target = { kind: 'output' }) {
  check(target.kind !== 'window', 'UNSUPPORTED_CAPABILITY', 'This driver does not provide direct window capture.');
  const output = target.outputId === undefined ? outputs[0] : outputs.find(item => item.id === target.outputId);
  check(output, 'INVALID_CONFIG', 'Output not found. Refresh instance status.');
  const region = target.kind === 'region' ? { x: target.x, y: target.y, width: target.width, height: target.height } : { x: 0, y: 0, width: output.width, height: output.height };
  check(region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0 && region.x + region.width <= output.width && region.y + region.height <= output.height, 'INVALID_CONFIG', 'Capture region exceeds the output.');
  return { output, region, x: output.x + region.x, y: output.y + region.y };
}
export async function pngDimensions(file) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    check(stat.isFile() && stat.size >= 24 && stat.size <= 32 * 1024 * 1024, 'CAPTURE_FAILED', 'PNG is missing, empty or larger than 32 MiB.');
    const header = Buffer.alloc(24), { bytesRead } = await handle.read(header, 0, 24, 0);
    check(bytesRead === 24 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && header.subarray(12, 16).toString() === 'IHDR', 'CAPTURE_FAILED', 'Capture helper did not return PNG.');
    const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
    check(width > 0 && height > 0 && width * height <= 64 * 1024 * 1024, 'CAPTURE_FAILED', 'Capture dimensions exceed 64 megapixels.');
    return { width, height, bytes: stat.size };
  } finally { await handle.close(); }
}
export function mapPoint(point, captures, instanceId, layoutRevision) {
  const capture = captures.get(point.captureId);
  check(capture && capture.instanceId === instanceId, 'CAPTURE_NOT_FOUND', 'Capture not found in this instance.');
  check(capture.layoutRevision === layoutRevision && capture.imageToLayout, 'STALE_CAPTURE', 'Capture geometry is stale or unavailable; capture again.');
  check(Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0 && point.x < capture.width && point.y < capture.height, 'INVALID_CONFIG', 'Point is outside the original capture pixels.');
  const { a, b, c, d, e, f } = capture.imageToLayout;
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
}
export function prepareAction(action, record) {
  const require = capability => check(record.snapshot.capabilities[capability]?.available, 'UNSUPPORTED_CAPABILITY', `${capability} is unavailable: ${record.snapshot.capabilities[capability]?.reason ?? ''}`);
  const point = value => mapPoint(value, record.captures, record.id, record.snapshot.layoutRevision);
  switch (action.type) {
    case 'text': require('input.text'); break;
    case 'key': require('input.key'); break;
    case 'move': require(action.mode === 'relative' ? 'pointer.relative' : 'pointer.absolute'); return action.mode === 'relative' ? action : { type: 'move', mode: 'absolute', point: point(action.point) };
    case 'click': require('pointer.click'); if (action.point) { require('pointer.absolute'); return { ...action, point: point(action.point) }; } break;
    case 'scroll': require('pointer.scroll'); break;
    case 'drag': require('pointer.drag'); require('pointer.absolute'); return { ...action, from: point(action.from), to: point(action.to) };
    case 'focus': require('windows.focus'); check(record.snapshot.windows?.some(window => window.id === action.windowId), 'INVALID_CONFIG', 'Window not found in the owned environment.'); break;
    case 'wait': break;
    default: check(false, 'INVALID_CONFIG', 'Unknown input action.');
  }
  return action;
}
