import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const script = `function run() {
  ObjC.import('AppKit');
  ObjC.import('stdlib');
  var environment = $.NSProcessInfo.processInfo.environment;
  var start = ObjC.unwrap(environment.objectForKey('ACC_DIRECTORY_PICKER_INITIAL'));
  var output = ObjC.unwrap(environment.objectForKey('ACC_DIRECTORY_PICKER_RESULT'));
  if (!start || !output) $.exit(1);
  var result;
  try {
    var application = $.NSApplication.sharedApplication;
    application.setActivationPolicy($.NSApplicationActivationPolicyRegular);
    application.activateIgnoringOtherApps(true);
    var panel = $.NSOpenPanel.openPanel;
    panel.canChooseFiles = false;
    panel.canChooseDirectories = true;
    panel.allowsMultipleSelection = false;
    panel.prompt = 'Выбрать';
    panel.message = 'Выберите рабочую папку для агента';
    panel.directoryURL = $.NSURL.fileURLWithPath(start);
    var response = panel.runModal;
    var directory = response === $.NSModalResponseOK ? ObjC.unwrap(panel.URL.path) : null;
    if (directory !== null && directory !== '/') directory += '/';
    result = { directory: directory };
  } catch (error) {
    result = { error: String(error) };
  }
  var written = $(JSON.stringify(result)).writeToFileAtomicallyEncodingError(output, true, $.NSUTF8StringEncoding, null);
  $.exit(written ? 0 : 1);
}`;

async function nativeDirectoryPicker(initialDirectory?: string, signal?: AbortSignal): Promise<string | null> {
  let start = homedir();
  if (initialDirectory && isAbsolute(initialDirectory)) {
    try { if ((await stat(initialDirectory)).isDirectory()) start = initialDirectory; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
  signal?.throwIfAborted();
  const temporary = await mkdtemp(join(tmpdir(), 'acc-directory-picker-'));
  try {
    const app = join(temporary, 'Agent Control Center Folder.app');
    const output = join(temporary, 'result.json');
    // Собственный applet выводит окно вперёд; завершение дочернего процесса закрывает его при отмене запроса.
    await execute('/usr/bin/osacompile', ['-l', 'JavaScript', '-o', app, '-e', script], { signal });
    await execute('/usr/libexec/PlistBuddy', ['-c', 'Add :CFBundleIdentifier string local.agent-control-center.directory-picker', join(app, 'Contents/Info.plist')], { signal });
    await execute(join(app, 'Contents/MacOS/applet'), [], {
      signal,
      env: { ...process.env, ACC_DIRECTORY_PICKER_INITIAL: start, ACC_DIRECTORY_PICKER_RESULT: output },
    });
    signal?.throwIfAborted();
    const result: unknown = JSON.parse(await readFile(output, 'utf8'));
    if (!result || typeof result !== 'object') throw new Error('Не удалось прочитать результат выбора папки');
    if ('error' in result) throw new Error(`Не удалось открыть диалог: ${String(result.error)}`);
    if ('directory' in result) {
      if (result.directory === null) return null;
      if (typeof result.directory === 'string' && isAbsolute(result.directory)) return result.directory;
    }
    throw new Error('Диалог не вернул абсолютный путь к папке');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

type Picker = (initialDirectory?: string, signal?: AbortSignal) => Promise<string | null>;

export class DirectoryPicker {
  private busy = false;

  constructor(
    private readonly localHostIds: readonly string[],
    private readonly pick: Picker = nativeDirectoryPicker,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  availableFor(hostId: string): boolean {
    return this.platform === 'darwin' && this.localHostIds.includes(hostId);
  }

  async choose(hostId: string, initialDirectory?: string, signal?: AbortSignal): Promise<string | null> {
    if (!this.availableFor(hostId)) throw new Error('Для этого хоста укажите рабочую папку вручную');
    if (initialDirectory !== undefined && typeof initialDirectory !== 'string') throw new Error('Путь к папке должен быть строкой');
    signal?.throwIfAborted();
    if (this.busy) throw new Error('Диалог выбора папки уже открыт');
    this.busy = true;
    try { return await this.pick(initialDirectory, signal); }
    finally { this.busy = false; }
  }
}
