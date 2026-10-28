
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Columns,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Maximize2,
  Minimize2,
  ArrowLeftRight,
  FileArchive,
  Menu,
  X,
} from 'lucide-react';
import * as fflate from 'fflate';
import PageCurl from './PageCurlComponent';
import { clampCurlPoint, curlProgress, type Pt } from './pageCurl';
import {
  supportsDirPicker,
  pickLibraryDir,
  listArchives,
  getArchiveFile,
  type LibraryDirHandle,
} from './library';

// --- 타입 정의 ---
export interface RawImageFile {
  name: string;
  url: string;
}

export type SliceType = 'left-half' | 'right-half' | 'full';

export interface HalfDescriptor {
  url: string;
  slice: SliceType;
  label: string;
}

export interface SpreadPage {
  title: string;
  left: HalfDescriptor;
  right: HalfDescriptor;
  thumbUrl: string;
}

export type ReadingDirection = 'rtl' | 'ltr';
export type ViewMode = 'spread' | 'split' | 'pair';

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastT: number;
  vx: number;
  scale: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  gy: number;
  moved: boolean;
  lockedSide: 'left' | 'right' | null;
}

interface CurlState {
  side: 'left' | 'right';
  nextIdx: number;
  w: number;
  h: number;
  g: Pt;
  m: Pt;
}

const IMAGE_EXT_REGEX = /\.(jpe?g|png|webp|avif|gif)$/i;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export default function App() {
  // --- 상태 관리 ---
  const [rawFiles, setRawFiles] = useState<RawImageFile[]>([]);
  const [bookTitle, setBookTitle] = useState<string>('FoldBook 뷰어');
  const [viewMode, setViewMode] = useState<ViewMode>('spread');
  const [readingDirection, setReadingDirection] = useState<ReadingDirection>('rtl');
  const [currentIndex, setCurrentIndex] = useState<number>(0);

  const [dirHandle, setDirHandle] = useState<LibraryDirHandle | null>(null);
  const [archives, setArchives] = useState<string[]>([]);
  const [currentArchiveName, setCurrentArchiveName] = useState<string | null>(null);
  const [showDrawer, setShowDrawer] = useState<boolean>(false);

  const [immersive, setImmersive] = useState<boolean>(false);
  const [creaseEnabled, setCreaseEnabled] = useState<boolean>(true);

  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 800, h: 600 });
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);

  const [curl, setCurl] = useState<CurlState | null>(null);

  // Refs
  const chassisRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const animatingRef = useRef<boolean>(false);
  const goNextBookRef = useRef<() => void>(() => {});

  // --- 컨테이너 반응형 리사이즈 감지 ---
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerSize({
          w: entry.contentRect.width,
          h: entry.contentRect.height,
        });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // --- 이미지 해상도 감지 (종횡비 계산용) ---
  useEffect(() => {
    if (rawFiles.length === 0) {
      setImgSize(null);
      return;
    }
    const sampleImg = new Image();
    sampleImg.src = rawFiles[0].url;
    sampleImg.onload = () => {
      setImgSize({ w: sampleImg.naturalWidth, h: sampleImg.naturalHeight });
    };
  }, [rawFiles]);

  // --- 페이지 구성 생성 (useMemo) ---
  const pages = useMemo<SpreadPage[]>(() => {
    if (rawFiles.length === 0) return [];
    const list: SpreadPage[] = [];

    if (viewMode === 'spread') {
      // [양면 폴드북 모드]: 2페이지 1장 이미지를 좌/우로 나누어 펼침면에 배치
      rawFiles.forEach((f, idx) => {
        list.push({
          title: f.name,
          left: { url: f.url, slice: 'left-half', label: String(idx + 1) + 'L' },
          right: { url: f.url, slice: 'right-half', label: String(idx + 1) + 'R' },
          thumbUrl: f.url,
        });
      });
    } else if (viewMode === 'split') {
      // [단면 분할 모드 - 갤럭시 폴드 외부화면]:
      // 2페이지 이미지를 1페이지씩 쪼개어 세로 1장으로 순차 배치
      rawFiles.forEach((f, idx) => {
        // 만화(rtl)는 우측 반쪽(1페이지) 먼저, 좌측 반쪽(2페이지) 나중
        const firstSlice: SliceType = readingDirection === 'rtl' ? 'right-half' : 'left-half';
        const secondSlice: SliceType = readingDirection === 'rtl' ? 'left-half' : 'right-half';

        list.push({
          title: f.name + ' (1/2)',
          left: { url: f.url, slice: firstSlice, label: String(idx + 1) + '-1' },
          right: { url: f.url, slice: firstSlice, label: String(idx + 1) + '-1' },
          thumbUrl: f.url,
        });

        list.push({
          title: f.name + ' (2/2)',
          left: { url: f.url, slice: secondSlice, label: String(idx + 1) + '-2' },
          right: { url: f.url, slice: secondSlice, label: String(idx + 1) + '-2' },
          thumbUrl: f.url,
        });
      });
    } else {
      // [2장 합치기 모드 (pair)]
      for (let i = 0; i < rawFiles.length; i += 2) {
        const f1 = rawFiles[i];
        const f2 = rawFiles[i + 1];
        if (f2) {
          const leftFile = readingDirection === 'rtl' ? f2 : f1;
          const rightFile = readingDirection === 'rtl' ? f1 : f2;
          list.push({
            title: f1.name + ' / ' + f2.name,
            left: { url: leftFile.url, slice: 'full', label: String(i + 1) },
            right: { url: rightFile.url, slice: 'full', label: String(i + 2) },
            thumbUrl: f1.url,
          });
        } else {
          list.push({
            title: f1.name,
            left: { url: f1.url, slice: 'full', label: String(i + 1) },
            right: { url: f1.url, slice: 'full', label: String(i + 1) },
            thumbUrl: f1.url,
          });
        }
      }
    }
    return list;
  }, [rawFiles, viewMode, readingDirection]);

  // 페이지 인덱스 안전 보정
  useEffect(() => {
    if (currentIndex >= pages.length && pages.length > 0) {
      setCurrentIndex(pages.length - 1);
    }
  }, [pages.length, currentIndex]);

  const currentSpread = pages[currentIndex] || null;
  const isSinglePage = viewMode === 'split';

  // --- 슬라이스 스타일 계산 헬퍼 ---
  const getSliceStyle = useCallback((desc?: HalfDescriptor): React.CSSProperties => {
    if (!desc) return {};
    if (desc.slice === 'left-half') {
      return {
        backgroundImage: 'url(' + desc.url + ')',
        backgroundSize: '200% 100%',
        backgroundPosition: '0% center',
      };
    }
    if (desc.slice === 'right-half') {
      return {
        backgroundImage: 'url(' + desc.url + ')',
        backgroundSize: '200% 100%',
        backgroundPosition: '100% center',
      };
    }
    return {
      backgroundImage: 'url(' + desc.url + ')',
      backgroundSize: 'contain',
      backgroundPosition: 'center center',
    };
  }, []);

  // --- 섀시 크기 계산 (화면 꽉 채우기) ---
  const { chassisW, chassisH } = useMemo(() => {
    const baseAspect = imgSize ? imgSize.w / imgSize.h : 1.414;
    // 단면(split)은 세로 단면 비율(baseAspect / 2), 양면은 펼침면 비율
    const bookAspect =
      viewMode === 'pair'
        ? baseAspect * 2
        : viewMode === 'split'
        ? baseAspect / 2
        : baseAspect;

    const availableW = containerSize.w * (immersive ? 1.0 : 0.96);
    const availableH = containerSize.h * (immersive ? 1.0 : 0.94);

    let w = availableW;
    let h = w / bookAspect;

    if (h > availableH) {
      h = availableH;
      w = h * bookAspect;
    }

    return { chassisW: Math.round(w), chassisH: Math.round(h) };
  }, [imgSize, viewMode, containerSize, immersive]);

  // --- 다음 권 불러오기 로직 연결 ---
  const loadArchiveByIndex = useCallback(
    async (nextArchiveName: string) => {
      if (!dirHandle) return;
      try {
        const file = await getArchiveFile(dirHandle, nextArchiveName);
        await loadZipFile(file);
        setCurrentArchiveName(nextArchiveName);
        setCurrentIndex(0);
      } catch (err) {
        console.error('다음 권 로드 실패:', err);
      }
    },
    [dirHandle]
  );

  useEffect(() => {
    goNextBookRef.current = () => {
      if (!currentArchiveName || archives.length === 0) return;
      const currentIdx = archives.indexOf(currentArchiveName);
      if (currentIdx !== -1 && currentIdx + 1 < archives.length) {
        loadArchiveByIndex(archives[currentIdx + 1]);
      }
    };
  }, [currentArchiveName, archives, loadArchiveByIndex]);

  // --- ZIP/CBZ 압축 해제 및 이미지 로드 ---
  const loadZipFile = async (file: File) => {
    setBookTitle(file.name.replace(/\.(zip|cbz)$/i, ''));
    const arrayBuffer = await file.arrayBuffer();
    const unzipped = await new Promise<{ [key: string]: Uint8Array }>((resolve, reject) => {
      fflate.unzip(new Uint8Array(arrayBuffer), (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });

    const fileEntries = Object.keys(unzipped)
      .filter((name) => IMAGE_EXT_REGEX.test(name) && !name.startsWith('__MACOSX'))
      .sort((a, b) => collator.compare(a, b));

    const loadedFiles: RawImageFile[] = fileEntries.map((name) => {
      const bytes = unzipped[name];
      const ext = name.split('.').pop()?.toLowerCase() || 'jpeg';
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      const blob = new Blob([bytes], { type: mime });
      return {
        name,
        url: URL.createObjectURL(blob),
      };
    });

    setRawFiles(loadedFiles);
    setCurrentIndex(0);
  };

  // 일반 이미지 다중 선택 처리
  const handleMultipleImageFiles = (files: FileList | File[]) => {
    const valid = Array.from(files)
      .filter((f) => IMAGE_EXT_REGEX.test(f.name))
      .sort((a, b) => collator.compare(a.name, b.name));

    const loaded: RawImageFile[] = valid.map((f) => ({
      name: f.name,
      url: URL.createObjectURL(f),
    }));

    setBookTitle(valid[0]?.name.split('.')[0] || '단행본');
    setRawFiles(loaded);
    setCurrentIndex(0);
  };

  // 도서관 디렉터리 선택
  const handlePickDirectory = async () => {
    if (!supportsDirPicker()) {
      alert('현재 브라우저에서는 폴더 선택 API를 지원하지 않습니다.');
      return;
    }
    try {
      const handle = await pickLibraryDir();
      setDirHandle(handle);
      const list = await listArchives(handle);
      setArchives(list);
      if (list.length > 0) {
        setShowDrawer(true);
        loadArchiveByIndex(list[0]);
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('폴더 읽기 오류:', err);
      }
    }
  };

  // --- 책장 넘김 완료 애니메이션 (finishCurl) ---
  const finishCurl = useCallback(
    (c: CurlState, complete: boolean) => {
      animatingRef.current = true;

      const startX = c.m.x;
      const startY = c.m.y;
      // 완료 시 제본선 너머로 (-c.w), 취소(snap back) 시 원래 잡은 모서리(c.g)로 부드럽게 복귀
      const targetX = complete ? -c.w : c.g.x;
      const targetY = c.g.y;
      const startTime = performance.now();
      const duration = 200;

      const animate = (now: number) => {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        const ease = 1 - Math.pow(1 - progress, 3);

        const currM: Pt = {
          x: startX + (targetX - startX) * ease,
          y: startY + (targetY - startY) * ease,
        };

        setCurl({ ...c, m: currM });

        if (progress < 1) {
          requestAnimationFrame(animate);
        } else {
          if (complete) {
            setCurrentIndex(c.nextIdx);
          }
          setCurl(null);
          animatingRef.current = false;
        }
      };

      requestAnimationFrame(animate);
    },
    []
  );

  // --- 제스처 이벤트 핸들러 ---
  const handleCurlDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const chassis = chassisRef.current;
    if (curl !== null || animatingRef.current || pages.length <= 1 || !chassis) return;

    const rect = chassis.getBoundingClientRect();
    const scale = rect.width / chassis.offsetWidth || 1;
    const isSingle = viewMode === 'split';

    const w = isSingle ? chassis.offsetWidth : chassis.offsetWidth / 2;
    const h = chassis.offsetHeight;

    const cx = (e.clientX - rect.left) / scale;
    const cy = (e.clientY - rect.top) / scale;

    const edgeY = cy < h / 2 ? 0 : h;
    const gy = Math.max(0, Math.min(h, cy * 0.3 + edgeY * 0.7));

    dragStateRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastT: performance.now(),
      vx: 0,
      scale,
      w,
      h,
      cx,
      cy,
      gy,
      moved: false,
      lockedSide: null,
    };

    chassis.setPointerCapture(e.pointerId);
  };

  const handleCurlMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragStateRef.current;
    if (!d || d.pointerId !== e.pointerId) return;

    const now = performance.now();
    const dt = Math.max(1, now - d.lastT);
    const inst = (e.clientX - d.lastX) / dt;
    d.vx = d.vx * 0.6 + inst * 0.4;
    d.lastX = e.clientX;
    d.lastT = now;

    const dxClient = e.clientX - d.startX;
    const dyClient = e.clientY - d.startY;

    if (Math.abs(dxClient) > 6 || Math.abs(dyClient) > 6) {
      d.moved = true;
    }

    if (!d.moved) return;

    // [중요: 드래그 시작 시 side를 1회 고정하여 애니메이션이 깜빡거리며 튀는 것을 방지]
    if (!d.lockedSide) {
      // 우에서 좌로 쓸기 (dxClient < 0) -> [다음 페이지] 우측 페이지 컬 (side = 'right')
      // 좌에서 우로 쓸기 (dxClient > 0) -> [이전 페이지] 좌측 페이지 컬 (side = 'left')
      d.lockedSide = dxClient < 0 ? 'right' : 'left';
    }

    const side = d.lockedSide;
    // 만화 기준: 우->좌 쓸기(dx < 0) = 다음 페이지(+1), 좌->우 쓸기(dx > 0) = 이전 페이지(-1)
    const delta = side === 'right' ? 1 : -1;
    const nextIdx = currentIndex + delta;

    if (nextIdx < 0 || nextIdx >= pages.length) return;

    const g: Pt = { x: d.w, y: d.gy };

    // 로컬 좌표계:
    // side === 'right': x=d.w가 우측 모서리, x=0이 중앙 제본선. dxClient < 0 일 때 m.x 감소
    // side === 'left': x=d.w가 좌측 모서리, x=0이 중앙 제본선(미러링). dxClient > 0 일 때 m.x 감소
    const dxLocal = (side === 'right' ? dxClient : -dxClient) / d.scale;
    const dyLocal = dyClient / d.scale;

    const mRaw: Pt = { x: d.w + dxLocal, y: d.gy + dyLocal };
    const m = clampCurlPoint(mRaw, g, d.w, d.h);

    setCurl({ side, nextIdx, w: d.w, h: d.h, g, m });
  };

  const handleCurlUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragStateRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    dragStateRef.current = null;

    const isSingle = viewMode === 'split';

    if (!d.moved) {
      // [단순 탭 동작]
      // 만화(rtl): 좌측 탭 = 다음 페이지(+1), 우측 탭 = 이전 페이지(-1)
      // 일반(ltr): 우측 탭 = 다음 페이지(+1), 좌측 탭 = 이전 페이지(-1)
      let delta: number;
      if (isSingle) {
        const isLeftTap = d.cx < d.w / 2;
        delta = readingDirection === 'rtl' ? (isLeftTap ? 1 : -1) : (isLeftTap ? -1 : 1);
      } else {
        const isLeftTap = d.cx < d.w;
        delta = readingDirection === 'rtl' ? (isLeftTap ? 1 : -1) : (isLeftTap ? -1 : 1);
      }

      const nextIdx = currentIndex + delta;
      if (nextIdx >= 0 && nextIdx < pages.length) {
        const tapSide: 'left' | 'right' = delta > 0 ? 'right' : 'left';
        const g: Pt = { x: d.w, y: d.h / 2 };
        const instantCurl: CurlState = { side: tapSide, nextIdx, w: d.w, h: d.h, g, m: g };
        setCurl(instantCurl);
        finishCurl(instantCurl, true);
      }
      return;
    }

    if (!curl) return;

    const dxClient = e.clientX - d.startX;
    const progress = curlProgress(curl.m, d.w);
    // 제본선 방향 속도 (px/ms)
    const towardSpine = curl.side === 'right' ? -d.vx : d.vx;

    // 가볍게 튕기기만 해도 시원하게 넘어가도록 판정 완화
    let complete: boolean;
    if (towardSpine > 0.22) {
      complete = true;
    } else if (towardSpine < -0.25) {
      complete = false;
    } else {
      complete = progress > 0.10 || Math.abs(dxClient) > d.w * 0.18;
    }

    finishCurl(curl, complete);
  };

  const nextSpread = curl ? pages[curl.nextIdx] : null;

  return (
    <div className="flex flex-col w-screen h-screen bg-neutral-950 text-neutral-100 overflow-hidden select-none">
      {/* --- 상단 툴바 --- */}
      {!immersive && (
        <header className="flex items-center justify-between px-4 py-2.5 bg-neutral-900 border-b border-neutral-800 z-30 shrink-0">
          <div className="flex items-center gap-2">
            {archives.length > 0 && (
              <button
                onClick={() => setShowDrawer((v) => !v)}
                className="p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-300"
                title="도서 목록 열기"
              >
                <Menu className="w-5 h-5" />
              </button>
            )}
            <h1 className="text-sm font-semibold truncate max-w-[200px] sm:max-w-xs text-neutral-200">
              {bookTitle}
            </h1>
          </div>

          <div className="flex items-center gap-1.5">
            <label className="cursor-pointer p-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 transition-colors">
              <FolderOpen className="w-4 h-4" />
              <input
                type="file"
                accept=".zip,.cbz,image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = e.target.files;
                  if (!files || files.length === 0) return;
                  if (files.length === 1 && /\.(zip|cbz)$/i.test(files[0].name)) {
                    loadZipFile(files[0]);
                  } else {
                    handleMultipleImageFiles(files);
                  }
                }}
              />
            </label>

            {supportsDirPicker() && (
              <button
                onClick={handlePickDirectory}
                className="p-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 transition-colors"
                title="책 폴더 전체 연결"
              >
                <FileArchive className="w-4 h-4" />
              </button>
            )}

            <div className="w-[1px] h-4 bg-neutral-800 mx-1" />

            <button
              onClick={() =>
                setViewMode((m) => (m === 'spread' ? 'split' : m === 'split' ? 'pair' : 'spread'))
              }
              className="px-2.5 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-xs font-medium text-neutral-200 flex items-center gap-1.5 transition-colors"
              title="보기 모드 전환"
            >
              <Columns className="w-4 h-4" />
              <span className="hidden sm:inline">
                {viewMode === 'spread'
                  ? '양면 폴드북'
                  : viewMode === 'split'
                  ? '단면 꽉참 (Fold 커버)'
                  : '2장 합치기'}
              </span>
            </button>

            <button
              onClick={() => setReadingDirection((d) => (d === 'rtl' ? 'ltr' : 'rtl'))}
              className="px-2.5 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-xs font-medium text-neutral-200 flex items-center gap-1.5 transition-colors"
              title="읽기 방향 전환"
            >
              <ArrowLeftRight className="w-4 h-4" />
              <span className="hidden sm:inline">
                {readingDirection === 'rtl' ? '만화 (우->좌)' : '일반 (좌->우)'}
              </span>
            </button>

            <div className="w-[1px] h-4 bg-neutral-800 mx-1" />

            <button
              onClick={() => setImmersive(true)}
              className="p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200"
              title="전체화면 몰입 모드"
            >
              <Maximize2 className="w-4 h-4" />
            </button>
          </div>
        </header>
      )}

      {/* --- 메인 뷰어 캔버스 영역 --- */}
      <main
        ref={containerRef}
        className="relative flex-1 flex items-center justify-center p-2 sm:p-4 overflow-hidden"
      >
        {pages.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-neutral-500 gap-3">
            <BookOpen className="w-12 h-12 stroke-[1.5]" />
            <p className="text-sm">ZIP, CBZ 파일이나 이미지 폴더를 열어주세요.</p>
          </div>
        ) : (
          <div
            ref={chassisRef}
            style={{
              width: chassisW,
              height: chassisH,
            }}
            className={
              'book-chassis cursor-grab active:cursor-grabbing relative overflow-hidden select-none touch-none ' +
              (immersive ? 'book-chassis-bare' : 'rounded-[10px] shadow-2xl')
            }
            onPointerDown={handleCurlDown}
            onPointerMove={handleCurlMove}
            onPointerUp={handleCurlUp}
            onPointerCancel={handleCurlUp}
          >
            {isSinglePage ? (
              /* [단면 모드 - 폴드 외부 화면 꽉참] */
              <div className="w-full h-full relative overflow-hidden">
                <div
                  className="w-full h-full bg-no-repeat"
                  style={getSliceStyle(curl && nextSpread ? nextSpread.left : currentSpread?.left)}
                />
              </div>
            ) : (
              /* [양면 모드 - 좌/우 2페이지] */
              <>
                <div className="page-half left-0 rounded-l-[10px]">
                  <div
                    className="w-full h-full bg-no-repeat"
                    style={getSliceStyle(
                      curl?.side === 'left' && nextSpread ? nextSpread.left : currentSpread?.left
                    )}
                  />
                </div>
                <div className="page-half right-0 rounded-r-[10px]">
                  <div
                    className="w-full h-full bg-no-repeat"
                    style={getSliceStyle(
                      curl?.side === 'right' && nextSpread ? nextSpread.right : currentSpread?.right
                    )}
                  />
                </div>
              </>
            )}

            {/* 3D 책장 넘김 레이어 */}
            {curl && nextSpread && currentSpread && (
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: isSinglePage ? 0 : curl.side === 'left' ? 0 : curl.w,
                  width: curl.w,
                  height: curl.h,
                  zIndex: 20,
                }}
              >
                <PageCurl
                  side={curl.side}
                  w={curl.w}
                  h={curl.h}
                  g={curl.g}
                  m={curl.m}
                  rounded={!immersive}
                  front={getSliceStyle(
                    isSinglePage
                      ? currentSpread.left
                      : curl.side === 'right'
                      ? currentSpread.right
                      : currentSpread.left
                  )}
                  back={getSliceStyle(
                    isSinglePage
                      ? nextSpread.left
                      : curl.side === 'right'
                      ? nextSpread.left
                      : nextSpread.right
                  )}
                />
              </div>
            )}

            {/* 중앙 제본선 음영은 양면 모드일 때만 표시 */}
            {!isSinglePage && creaseEnabled && <div className="center-crease" />}
          </div>
        )}

        {immersive && (
          <button
            onClick={() => setImmersive(false)}
            className="absolute top-4 right-4 p-2 bg-neutral-900/80 hover:bg-neutral-800 rounded-full text-neutral-300 z-50 backdrop-blur"
            title="기본 모드로 복귀"
          >
            <Minimize2 className="w-5 h-5" />
          </button>
        )}
      </main>

      {/* --- 하단 네비게이션 & 페이지 스크러버 --- */}
      {!immersive && pages.length > 0 && (
        <footer className="flex items-center justify-between px-4 py-2.5 bg-neutral-900 border-t border-neutral-800 z-30 shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCurrentIndex((idx) => Math.max(0, idx - 1))}
              disabled={currentIndex === 0}
              className="p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-300 disabled:opacity-30 disabled:pointer-events-none"
              title="이전 페이지"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={() => setCurrentIndex((idx) => Math.min(pages.length - 1, idx + 1))}
              disabled={currentIndex >= pages.length - 1}
              className="p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-300 disabled:opacity-30 disabled:pointer-events-none"
              title="다음 페이지"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>

          <div className="flex items-center gap-3 flex-1 max-w-md mx-4">
            <input
              type="range"
              min={0}
              max={pages.length - 1}
              value={currentIndex}
              onChange={(e) => setCurrentIndex(Number(e.target.value))}
              className="w-full accent-neutral-300 h-1 bg-neutral-700 rounded-lg cursor-pointer"
            />
            <span className="text-xs text-neutral-400 font-mono whitespace-nowrap min-w-[50px] text-right">
              {String(currentIndex + 1) + ' / ' + String(pages.length)}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={() => setCreaseEnabled((v) => !v)}
              className={
                'px-2 py-1 rounded text-xs transition-colors ' +
                (creaseEnabled ? 'bg-neutral-700 text-neutral-100' : 'text-neutral-400 hover:text-neutral-200')
              }
              title="중앙 제본선 음영 토글"
            >
              제본선
            </button>
          </div>
        </footer>
      )}

      {/* --- 사이드 서랍: 도서 목록 --- */}
      {showDrawer && (
        <div className="fixed inset-0 z-50 flex">
          <div className="fixed inset-0 bg-black/60" onClick={() => setShowDrawer(false)} />
          <div className="relative w-72 bg-neutral-900 h-full p-4 flex flex-col z-10 border-r border-neutral-800">
            <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
              <span className="text-sm font-semibold text-neutral-200">내 도서 목록</span>
              <button
                onClick={() => setShowDrawer(false)}
                className="p-1 rounded hover:bg-neutral-800 text-neutral-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto mt-2 space-y-1">
              {archives.map((name) => (
                <button
                  key={name}
                  onClick={() => {
                    loadArchiveByIndex(name);
                    setShowDrawer(false);
                  }}
                  className={
                    'w-full text-left px-3 py-2 rounded-lg text-xs truncate transition-colors ' +
                    (name === currentArchiveName
                      ? 'bg-neutral-800 text-neutral-100 font-medium'
                      : 'text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200')
                  }
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
