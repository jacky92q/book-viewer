/** 책 폴더(같은 레벨의 압축파일들) 접근: File System Access API 래퍼 */

export interface LibraryDirHandle {
  readonly name: string;
  getFileHandle(name: string): Promise<{ getFile(): Promise<File> }>;
  values(): AsyncIterable<{ kind: 'file' | 'directory'; name: string }>;
  queryPermission?(desc: { mode: 'read' }): Promise<PermissionState>;
  requestPermission?(desc: { mode: 'read' }): Promise<PermissionState>;
}

const ARCHIVE_EXT = /\.(zip|cbz)$/i;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function supportsDirPicker(): boolean {
  return typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

export async function pickLibraryDir(): Promise<LibraryDirHandle> {
  const picker = (
    window as unknown as {
      showDirectoryPicker: (opts?: { id?: string; mode?: 'read' }) => Promise<LibraryDirHandle>;
    }
  ).showDirectoryPicker;
  return picker({ id: 'foldbook-library', mode: 'read' });
}

/** 읽기 권한 확인. 사용자 동작(탭/클릭/키) 중이면 필요할 때 권한을 다시 요청한다. */
export async function ensureReadPermission(handle: LibraryDirHandle): Promise<boolean> {
  if (!handle.queryPermission) return true;
  if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true;
  if (!handle.requestPermission) return false;
  return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}

export async function listArchives(handle: LibraryDirHandle): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of handle.values()) {
    if (entry.kind === 'file' && ARCHIVE_EXT.test(entry.name) && !entry.name.startsWith('.')) {
      names.push(entry.name);
    }
  }
  return names.sort((a, b) => collator.compare(a, b));
}

export async function getArchiveFile(handle: LibraryDirHandle, name: string): Promise<File> {
  const fh = await handle.getFileHandle(name);
  return fh.getFile();
}
