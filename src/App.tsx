import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  FolderOpen,
  Images,
  Volume2,
  VolumeX,
  Download,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  BookOpen,
  Columns,
  FileArchive,
  Library,
  X
} from 'lucide-react';
import { unzip } from 'fflate';
import PageCurl from './PageCurlComponent';
import { kvDel, kvGet, kvSet } from './storage';
import {
  ensureReadPermission,
  getArchiveFile,
  listArchives,
  pickLibraryDir,
  supportsDirPicker,
  type LibraryDirHandle
} from './library';
import { clampCurlPoint, curlProgress, type Pt } from './pageCurl';

interface RawImageFile {
  name: string;
  url: string;
}

type SliceType = 'left-half' | 'right-half' | 'full';

interface HalfDescriptor {
  url: string;
  slice: SliceType;
  label: string;
}

interface SpreadPage {
  title: string;
  left: HalfDescriptor;
  right: HalfDescriptor;
  thumbUrl: string;
}

type ReadingDirection = 'rtl' | 'ltr';
type ViewMode = 'spread' | 'split' | 'pair';
type PageTurnSide = 'left' | 'right';

type BookSource = 'single' | 'library' | 'queue';

interface SavedBook {
  name: string;
  blob: Blob;
  source: BookSource;
}

interface SavedProgress {
  name: string;
  index: number;
  viewMode: ViewMode;
  readingDirection: ReadingDirection;
  pageTurnSide: PageTurnSide;
}

interface LoadOpts {
  source?: BookSource;
}

interface CurlState {
  side: 'left' | 'right';
  nextIdx: number;
  w: number;
  h: number;
  g: Pt;
  m: Pt;
}

interface DragInfo {
  pointerId: number;
  side: 'left' | 'right';
  nextIdx: number;
  w: number;
  h: number;
  scale: number;
  g: Pt;
  startX: number;
  startY: number;
  lastX: number;
  lastT: number;
  vx: number;
  moved: boolean;
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const ARCHIVE_EXT = /\.(zip|cbz)$/i;
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif'
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export default function App() {
  const [rawFiles, setRawFiles] = useState<RawImageFile[]>([]);
  const [bookTitle, setBookTitle] = useState<string>('폴더나 사진 파일들을 불러오세요');
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [readingDirection, setReadingDirection] = useState<ReadingDirection>('rtl');
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    window.innerHeight > window.innerWidth ? 'split' : 'spread'
  );
  const [pageTurnSide, setPageTurnSide] = useState<PageTurnSide>('right');
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [creaseEnabled, setCreaseEnabled] = useState<boolean>(false);
  const [zoom, setZoom] = useState<number>(1);
  const [immersive, setImmersive] = useState<boolean>(false);
  const [hudVisible, setHudVisible] = useState<boolean>(true);
  const [viewport, setViewport] = useState<{ w: number; h: number }>({
    w: window.innerWidth,
    h: window.innerHeight
  });
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const hudTimerRef = useRef<number | null>(null);
  const [libraryNames, setLibraryNames] = useState<string[]>([]);
  const [libraryOpen, setLibraryOpen] = useState<boolean>(false);
  const [currentBookName, setCurrentBookName] = useState<string>('');
  const currentBookRef = useRef<{ name: string; source: BookSource } | null>(null);
  const libraryRef = useRef<{ handle: LibraryDirHandle | null; names: string[] | null }>({
    handle: null,
    names: null
  });
  const queueRef = useRef<File[]>([]);
  const goNextBookRef = useRef<() => void>(() => {});
  const endIntentRef = useRef<number | null>(null);
  const restoredRef = useRef<boolean>(false);
  const noticeTimerRef = useRef<number | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [notice, setNotice] = useState<string>('');
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  // Page curl state (포인터를 따라 접히는 페이지)
  const [curl, setCurl] = useState<CurlState | null>(null);
  const dragRef = useRef<DragInfo | null>(null);
  const animatingRef = useRef<boolean>(false);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const archiveInputRef = useRef<HTMLInputElement>(null);
  const chassisRef = useRef<HTMLDivElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Listen for Chrome PWA install prompt
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  // 화면 크기 추적 (전체화면 전환·회전 포함)
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 첫 이미지의 실제 비율을 읽어서 화면에 맞춘다
  const firstUrl = rawFiles[0]?.url;
  useEffect(() => {
    if (!firstUrl) {
      setImgSize(null);
      return;
    }
    const img = new Image();
    img.onload = () => setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = firstUrl;
  }, [firstUrl]);

  const showHud = useCallback(() => {
    setHudVisible(true);
    if (hudTimerRef.current) window.clearTimeout(hudTimerRef.current);
    hudTimerRef.current = window.setTimeout(() => setHudVisible(false), 2500);
  }, []);

  const toggleImmersive = useCallback(async () => {
    if (!immersive) {
      setImmersive(true);
      showHud();
      try {
        await document.documentElement.requestFullscreen?.();
      } catch {
        // 전체화면 API를 못 쓰는 브라우저(iOS 등)에서는 UI만 숨긴 몰입 모드로 동작
      }
    } else {
      setImmersive(false);
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
      } catch {
        // ignore
      }
    }
  }, [immersive, showHud]);

  // Esc 등으로 브라우저 전체화면이 풀리면 몰입 모드도 같이 종료
  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) setImmersive(false);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // 몰입 모드에서 마우스를 움직이거나 위쪽을 터치하면 잠깐 메뉴를 보여준다
  useEffect(() => {
    if (!immersive) return;
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' || e.clientY < 90) showHud();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerdown', onMove);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onMove);
    };
  }, [immersive, showHud]);

  // 앱을 켜면 마지막으로 보던 책을 자동으로 복원
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    void (async () => {
      const [book, dir] = await Promise.all([
        kvGet<SavedBook>('lastBook'),
        kvGet<LibraryDirHandle>('dirHandle')
      ]);
      if (dir) libraryRef.current = { handle: dir, names: null };
      if (!book) return;
      const file =
        book.blob instanceof File ? book.blob : new File([book.blob], book.name, { type: book.blob.type });
      await loadArchive(file, { source: book.source });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 보던 페이지 위치 저장
  useEffect(() => {
    const cur = currentBookRef.current;
    if (!cur || rawFiles.length === 0) return;
    const t = window.setTimeout(() => {
      void kvSet('progress', {
        name: cur.name,
        index: currentIndex,
        viewMode,
        readingDirection,
        pageTurnSide
      } satisfies SavedProgress);
    }, 250);
    return () => window.clearTimeout(t);
  }, [currentIndex, viewMode, readingDirection, pageTurnSide, rawFiles.length, currentBookName]);

  // Build spreads based on viewMode and readingDirection
  const pages = useMemo<SpreadPage[]>(() => {
    if (rawFiles.length === 0) return [];
    const list: SpreadPage[] = [];

    if (viewMode === 'spread') {
      rawFiles.forEach((f, idx) => {
        list.push({
          title: f.name,
          left: { url: f.url, slice: 'left-half', label: `${idx + 1}L` },
          right: { url: f.url, slice: 'right-half', label: `${idx + 1}R` },
          thumbUrl: f.url
        });
      });
    } else if (viewMode === 'split') {
      rawFiles.forEach((f, idx) => {
        const firstSlice: SliceType = readingDirection === 'rtl' ? 'right-half' : 'left-half';
        const secondSlice: SliceType = readingDirection === 'rtl' ? 'left-half' : 'right-half';
        const firstPage = {
          title: `${f.name} (${readingDirection === 'rtl' ? '오른쪽' : '왼쪽'} 페이지)`,
          left: { url: f.url, slice: firstSlice, label: `${idx + 1}-L` },
          right: { url: f.url, slice: firstSlice, label: `${idx + 1}-L` },
          thumbUrl: f.url
        };
        const secondPage = {
          title: `${f.name} (${readingDirection === 'rtl' ? '왼쪽' : '오른쪽'} 페이지)`,
          left: { url: f.url, slice: secondSlice, label: `${idx + 1}-R` },
          right: { url: f.url, slice: secondSlice, label: `${idx + 1}-R` },
          thumbUrl: f.url
        };
        list.push(firstPage, secondPage);
      });
    } else {
      for (let i = 0; i < rawFiles.length; i += 2) {
        const first = rawFiles[i];
        const second = rawFiles[i + 1] || first;
        const leftFile = readingDirection === 'rtl' ? second : first;
        const rightFile = readingDirection === 'rtl' ? first : second;
        list.push({
          title: rawFiles[i + 1] ? `${first.name} + ${second.name}` : first.name,
          left: { url: leftFile.url, slice: 'full', label: leftFile.name },
          right: { url: rightFile.url, slice: 'full', label: rightFile.name },
          thumbUrl: first.url
        });
      }
    }
    return list;
  }, [rawFiles, viewMode, readingDirection]);

  const playPageSound = useCallback(() => {
    if (!soundEnabled) return;
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContext();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume();
      const duration = 0.15;
      const buf = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        const t = i / data.length;
        data[i] = (Math.random() * 2 - 1) * Math.sin(t * Math.PI) * Math.pow(1 - t, 1.4) * 0.22;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
    } catch {
      // Ignore audio restrictions
    }
  }, [soundEnabled]);

  const flashNotice = (msg: string, ms = 3500) => {
    setNotice(msg);
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(''), ms);
  };

  const applyBook = (title: string, items: { name: string; url: string }[], index = 0) => {
    rawFiles.forEach((f) => URL.revokeObjectURL(f.url));
    setBookTitle(title);
    setRawFiles(items);
    setCurrentIndex(index);
    setCurl(null);
  };

  /** zip / cbz 압축파일 한 권을 풀어서 이미지들을 이름 순으로 불러온다. 저장된 진행 위치가 있으면 이어서 보여준다. */
  const loadArchive = async (archive: File, opts: LoadOpts = {}) => {
    const source = opts.source ?? 'single';
    setLoading(true);
    setNotice(`"${archive.name}" 압축을 푸는 중…`);
    try {
      const data = new Uint8Array(await archive.arrayBuffer());
      const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
        unzip(
          data,
          {
            filter: (file) =>
              IMAGE_EXT.test(file.name) &&
              !file.name.split('/').some((part) => part.startsWith('.') || part === '__MACOSX')
          },
          (err, out) => (err ? reject(err) : resolve(out))
        );
      });

      const names = Object.keys(entries).sort((a, b) => collator.compare(a, b));
      if (names.length === 0) {
        setNotice(`"${archive.name}" 안에서 이미지를 찾지 못했어요`);
        return;
      }

      const items = names.map((path) => {
        const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
        const blob = new Blob([entries[path]], { type: MIME_BY_EXT[ext] || 'image/jpeg' });
        return { name: path.split('/').pop() || path, url: URL.createObjectURL(blob) };
      });

      // 같은 책이면 마지막으로 보던 위치에서 이어서
      const saved = await kvGet<SavedProgress>('progress');
      let index = 0;
      if (saved && saved.name === archive.name) {
        if (saved.viewMode) setViewMode(saved.viewMode);
        if (saved.readingDirection) setReadingDirection(saved.readingDirection);
        if (saved.pageTurnSide) setPageTurnSide(saved.pageTurnSide);
        index = Math.max(0, saved.index || 0);
      }

      currentBookRef.current = { name: archive.name, source };
      setCurrentBookName(archive.name);
      applyBook(archive.name.replace(ARCHIVE_EXT, ''), items, index);
      setNotice('');

      // 앱을 껐다 켜도 이어볼 수 있게 이 책을 앱 저장소에 보관 (한 권만 유지)
      void kvSet('lastBook', { name: archive.name, blob: archive, source } satisfies SavedBook);
      void navigator.storage?.persist?.();
    } catch {
      setNotice(`"${archive.name}" 압축을 풀 수 없어요 (손상되었거나 암호가 걸린 파일일 수 있어요)`);
    } finally {
      setLoading(false);
    }
  };

  const handleLoadFiles = (fileList: FileList | File[]) => {
    const all = Array.from(fileList);

    const archives = all
      .filter((f) => ARCHIVE_EXT.test(f.name))
      .sort((a, b) => collator.compare(a.name, b.name));
    if (archives.length > 0) {
      // 여러 권을 한꺼번에 고르면 이름 순으로 이어서 본다
      queueRef.current = archives.length > 1 ? archives : [];
      void loadArchive(archives[0], { source: archives.length > 1 ? 'queue' : 'single' });
      return;
    }
    if (all.some((f) => /\.(alz|rar|7z|egg)$/i.test(f.name))) {
      setNotice('알집 전용(.alz)·rar·7z 형식은 아직 열 수 없어요. zip 또는 cbz 형식으로 압축해 주세요');
      return;
    }

    const imgs = all.filter((f) => f.type.startsWith('image/') || IMAGE_EXT.test(f.name));
    if (imgs.length === 0) return;

    imgs.sort((a, b) => {
      const pathA = (a as File & { webkitRelativePath?: string }).webkitRelativePath || a.name;
      const pathB = (b as File & { webkitRelativePath?: string }).webkitRelativePath || b.name;
      return collator.compare(pathA, pathB);
    });

    // 폴더/사진으로 연 책은 이어보기 대상이 아니므로 저장된 기록을 지운다
    currentBookRef.current = null;
    setCurrentBookName('');
    queueRef.current = [];
    void kvDel('lastBook');
    void kvDel('progress');

    const rel = (imgs[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
    applyBook(
      rel && rel.includes('/') ? rel.split('/')[0] : `만화책 묶음 (${imgs.length}장)`,
      imgs.map((f) => ({ name: f.name, url: URL.createObjectURL(f) }))
    );
    setNotice('');
  };

  /** 책 폴더에서 이름으로 한 권을 열기 */
  const loadFromLibrary = async (name: string) => {
    const handle = libraryRef.current.handle;
    if (!handle) return;
    try {
      if (!(await ensureReadPermission(handle))) {
        flashNotice('폴더 읽기 권한이 필요해요. "책 폴더"에서 다시 선택해 주세요');
        return;
      }
      const file = await getArchiveFile(handle, name);
      await loadArchive(file, { source: 'library' });
    } catch {
      flashNotice(`"${name}" 을(를) 열 수 없어요. 폴더가 이동되었는지 확인해 주세요`);
    }
  };

  /** 책 폴더 연결: 이 폴더 안의 압축파일들이 "같은 레벨의 책"이 된다 */
  const openLibraryFolder = async () => {
    if (!supportsDirPicker()) {
      flashNotice(
        '이 브라우저는 폴더 연결을 지원하지 않아요. 압축파일을 여러 개 한꺼번에 선택하면 순서대로 이어서 볼 수 있어요',
        6000
      );
      archiveInputRef.current?.click();
      return;
    }
    try {
      const handle = await pickLibraryDir();
      const names = await listArchives(handle);
      if (names.length === 0) {
        flashNotice('이 폴더에서 zip/cbz 파일을 찾지 못했어요');
        return;
      }
      libraryRef.current = { handle, names };
      setLibraryNames(names);
      void kvSet('dirHandle', handle);

      const saved = await kvGet<SavedProgress>('progress');
      const start = saved && names.includes(saved.name) ? saved.name : names[0];
      queueRef.current = [];
      await loadFromLibrary(start);
    } catch {
      // 사용자가 폴더 선택을 취소함
    }
  };

  /** 마지막 페이지에서 더 넘기면 같은 레벨의 다음 압축파일을 불러온다 */
  const goNextBook = async () => {
    if (loading) return;
    const cur = currentBookRef.current;

    // 1) 한꺼번에 고른 여러 권
    if (queueRef.current.length > 0 && cur) {
      const i = queueRef.current.findIndex((f) => f.name === cur.name);
      if (i >= 0) {
        const next = queueRef.current[i + 1];
        if (next) void loadArchive(next, { source: 'queue' });
        else flashNotice('마지막 권이에요');
        return;
      }
    }

    // 2) 연결해 둔 책 폴더
    const lib = libraryRef.current;
    if (lib.handle && cur?.source === 'library') {
      try {
        if (!(await ensureReadPermission(lib.handle))) {
          flashNotice('다음 권을 열려면 폴더 읽기 권한이 필요해요. 다시 넘기면 권한을 물어봐요', 5000);
          return;
        }
        if (!lib.names) {
          lib.names = await listArchives(lib.handle);
          setLibraryNames(lib.names);
        }
        const i = lib.names.indexOf(cur.name);
        const next = i >= 0 ? lib.names[i + 1] : undefined;
        if (next) await loadFromLibrary(next);
        else flashNotice(i >= 0 ? '마지막 권이에요' : '폴더에서 현재 책을 찾지 못했어요');
      } catch {
        flashNotice('폴더에 접근할 수 없어요. "책 폴더"로 다시 연결해 주세요', 5000);
      }
      return;
    }

    // 3) 폴더 정보가 없으면 직접 고르게 한다
    flashNotice(
      '다음 권을 선택해 주세요. (자동으로 이어 보려면 "책 폴더"로 폴더를 연결하세요)',
      6000
    );
    archiveInputRef.current?.click();
  };
  goNextBookRef.current = () => void goNextBook();

  const getSliceStyle = (desc?: HalfDescriptor): React.CSSProperties => {
    if (!desc) return {};
    if (desc.slice === 'left-half') {
      return {
        backgroundImage: `url("${desc.url}")`,
        backgroundSize: 'auto 100%',
        backgroundPosition: '0% center',
        backgroundRepeat: 'no-repeat'
      };
    }
    if (desc.slice === 'right-half') {
      return {
        backgroundImage: `url("${desc.url}")`,
        backgroundSize: 'auto 100%',
        backgroundPosition: '100% center',
        backgroundRepeat: 'no-repeat'
      };
    }
    return {
      backgroundImage: `url("${desc.url}")`,
      backgroundSize: 'contain',
      backgroundPosition: 'center center'
    };
  };

  /**
   * 접힌 페이지를 애니메이션으로 이동시킨다.
   * pathFn(t) 은 t(0~1) 에서의 끌려온 위치(페이지 좌표)를 돌려준다.
   */
  const animateCurl = useCallback(
    (
      base: Omit<CurlState, 'm'>,
      pathFn: (t: number) => Pt,
      duration: number,
      ease: (t: number) => number,
      onDone: () => void
    ) => {
      animatingRef.current = true;
      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / duration);
        const m = clampCurlPoint(pathFn(ease(t)), base.g, base.w, base.h);
        if (t < 1) {
          setCurl({ ...base, m });
          requestAnimationFrame(step);
        } else {
          animatingRef.current = false;
          onDone();
        }
      };
      requestAnimationFrame(step);
    },
    []
  );

  const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

  /** 현재 접힌 상태에서 끝까지 넘기거나(complete) 원래대로 되돌린다 */
  const finishCurl = useCallback(
    (base: CurlState, complete: boolean) => {
      const from = base.m;
      const to: Pt = complete ? { x: -base.w, y: base.g.y } : base.g;
      if (complete) playPageSound();
      animateCurl(
        base,
        (t) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }),
        complete ? 340 : 240,
        easeOut,
        () => {
          if (complete) setCurrentIndex(base.nextIdx);
          setCurl(null);
        }
      );
    },
    [animateCurl, playPageSound]
  );

  const triggerSideTurn = useCallback(
    (side: 'left' | 'right') => {
      const chassis = chassisRef.current;
      if (curl !== null || animatingRef.current || pages.length <= 1 || !chassis) return;
      const isSinglePage = viewMode === 'split';
      const delta = side === pageTurnSide ? 1 : -1;
      const nextIdx = currentIndex + delta;
      if (delta > 0 && nextIdx >= pages.length) {
        goNextBookRef.current();
        return;
      }
      if (nextIdx < 0 || nextIdx >= pages.length) return;

      const w = isSinglePage ? chassis.offsetWidth : chassis.offsetWidth / 2;
      const h = chassis.offsetHeight;
      const g: Pt = { x: w, y: h };
      const base = { side, nextIdx, w, h, g };
      playPageSound();
      animateCurl(
        base,
        (t) => ({ x: g.x - 2 * w * t, y: g.y - Math.sin(Math.PI * t) * h * 0.16 }),
        620,
        easeInOut,
        () => {
          setCurrentIndex(nextIdx);
          setCurl(null);
        }
      );
    },
    [curl, pages.length, pageTurnSide, currentIndex, viewMode, animateCurl, playPageSound]
  );

  const handleCurlDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const chassis = chassisRef.current;
    if (curl !== null || animatingRef.current || pages.length <= 1 || !chassis) return;
    const rect = chassis.getBoundingClientRect();
    const scale = rect.width / chassis.offsetWidth || 1;
    const isSinglePage = viewMode === 'split';
    const w = isSinglePage ? chassis.offsetWidth : chassis.offsetWidth / 2;
    const h = chassis.offsetHeight;
    const cx = (e.clientX - rect.left) / scale;
    const cy = (e.clientY - rect.top) / scale;

    const side: 'left' | 'right' = isSinglePage
      ? (pageTurnSide === 'left' ? 'right' : 'left')
      : cx <= w ? 'left' : 'right';
    const delta = side === 'left' ? 1 : -1;
    const nextIdx = currentIndex + delta;
    if (delta > 0 && nextIdx >= pages.length) {
      // 마지막 페이지: 손을 뗄 때(사용자 동작 중) 다음 권을 불러온다
      endIntentRef.current = e.pointerId;
      chassis.setPointerCapture(e.pointerId);
      return;
    }
    if (nextIdx < 0 || nextIdx >= pages.length) return;

    // 잡은 높이를 가까운 위/아래 모서리 쪽으로 끌어당겨 모서리부터 말려 올라오는 느낌을 준다
    const edgeY = cy < h / 2 ? 0 : h;
    const gy = Math.max(0, Math.min(h, cy * 0.3 + edgeY * 0.7));
    const g: Pt = { x: w, y: gy };

    dragRef.current = {
      pointerId: e.pointerId,
      side,
      nextIdx,
      w,
      h,
      scale,
      g,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastT: performance.now(),
      vx: 0,
      moved: false
    };
    setCurl({ side, nextIdx, w, h, g, m: g });
    chassis.setPointerCapture(e.pointerId);
  };

  const handleCurlMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dxClient = e.clientX - d.startX;
    const dyClient = e.clientY - d.startY;
    if (Math.abs(dxClient) + Math.abs(dyClient) > 6) d.moved = true;

    const now = performance.now();
    const dt = Math.max(1, now - d.lastT);
    const inst = (e.clientX - d.lastX) / dt;
    d.vx = d.vx * 0.6 + inst * 0.4;
    d.lastX = e.clientX;
    d.lastT = now;

    const dragMotion: 'left' | 'right' = e.clientX - d.startX > 0 ? 'left' : 'right';
    if (Math.abs(e.clientX - d.startX) > 12) d.side = dragMotion;

    const dxLocal = (d.side === 'right' ? dxClient : -dxClient) / d.scale;
    const dyLocal = dyClient / d.scale;
    const m = clampCurlPoint({ x: d.g.x + dxLocal, y: d.g.y + dyLocal }, d.g, d.w, d.h);
    setCurl({ side: d.side, nextIdx: d.nextIdx, w: d.w, h: d.h, g: d.g, m });
  };

  const handleCurlUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (endIntentRef.current === e.pointerId) {
      endIntentRef.current = null;
      goNextBookRef.current();
      return;
    }
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId || !curl) return;
    dragRef.current = null;

    const progress = curlProgress(curl.m, d.w);
    // 제본선 쪽으로 향하는 속도(px/ms)
    const towardSpine = d.side === 'right' ? -d.vx : d.vx;
    let complete: boolean;
    if (!d.moved) complete = true; // 탭 = 그냥 넘기기
    else if (towardSpine > 0.5) complete = true;
    else if (towardSpine < -0.5) complete = false;
    else complete = progress > 0.3;

    finishCurl(curl, complete);
  };

  const handleCurlCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (endIntentRef.current === e.pointerId) endIntentRef.current = null;
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId || !curl) return;
    dragRef.current = null;
    finishCurl(curl, false);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') triggerSideTurn('left');
      else if (e.key === 'ArrowRight') triggerSideTurn('right');
      else if (e.key === 'f' || e.key === 'F') void toggleImmersive();
      else if (e.key === 'Escape' && immersive) void toggleImmersive();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [triggerSideTurn, toggleImmersive, immersive]);

  const currentSpread = pages[currentIndex];
  const nextSpread = curl ? pages[curl.nextIdx] : undefined;
  const flipSide = curl?.side ?? null;
  const singlePageMode = viewMode === 'split';

  // 책 크기: 이미지 비율을 유지하면서 가능한 영역을 최대한 채운다
  const baseAspect = imgSize ? imgSize.w / imgSize.h : 1.5;
  const bookAspect = imgSize
    ? (viewMode === 'pair' ? 2 : viewMode === 'split' ? 0.5 : 1) * baseAspect
    : 1.5;
  const boxW = immersive ? viewport.w : Math.min(viewport.w * 0.86, 960);
  const boxH = immersive ? viewport.h : Math.min(viewport.h * 0.76, 720);
  let chassisW = boxW;
  let chassisH = chassisW / bookAspect;
  if (chassisH > boxH) {
    chassisH = boxH;
    chassisW = chassisH * bookAspect;
  }
  const pageRadius = immersive ? '' : 'rounded-l-[10px]';

  return (
    <div className="h-dvh w-screen flex flex-col bg-[#0b0d13] text-slate-100 relative">
      {/* Header */}
      {!immersive && (
      <header className="px-3 py-2.5 bg-slate-900/90 border-b border-slate-800 shrink-0">
        <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center shrink-0">
              <BookOpen className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="font-bold text-sm sm:text-base truncate">{bookTitle}</h1>
              <p className="text-[11px] text-slate-400 truncate">
                {notice ||
                  (pages.length > 0
                    ? `${currentIndex + 1} / ${pages.length} 페이지 · ${currentSpread?.title}`
                    : '압축파일(zip/cbz)·폴더·사진 파일을 선택하거나 드래그 앤 드롭하세요')}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <input
              ref={folderInputRef}
              type="file"
              webkitdirectory=""
              directory=""
              multiple
              accept="image/*"
              className="hidden"
              onChange={(e) => e.target.files && handleLoadFiles(e.target.files)}
            />
            <input
              ref={archiveInputRef}
              type="file"
              multiple
              accept=".zip,.cbz,.alz,application/zip,application/x-zip-compressed,application/vnd.comicbook+zip"
              className="hidden"
              onChange={(e) => {
                if (e.target.files) handleLoadFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <input
              ref={filesInputRef}
              type="file"
              multiple
              accept="image/*"
              className="hidden"
              onChange={(e) => e.target.files && handleLoadFiles(e.target.files)}
            />

            <button
              onClick={() => void openLibraryFolder()}
              title="책 폴더를 연결하면 마지막 페이지에서 다음 권이 자동으로 열려요"
              className="h-9 px-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[10px] sm:text-xs font-medium flex items-center gap-1.5"
            >
              <Library className="w-4 h-4 text-amber-300" />
              <span className="hidden sm:inline">책 폴더</span>
            </button>

            {libraryNames.length > 0 && (
              <button
                onClick={() => setLibraryOpen(true)}
                className="h-9 px-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[10px] sm:text-xs font-medium"
              >
                목록
              </button>
            )}

            <button
              onClick={() => archiveInputRef.current?.click()}
              className="h-9 px-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-[10px] sm:text-xs font-semibold flex items-center gap-1.5"
            >
              <FileArchive className="w-4 h-4" />
              <span className="hidden sm:inline">열기</span>
            </button>

            <button
              onClick={() => folderInputRef.current?.click()}
              className="h-9 px-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[10px] sm:text-xs font-medium flex items-center gap-1.5"
            >
              <FolderOpen className="w-4 h-4" />
              <span className="hidden sm:inline">폴더</span>
            </button>

            <button
              onClick={() => filesInputRef.current?.click()}
              className="h-9 px-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[10px] sm:text-xs font-medium flex items-center gap-1.5"
            >
              <Images className="w-4 h-4 text-indigo-400" />
              <span className="hidden sm:inline">사진</span>
            </button>

            <button
              onClick={() => setReadingDirection((d) => (d === 'rtl' ? 'ltr' : 'rtl'))}
              className="h-9 px-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[10px] sm:text-xs font-semibold text-amber-300"
            >
              {readingDirection === 'rtl' ? '만화책' : '일반책'}
            </button>

            <button
              onClick={() => setViewMode((m) => (m === 'spread' ? 'split' : m === 'split' ? 'pair' : 'spread'))}
              className="h-9 px-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[10px] sm:text-xs font-semibold text-emerald-300 flex items-center gap-1"
            >
              <Columns className="w-4 h-4" />
              <span>{viewMode === 'spread' ? '양면' : viewMode === 'split' ? '분할' : '2장'}</span>
            </button>

            <button
              onClick={() => void toggleImmersive()}
              title="꽉 찬 화면 (F)"
              className="h-9 px-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[10px] sm:text-xs font-semibold flex items-center gap-1"
            >
              <Maximize2 className="w-4 h-4 text-sky-300" />
              <span className="hidden sm:inline">전체</span>
            </button>

            <button
              onClick={() => setSoundEnabled((s) => !s)}
              className="h-9 w-9 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 flex items-center justify-center"
            >
              {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
            </button>

            {deferredPrompt && (
              <button
                onClick={async () => {
                  await deferredPrompt.prompt();
                  setDeferredPrompt(null);
                }}
                className="h-9 px-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] sm:text-xs font-semibold flex items-center gap-1"
              >
                <Download className="w-4 h-4" />
                <span className="hidden sm:inline">앱 설치</span>
              </button>
            )}
          </div>
        </div>
      </header>
      )}

      {/* Main Viewport */}
      <main
        className={`relative flex-1 flex items-center justify-center overflow-hidden book-viewport ${
          immersive ? 'p-0' : 'p-4'
        }`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files?.length) handleLoadFiles(e.dataTransfer.files);
        }}
      >
        {pages.length === 0 ? (
          <div
            onClick={() => archiveInputRef.current?.click()}
            className="max-w-lg w-full p-10 rounded-3xl border-2 border-dashed border-slate-700 hover:border-indigo-500 bg-slate-900/60 flex flex-col items-center text-center cursor-pointer transition"
          >
            <FolderOpen className="w-14 h-14 text-indigo-400 mb-4" />
            <h2 className="text-lg font-bold text-white">
              {loading ? '압축을 푸는 중…' : '만화책 압축파일(zip/cbz)이나 폴더를 선택해 주세요'}
            </h2>
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">
              압축파일 한 권을 선택하면 자동으로 풀어서 첫 페이지부터 보여줘요. 폴더 통째로 불러오기 또는 여러 장의 스캔 이미지를 한 번에 선택해도 갤럭시 폴드 스타일의 3D 책 넘김 모션으로 감상할 수 있습니다.
            </p>
          </div>
        ) : (
          <>
            {!immersive && (
            <button
              onClick={() => triggerSideTurn('left')}
              className="absolute left-4 z-40 w-11 h-24 rounded-2xl bg-slate-900/70 hover:bg-slate-800 border border-white/10 flex flex-col items-center justify-center"
            >
              <ChevronLeft className="w-6 h-6" />
              <span className="text-[10px]">{readingDirection === 'rtl' ? '다음' : '이전'}</span>
            </button>
            )}

            {!immersive && (
            <button
              onClick={() => triggerSideTurn('right')}
              className="absolute right-4 z-40 w-11 h-24 rounded-2xl bg-slate-900/70 hover:bg-slate-800 border border-white/10 flex flex-col items-center justify-center"
            >
              <ChevronRight className="w-6 h-6" />
              <span className="text-[10px]">{readingDirection === 'rtl' ? '이전' : '다음'}</span>
            </button>
            )}

            <div
              ref={chassisRef}
              style={{
                width: chassisW,
                height: chassisH,
                transform: `scale(${zoom})`
              }}
              className={`book-chassis cursor-grab active:cursor-grabbing ${immersive ? 'book-chassis-bare' : ''}`}
              onPointerDown={handleCurlDown}
              onPointerMove={handleCurlMove}
              onPointerUp={handleCurlUp}
              onPointerCancel={handleCurlCancel}
            >
              {/* Base Left Page */}
              <div
                className={`page-half left-0 ${pageRadius}`}
                style={singlePageMode ? { width: '100%', borderRadius: immersive ? 0 : '10px' } : undefined}
              >
                <div
                  className="w-full h-full bg-no-repeat"
                  style={getSliceStyle(
                    flipSide === 'left' && nextSpread ? nextSpread.left : currentSpread?.left
                  )}
                />
              </div>

              {!singlePageMode && (
                <div className={`page-half right-0 ${immersive ? '' : 'rounded-r-[10px]'}`}>
                  <div
                    className="w-full h-full bg-no-repeat"
                    style={getSliceStyle(
                      flipSide === 'right' && nextSpread ? nextSpread.right : currentSpread?.right
                    )}
                  />
                </div>
              )}

              {/* 포인터를 따라 접히는 페이지 */}
              {curl && nextSpread && currentSpread && (
                <PageCurl
                  side={curl.side}
                  w={curl.w}
                  h={curl.h}
                  g={curl.g}
                  m={curl.m}
                  rounded={!immersive}
                  fullPage={singlePageMode}
                  front={getSliceStyle(curl.side === 'right' ? currentSpread.right : currentSpread.left)}
                  back={getSliceStyle(curl.side === 'right' ? nextSpread.left : nextSpread.right)}
                />
              )}

              {creaseEnabled && <div className="center-crease" />}
            </div>
          </>
        )}
      </main>

      {/* Bottom Bar */}
      {!immersive && (
      <footer className="h-12 px-4 bg-slate-900/90 border-t border-slate-800 flex items-center justify-between gap-4 shrink-0">
        <button
          onClick={() => setCreaseEnabled((c) => !c)}
          className="text-xs px-2.5 py-1 rounded bg-slate-800 border border-slate-700"
        >
          폴드 중앙선: {creaseEnabled ? 'ON' : 'OFF'}
        </button>

        <input
          type="range"
          min={0}
          max={Math.max(0, pages.length - 1)}
          value={currentIndex}
          onChange={(e) => setCurrentIndex(Number(e.target.value))}
          className="flex-1 max-w-lg accent-indigo-500"
        />

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setZoom((z) => Math.max(0.7, Number((z - 0.15).toFixed(2))))}
            className="w-7 h-7 rounded bg-slate-800 border border-slate-700 text-xs font-bold"
          >
            -
          </button>
          <span className="text-xs font-mono w-11 text-center">{Math.round(zoom * 100)}%</span>
          <button
            onClick={() => setZoom((z) => Math.min(2.2, Number((z + 0.15).toFixed(2))))}
            className="w-7 h-7 rounded bg-slate-800 border border-slate-700 text-xs font-bold"
          >
            +
          </button>
          <button
            onClick={() => void toggleImmersive()}
            title="꽉 찬 화면 (F)"
            className="p-1.5 rounded bg-slate-800 border border-slate-700"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </footer>
      )}

      {libraryOpen && (
        <div
          className="absolute inset-0 z-[60] bg-black/70 flex items-center justify-center p-4"
          onClick={() => setLibraryOpen(false)}
        >
          <div
            className="w-full max-w-md max-h-[80vh] flex flex-col rounded-2xl bg-slate-900 border border-slate-700"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
              <h2 className="text-sm font-bold">책 목록 ({libraryNames.length}권)</h2>
              <button onClick={() => setLibraryOpen(false)} className="p-1 rounded hover:bg-slate-800">
                <X className="w-4 h-4" />
              </button>
            </div>
            <ul className="overflow-y-auto p-2">
              {libraryNames.map((n) => (
                <li key={n}>
                  <button
                    onClick={() => {
                      setLibraryOpen(false);
                      void loadFromLibrary(n);
                    }}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate hover:bg-slate-800 ${
                      n === currentBookName ? 'bg-indigo-600/30 text-indigo-200' : ''
                    }`}
                  >
                    {n}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

    </div>
  );
}
