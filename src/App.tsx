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
  BookOpen,
  Columns
} from 'lucide-react';

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
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  // Flip animation state
  const [flipSide, setFlipSide] = useState<'left' | 'right' | null>(null);
  const [flipProgress, setFlipProgress] = useState<number>(0);
  const [targetIndex, setTargetIndex] = useState<number | null>(null);

  const isDraggingRef = useRef<boolean>(false);
  const dragStartXRef = useRef<number>(0);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
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

  const handleLoadFiles = (fileList: FileList | File[]) => {
    const imgs = Array.from(fileList).filter(
      (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(f.name)
    );
    if (imgs.length === 0) return;

    imgs.sort((a, b) => {
      const pathA = (a as File & { webkitRelativePath?: string }).webkitRelativePath || a.name;
      const pathB = (b as File & { webkitRelativePath?: string }).webkitRelativePath || b.name;
      return collator.compare(pathA, pathB);
    });

    rawFiles.forEach((f) => URL.revokeObjectURL(f.url));
    const nextRaw = imgs.map((f) => ({
      name: f.name,
      url: URL.createObjectURL(f)
    }));

    const rel = (imgs[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
    setBookTitle(rel && rel.includes('/') ? rel.split('/')[0] : `만화책 묶음 (${imgs.length}장)`);
    setRawFiles(nextRaw);
    setCurrentIndex(0);
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

  const animateTurn = useCallback(
    (side: 'left' | 'right', nextIdx: number, startP: number, endP: number, duration = 480) => {
      setFlipSide(side);
      setTargetIndex(nextIdx);
      if (endP === 1 && startP < 0.25) playPageSound();

      const t0 = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        const p = startP + (endP - startP) * eased;
        setFlipProgress(p);
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          if (endP === 1) setCurrentIndex(nextIdx);
          setFlipSide(null);
          setTargetIndex(null);
          setFlipProgress(0);
        }
      };
      requestAnimationFrame(step);
    },
    [playPageSound]
  );

  const triggerSideTurn = useCallback(
    (side: 'left' | 'right') => {
      if (flipSide !== null || pages.length <= 1) return;
      const delta =
        readingDirection === 'rtl' ? (side === 'left' ? 1 : -1) : side === 'right' ? 1 : -1;
      const nextIdx = currentIndex + delta;
      if (nextIdx < 0 || nextIdx >= pages.length) return;
      animateTurn(side, nextIdx, 0, 1);
    },
    [flipSide, pages.length, readingDirection, currentIndex, animateTurn]
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') triggerSideTurn('left');
      else if (e.key === 'ArrowRight') triggerSideTurn('right');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [triggerSideTurn]);

  const currentSpread = pages[currentIndex];
  const nextSpread = targetIndex !== null ? pages[targetIndex] : undefined;

  return (
    <div className="h-screen w-screen flex flex-col bg-[#0b0d13] text-slate-100">
      {/* Header */}
      <header className="h-14 px-4 bg-slate-900/90 border-b border-slate-800 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center shrink-0">
            <BookOpen className="w-5 h-5 text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="font-bold text-sm sm:text-base truncate">{bookTitle}</h1>
            <p className="text-[11px] text-slate-400 truncate">
              {pages.length > 0
                ? `${currentIndex + 1} / ${pages.length} 페이지 · ${currentSpread?.title}`
                : '폴더 열기 또는 사진 파일들을 드래그 앤 드롭하세요'}
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
            ref={filesInputRef}
            type="file"
            multiple
            accept="image/*"
            className="hidden"
            onChange={(e) => e.target.files && handleLoadFiles(e.target.files)}
          />

          <button
            onClick={() => folderInputRef.current?.click()}
            className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold flex items-center gap-1.5"
          >
            <FolderOpen className="w-4 h-4" />
            <span>폴더 뭉탱이 열기</span>
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

      {/* Main Viewport */}
      <main
        className="relative flex-1 flex items-center justify-center p-4 overflow-hidden book-viewport"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files?.length) handleLoadFiles(e.dataTransfer.files);
        }}
      >
        {pages.length === 0 ? (
          <div
            onClick={() => folderInputRef.current?.click()}
            className="max-w-lg w-full p-10 rounded-3xl border-2 border-dashed border-slate-700 hover:border-indigo-500 bg-slate-900/60 flex flex-col items-center text-center cursor-pointer transition"
          >
            <FolderOpen className="w-14 h-14 text-indigo-400 mb-4" />
            <h2 className="text-lg font-bold text-white">만화책 폴더나 이미지들을 선택해 주세요</h2>
            <p className="text-xs text-slate-400 mt-2 leading-relaxed">
              폴더 통째로 불러오기 또는 여러 장의 스캔 이미지를 한 번에 선택하면 갤럭시 폴드 스타일의 3D 책 넘김 모션으로 감상할 수 있습니다.
            </p>
          </div>
        ) : (
          <>
            <button
              onClick={() => triggerSideTurn('left')}
              className="absolute left-4 z-40 w-11 h-24 rounded-2xl bg-slate-900/70 hover:bg-slate-800 border border-white/10 flex flex-col items-center justify-center"
            >
              <ChevronLeft className="w-6 h-6" />
              <span className="text-[10px]">{readingDirection === 'rtl' ? '다음' : '이전'}</span>
            </button>

            <button
              onClick={() => triggerSideTurn('right')}
              className="absolute right-4 z-40 w-11 h-24 rounded-2xl bg-slate-900/70 hover:bg-slate-800 border border-white/10 flex flex-col items-center justify-center"
            >
              <ChevronRight className="w-6 h-6" />
              <span className="text-[10px]">{readingDirection === 'rtl' ? '이전' : '다음'}</span>
            </button>

            <div
              ref={chassisRef}
              style={{
                width: 'min(86vw, 960px)',
                height: 'min(76vh, 720px)',
                transform: `scale(${zoom})`
              }}
              className="book-chassis cursor-grab active:cursor-grabbing"
              onPointerDown={(e) => {
                if (flipSide !== null || pages.length <= 1 || !chassisRef.current) return;
                const rect = chassisRef.current.getBoundingClientRect();
                const side: 'left' | 'right' = e.clientX - rect.left < rect.width / 2 ? 'left' : 'right';
                const delta =
                  readingDirection === 'rtl' ? (side === 'left' ? 1 : -1) : side === 'right' ? 1 : -1;
                const nextIdx = currentIndex + delta;
                if (nextIdx < 0 || nextIdx >= pages.length) return;

                isDraggingRef.current = true;
                dragStartXRef.current = e.clientX;
                setFlipSide(side);
                setTargetIndex(nextIdx);
                setFlipProgress(0.02);
                chassisRef.current.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!isDraggingRef.current || !chassisRef.current || !flipSide) return;
                const rect = chassisRef.current.getBoundingClientRect();
                const dx = e.clientX - dragStartXRef.current;
                const rawP =
                  flipSide === 'right' ? -dx / (rect.width * 0.65) : dx / (rect.width * 0.65);
                setFlipProgress(Math.max(0.01, Math.min(0.99, rawP)));
              }}
              onPointerUp={(e) => {
                if (!isDraggingRef.current || !flipSide || targetIndex === null) return;
                isDraggingRef.current = false;
                const dist = Math.abs(e.clientX - dragStartXRef.current);
                if (dist < 12 || flipProgress >= 0.22) {
                  animateTurn(flipSide, targetIndex, flipProgress, 1, 360);
                } else {
                  animateTurn(flipSide, targetIndex, flipProgress, 0, 260);
                }
              }}
            >
              {/* Base Left Page */}
              <div className="page-half left-0 rounded-l-[10px]">
                <div
                  className="w-full h-full bg-no-repeat"
                  style={getSliceStyle(
                    flipSide === 'left' && nextSpread ? nextSpread.left : currentSpread?.left
                  )}
                />
              </div>

              {/* Base Right Page */}
              <div className="page-half right-0 rounded-r-[10px]">
                <div
                  className="w-full h-full bg-no-repeat"
                  style={getSliceStyle(
                    flipSide === 'right' && nextSpread ? nextSpread.right : currentSpread?.right
                  )}
                />
              </div>

              {/* 3D Flipping Leaf */}
              {flipSide && nextSpread && (
                <div
                  className={`flip-leaf ${flipSide === 'right' ? 'origin-left' : 'origin-right'}`}
                  style={{
                    transform: `rotateY(${
                      flipSide === 'right' ? -180 * flipProgress : 180 * flipProgress
                    }deg)`
                  }}
                >
                  <div className="leaf-face">
                    <div
                      className="w-full h-full bg-no-repeat"
                      style={getSliceStyle(
                        flipSide === 'right' ? currentSpread.right : currentSpread.left
                      )}
                    />
                  </div>
                  <div className="leaf-face leaf-back">
                    <div
                      className="w-full h-full bg-no-repeat"
                      style={getSliceStyle(flipSide === 'right' ? nextSpread.left : nextSpread.right)}
                    />
                  </div>
                </div>
              )}

              {creaseEnabled && <div className="center-crease" />}
            </div>
          </>
        )}
      </main>

      {/* Bottom Bar */}
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
            onClick={() => {
              if (!document.fullscreenElement) document.documentElement.requestFullscreen();
              else document.exitFullscreen();
            }}
            className="p-1.5 rounded bg-slate-800 border border-slate-700"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </footer>
    </div>
  );
}
