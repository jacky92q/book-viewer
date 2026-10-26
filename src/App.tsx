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
  FileArchive
} from 'lucide-react';
import { unzip } from 'fflate';
import PageCurl from './PageCurl';
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
  const [viewMode, setViewMode] = useState<ViewMode>('spread');
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [creaseEnabled, setCreaseEnabled] = useState<boolean>(true);
  const [zoom, setZoom] = useState<number>(1);
  const [immersive, setImmersive] = useState<boolean>(false);
  const [hudVisible, setHudVisible] = useState<boolean>(true);
  const [viewport, setViewport] = useState<{ w: number; h: number }>({
    w: window.innerWidth,
    h: window.innerHeight
  });
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const hudTimerRef = useRef<number | null>(null);
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
        list.push({
          title: `${f.name} (1/2)`,
          left: { url: f.url, slice: firstSlice, label: `${idx + 1}-1` },
          right: { url: f.url, slice: firstSlice, label: `${idx + 1}-1` },
          thumbUrl: f.url
        });
        list.push({
          title: `${f.name} (2/2)`,
          left: { url: f.url, slice: secondSlice, label: `${idx + 1}-2` },
          right: { url: f.url, slice: secondSlice, label: `${idx + 1}-2` },
          thumbUrl: f.url
        });
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

  const applyBook = (title: string, items: { name: string; url: string }[]) => {
    rawFiles.forEach((f) => URL.revokeObjectURL(f.url));
    setBookTitle(title);
    setRawFiles(items);
    setCurrentIndex(0);
    setCurl(null);
  };

  /** zip / cbz 압축파일 한 권을 풀어서 이미지들을 이름 순으로 불러온다 */
  const loadArchive = async (archive: File) => {
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
      applyBook(archive.name.replace(ARCHIVE_EXT, ''), items);
      setNotice('');
    } catch {
      setNotice(`"${archive.name}" 압축을 풀 수 없어요 (손상되었거나 암호가 걸린 파일일 수 있어요)`);
    } finally {
      setLoading(false);
    }
  };

  const handleLoadFiles = (fileList: FileList | File[]) => {
    const all = Array.from(fileList);

    const archive = all.find((f) => ARCHIVE_EXT.test(f.name));
    if (archive) {
      void loadArchive(archive);
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

    const rel = (imgs[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
    applyBook(
      rel && rel.includes('/') ? rel.split('/')[0] : `만화책 묶음 (${imgs.length}장)`,
      imgs.map((f) => ({ name: f.name, url: URL.createObjectURL(f) }))
    );
    setNotice('');
  };

  const getSliceStyle = (desc?: HalfDescriptor): React.CSSProperties => {
    if (!desc) return {};
    if (desc.slice === 'left-half') {
      return {
        backgroundImage: `url("${desc.url}")`,
        backgroundSize: '200% 100%',
        backgroundPosition: '0% center'
      };
    }
    if (desc.slice === 'right-half') {
      return {
        backgroundImage: `url("${desc.url}")`,
        backgroundSize: '200% 100%',
        backgroundPosition: '100% center'
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
      const delta =
        readingDirection === 'rtl' ? (side === 'left' ? 1 : -1) : side === 'right' ? 1 : -1;
      const nextIdx = currentIndex + delta;
      if (nextIdx < 0 || nextIdx >= pages.length) return;

      const w = chassis.offsetWidth / 2;
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
    [curl, pages.length, readingDirection, currentIndex, animateCurl, playPageSound]
  );

  const handleCurlDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const chassis = chassisRef.current;
    if (curl !== null || animatingRef.current || pages.length <= 1 || !chassis) return;
    const rect = chassis.getBoundingClientRect();
    const scale = rect.width / chassis.offsetWidth || 1;
    const w = chassis.offsetWidth / 2;
    const h = chassis.offsetHeight;
    const cx = (e.clientX - rect.left) / scale;
    const cy = (e.clientY - rect.top) / scale;

    const side: 'left' | 'right' = cx < w ? 'left' : 'right';
    const delta =
      readingDirection === 'rtl' ? (side === 'left' ? 1 : -1) : side === 'right' ? 1 : -1;
    const nextIdx = currentIndex + delta;
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

    // 오른쪽 페이지는 왼쪽으로, 왼쪽 페이지는 오른쪽으로 끌면 제본선 쪽으로 접힌다
    const dxLocal = (d.side === 'right' ? dxClient : -dxClient) / d.scale;
    const dyLocal = dyClient / d.scale;
    const m = clampCurlPoint({ x: d.g.x + dxLocal, y: d.g.y + dyLocal }, d.g, d.w, d.h);
    setCurl({ side: d.side, nextIdx: d.nextIdx, w: d.w, h: d.h, g: d.g, m });
  };

  const handleCurlUp = (e: React.PointerEvent<HTMLDivElement>) => {
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

  // 책 크기: 이미지 비율을 유지하면서 가능한 영역을 최대한 채운다
  const bookAspect = imgSize
    ? (viewMode === 'pair' ? 2 : 1) * (imgSize.w / imgSize.h)
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
      <header className="h-14 px-4 bg-slate-900/90 border-b border-slate-800 flex items-center justify-between gap-2 shrink-0">
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

        <div className="flex items-center gap-2">
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
            onClick={() => archiveInputRef.current?.click()}
            className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold flex items-center gap-1.5"
          >
            <FileArchive className="w-4 h-4" />
            <span>압축파일 열기</span>
          </button>

          <button
            onClick={() => folderInputRef.current?.click()}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium flex items-center gap-1.5"
          >
            <FolderOpen className="w-4 h-4" />
            <span className="hidden md:inline">폴더 열기</span>
          </button>

          <button
            onClick={() => filesInputRef.current?.click()}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium flex items-center gap-1.5"
          >
            <Images className="w-4 h-4 text-indigo-400" />
            <span className="hidden sm:inline">사진 여러 장 선택</span>
          </button>

          <button
            onClick={() => setReadingDirection((d) => (d === 'rtl' ? 'ltr' : 'rtl'))}
            className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-amber-300"
          >
            {readingDirection === 'rtl' ? '⬅️ 만화책 (우→좌)' : '➡️ 일반책 (좌→우)'}
          </button>

          <button
            onClick={() =>
              setViewMode((m) => (m === 'spread' ? 'split' : m === 'split' ? 'pair' : 'spread'))
            }
            className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold text-emerald-300 flex items-center gap-1"
          >
            <Columns className="w-4 h-4" />
            <span className="hidden md:inline">
              {viewMode === 'spread' ? '양면 폴드북' : viewMode === 'split' ? '반쪽 분할' : '2장 합치기'}
            </span>
          </button>

          <button
            onClick={() => void toggleImmersive()}
            title="꽉 찬 화면 (F)"
            className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-semibold flex items-center gap-1"
          >
            <Maximize2 className="w-4 h-4 text-sky-300" />
            <span className="hidden lg:inline">꽉 찬 화면</span>
          </button>

          <button
            onClick={() => setSoundEnabled((s) => !s)}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700"
          >
            {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </button>

          {deferredPrompt && (
            <button
              onClick={async () => {
                await deferredPrompt.prompt();
                setDeferredPrompt(null);
              }}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1"
            >
              <Download className="w-4 h-4" />
              <span>앱 설치</span>
            </button>
          )}
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
              <div className={`page-half left-0 ${pageRadius}`}>
                <div
                  className="w-full h-full bg-no-repeat"
                  style={getSliceStyle(
                    flipSide === 'left' && nextSpread ? nextSpread.left : currentSpread?.left
                  )}
                />
              </div>

              {/* Base Right Page */}
              <div className={`page-half right-0 ${immersive ? '' : 'rounded-r-[10px]'}`}>
                <div
                  className="w-full h-full bg-no-repeat"
                  style={getSliceStyle(
                    flipSide === 'right' && nextSpread ? nextSpread.right : currentSpread?.right
                  )}
                />
              </div>

              {/* 포인터를 따라 접히는 페이지 */}
              {curl && nextSpread && currentSpread && (
                <PageCurl
                  side={curl.side}
                  w={curl.w}
                  h={curl.h}
                  g={curl.g}
                  m={curl.m}
                  rounded={!immersive}
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

      {/* 몰입 모드 오버레이: 잠깐 나타났다 사라지는 메뉴 + 얇은 진행바 */}
      {immersive && (
        <>
          <div
            className={`absolute top-0 inset-x-0 z-50 px-4 py-3 flex items-center justify-between gap-3 bg-gradient-to-b from-black/70 to-transparent transition-opacity duration-300 ${
              hudVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
          >
            <p className="text-xs text-slate-200 truncate">
              {bookTitle} · {currentIndex + 1} / {pages.length}
            </p>
            <button
              onClick={() => void toggleImmersive()}
              className="px-3 py-1.5 rounded-lg bg-slate-900/80 border border-white/15 text-xs font-semibold flex items-center gap-1.5 shrink-0"
            >
              <Minimize2 className="w-4 h-4" />
              <span>나가기 (Esc)</span>
            </button>
          </div>
          <div className="absolute bottom-0 inset-x-0 h-[3px] bg-white/10 z-50 pointer-events-none">
            <div
              className="h-full bg-indigo-400/80 transition-all"
              style={{
                width: `${pages.length > 1 ? (currentIndex / (pages.length - 1)) * 100 : 0}%`,
                marginLeft: readingDirection === 'rtl' ? 'auto' : undefined
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
