import {
  ContentEncoding,
  ResponsePartKind,
  ToolCallStatus,
  ToolResultContentType,
  type ChangesetFile,
  type FileEdit,
  type FileEditDiffStats,
  type ResourceReadResult,
  type ResponsePart,
} from '@microsoft/agent-host-protocol';
import { structuredPatch } from 'diff';
import { isChangesetChannel } from '../shared/reduce';

type FileEdits = Map<string, [FileEdit, ...FileEdit[]]>;

const FILE_EDIT_TOOLS = new Set(['write', 'edit', 'multiedit', 'write_file', 'edit_file', 'file_edit', 'apply_patch']);

function addFileEdit(files: FileEdits, edit: FileEdit): void {
  const uri = edit.after?.uri ?? edit.before?.uri;
  if (!uri) return;
  const edits = files.get(uri);
  if (edits) edits.push(edit);
  else files.set(uri, [edit]);
}

export function collectFileEdits(parts: readonly ResponsePart[]) {
  const files: FileEdits = new Map();
  let hasFileEditCall = false;

  for (const part of parts) {
    if (part.kind !== ResponsePartKind.ToolCall) continue;
    const { toolCall } = part;
    if (toolCall.status !== ToolCallStatus.Completed || !toolCall.success) continue;

    hasFileEditCall ||= FILE_EDIT_TOOLS.has(toolCall.toolName.toLowerCase());
    for (const item of toolCall.content ?? []) {
      if (item.type === ToolResultContentType.FileEdit) addFileEdit(files, item);
    }
  }

  return { files, hasFileEditCall };
}

export function filesFromChangeset(entries: readonly ChangesetFile[]): FileEdits {
  const files: FileEdits = new Map();
  for (const { edit } of entries) addFileEdit(files, edit);
  return files;
}

export function resolveTurnChangeset(template: string | undefined, turnId: string): string | undefined {
  if (!template?.includes('{turnId}')) return undefined;
  const encodedId = encodeURIComponent(turnId).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  const uri = template.replaceAll('{turnId}', encodedId);
  return !/[{}]/.test(uri) && isChangesetChannel(uri) ? uri : undefined;
}

export function sumDiffStats(edits: Iterable<FileEdit>): FileEditDiffStats {
  let added: number | undefined = 0;
  let removed: number | undefined = 0;
  for (const { diff } of edits) {
    added = added !== undefined && diff?.added !== undefined ? added + diff.added : undefined;
    removed = removed !== undefined && diff?.removed !== undefined ? removed + diff.removed : undefined;
  }
  return { added, removed };
}

export const MAX_DIFF_FILE_BYTES = 256 * 1024;

export function decodeFileText(result: ResourceReadResult): string {
  if (result.data.length > 4 * Math.ceil(MAX_DIFF_FILE_BYTES / 3)) {
    throw new Error('Файл слишком велик для предпросмотра.');
  }

  const bytes = result.encoding === ContentEncoding.Base64
    ? Uint8Array.from(atob(result.data), character => character.charCodeAt(0))
    : new TextEncoder().encode(result.data);
  if (bytes.length > MAX_DIFF_FILE_BYTES) throw new Error('Файл слишком велик для предпросмотра.');

  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!text.includes('\0')) return text;
  } catch {
    // Двоичные данные и текст в другой кодировке нельзя сравнить как UTF-8.
  }
  throw new Error('Предпросмотр доступен для текстовых файлов в UTF-8.');
}

export function fileDiffHunks(before: string, after: string) {
  const patch = structuredPatch('', '', before, after, '', '', { context: 3, timeout: 150, maxEditLength: 2500 });
  if (!patch || patch.hunks.reduce((lines, hunk) => lines + hunk.lines.length, 0) > 6000) {
    throw new Error('Дифф слишком велик для предпросмотра.');
  }
  return patch.hunks;
}
