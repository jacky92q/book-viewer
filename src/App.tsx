
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
  Volume2,
  VolumeX,
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

// --- IndexedDB 영구 저장 유틸리티 (앱 종료 후에도 책 파일 유지) ---
const DB_NAME = 'FoldBookStorage';
const DB_VERSION = 1;
const STORE_NAME = 'saved_book';

function openFoldBookDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB not supported'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function persistBookArchive(file: Blob, name: string) {
  try {
    const db = await openFoldBookDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(file, 'current_archive_blob');
    store.put(name, 'current_archive_name');
    store.delete('current_images_list');
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; tx.onabort = rej; });
  } catch (err) {
    console.warn('아카이브 IndexedDB 저장 실패:', err);
  }
}

async function persistImagesList(files: { name: string; blob: Blob }[], bookTitle: string) {
  try {
    const db = await openFoldBookDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(files, 'current_images_list');
    store.put(bookTitle, 'current_archive_name');
    store.delete('current_archive_blob');
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; tx.onabort = rej; });
  } catch (err) {
    console.warn('이미지 목록 IndexedDB 저장 실패:', err);
  }
}

export default function App() {
  // --- 상태 관리 ---
  const [rawFiles, setRawFiles] = useState<RawImageFile[]>([]);
  const [bookTitle, setBookTitle] = useState<string>(() => {
    return localStorage.getItem('foldbook_last_book') || 'FoldBook 뷰어';
  });

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    return (localStorage.getItem('foldbook_view_mode') as ViewMode) || 'spread';
  });

  const [readingDirection, setReadingDirection] = useState<ReadingDirection>(() => {
    return (localStorage.getItem('foldbook_reading_dir') as ReadingDirection) || 'rtl';
  });

  const [currentIndex, setCurrentIndex] = useState<number>(() => {
    const saved = localStorage.getItem('foldbook_last_index');
    return saved ? parseInt(saved, 10) || 0 : 0;
  });

  // 제본선 디폴트 OFF
  const [creaseEnabled, setCreaseEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('foldbook_crease');
    return saved !== null ? saved === 'true' : false;
  });

  // 사운드 토글
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('foldbook_sound');
    return saved !== null ? saved === 'true' : true;
  });

  const [dirHandle, setDirHandle] = useState<LibraryDirHandle | null>(null);
  const [archives, setArchives] = useState<string[]>([]);
  const [currentArchiveName, setCurrentArchiveName] = useState<string | null>(() => {
    return localStorage.getItem('foldbook_last_archive') || null;
  });
  const [showDrawer, setShowDrawer] = useState<boolean>(false);
  const [isLoadingSaved, setIsLoadingSaved] = useState<boolean>(false);

  const [immersive, setImmersive] = useState<boolean>(false);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 800, h: 600 });
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);

  const [curl, setCurl] = useState<CurlState | null>(null);

  // Refs
  const chassisRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const animatingRef = useRef<boolean>(false);
  const goNextBookRef = useRef<() => void>(() => {});
  const audioCtxRef = useRef<AudioContext | null>(null);

  // --- 상태 변경 시 LocalStorage 자동 저장 ---
  useEffect(() => {
    localStorage.setItem('foldbook_view_mode', viewMode);
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem('foldbook_reading_dir', readingDirection);
  }, [readingDirection]);

  useEffect(() => {
    localStorage.setItem('foldbook_crease', String(creaseEnabled));
  }, [creaseEnabled]);

  useEffect(() => {
    localStorage.setItem('foldbook_sound', String(soundEnabled));
  }, [soundEnabled]);

  useEffect(() => {
    if (bookTitle) localStorage.setItem('foldbook_last_book', bookTitle);
    if (currentArchiveName) localStorage.setItem('foldbook_last_archive', currentArchiveName);
    localStorage.setItem('foldbook_last_index', String(currentIndex));
  }, [bookTitle, currentArchiveName, currentIndex]);

  // --- 리얼 책장 넘김 사운드 합성 (Web Audio API) ---
  const playPageSound = useCallback(() => {
    if (!soundEnabled) return;
    try {
      if (!audioCtxRef.current) {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        audioCtxRef.current = new AudioCtx();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume();

      const duration = 0.22;
      const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
      const data = buffer.getChannelData(0);

      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < data.length; i++) {
        const t = i / data.length;
        const white = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + white * 0.0555179;
        b1 = 0.96300 * b1 + white * 0.0750759;
        b2 = 0.57000 * b2 + white * 0.1538520;
        const pink = b0 + b1 + b2 + white * 0.5362;
        const env = Math.sin(t * Math.PI) * Math.pow(1 - t, 0.7);
        data[i] = pink * env * 0.38;
      }

      const noiseNode = ctx.createBufferSource();
      noiseNode.buffer = buffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(1450, ctx.currentTime);
      filter.Q.setValueAtTime(1.1, ctx.currentTime);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.55, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);

      noiseNode.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      noiseNode.start();
    } catch {
      // AudioContext safe catch
    }
  }, [soundEnabled]);

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
      rawFiles.forEach((f, idx) => {
        list.push({
          title: f.name,
          left: { url: f.url, slice: 'left-half', label: String(idx + 1) + 'L' },
          right: { url: f.url, slice: 'right-half', label: String(idx + 1) + 'R' },
          thumbUrl: f.url,
        });
      });
    } else if (viewMode === 'split') {
      rawFiles.forEach((f, idx) => {
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

  // 페이지 인덱스 복구 및 안전 보정
  useEffect(() => {
    if (pages.length > 0) {
      const savedIndex = parseInt(localStorage.getItem('foldbook_last_index') || '0', 10);
      if (savedIndex > 0 && savedIndex < pages.length && currentIndex === 0) {
        setCurrentIndex(savedIndex);
      } else if (currentIndex >= pages.length) {
        setCurrentIndex(pages.length - 1);
      }
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
    async (nextArchiveName: string, shouldPreservePage = false) => {
      if (!dirHandle) return;
      try {
        const file = await getArchiveFile(dirHandle, nextArchiveName);
        await loadZipFile(file, shouldPreservePage);
        setCurrentArchiveName(nextArchiveName);
        if (!shouldPreservePage) setCurrentIndex(0);
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

  // --- ZIP/CBZ 압축 해제 및 이미지 로드 (IndexedDB 영구 저장 연동) ---
  const loadZipFile = async (file: File | Blob, shouldPreservePage = false) => {
    const fileName = 'name' in file ? file.name : (currentArchiveName || '단행본.zip');
    setBookTitle(fileName.replace(/\.(zip|cbz)$/i, ''));
    
    // 영구 저장소(IndexedDB)에 활성 책 보관
    persistBookArchive(file, fileName);

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
    if (!shouldPreservePage) {
      setCurrentIndex(0);
    } else {
      const saved = parseInt(localStorage.getItem('foldbook_last_index') || '0', 10);
      setCurrentIndex(saved > 0 && saved < loadedFiles.length ? saved : 0);
    }
  };

  // 일반 이미지 다중 선택 처리 (IndexedDB 영구 저장 연동)
  const handleMultipleImageFiles = (files: FileList | File[], shouldPreservePage = false) => {
    const valid = Array.from(files)
      .filter((f) => IMAGE_EXT_REGEX.test(f.name))
      .sort((a, b) => collator.compare(a.name, b.name));

    if (valid.length === 0) return;

    const title = valid[0]?.name.split('.')[0] || '단행본';
    setBookTitle(title);

    // IndexedDB에 이미지 블롭 영구 보관
    const persistItems = valid.map((f) => ({ name: f.name, blob: f }));
    persistImagesList(persistItems, title);

    const loaded: RawImageFile[] = valid.map((f) => ({
      name: f.name,
      url: URL.createObjectURL(f),
    }));

    setRawFiles(loaded);
    if (!shouldPreservePage) {
      setCurrentIndex(0);
    } else {
      const saved = parseInt(localStorage.getItem('foldbook_last_index') || '0', 10);
      setCurrentIndex(saved > 0 && saved < loaded.length ? saved : 0);
    }
  };

  // --- 앱 시작 시 이전 독서 세션 자동 복원 (IndexedDB + LocalStorage) ---
  useEffect(() => {
    let isCancelled = false;
    async function restorePreviousReadingSession() {
      setIsLoadingSaved(true);
      try {
        const db = await openFoldBookDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const fileReq = store.get('current_archive_blob');
        const nameReq = store.get('current_archive_name');
        const imagesReq = store.get('current_images_list');

        await new Promise((res) => {
          tx.oncomplete = res;
        });

        if (isCancelled) return;

        if (fileReq.result) {
          const blob = fileReq.result as Blob;
          const fileName = (nameReq.result as string) || '단행본.zip';
          const file = new File([blob], fileName);
          await loadZipFile(file, true);
        } else if (imagesReq.result && Array.isArray(imagesReq.result) && imagesReq.result.length > 0) {
          const imgItems = imagesReq.result as { name: string; blob: Blob }[];
          const title = (nameReq.result as string) || '단행본';
          setBookTitle(title);
          const loaded: RawImageFile[] = imgItems.map((item) => ({
            name: item.name,
            url: URL.createObjectURL(item.blob),
          }));
          setRawFiles(loaded);
          const saved = parseInt(localStorage.getItem('foldbook_last_index') || '0', 10);
          setCurrentIndex(saved > 0 && saved < loaded.length ? saved : 0);
        }
      } catch (err) {
        console.warn('이전 세션 복원 건너뜀:', err);
      } finally {
        if (!isCancelled) setIsLoadingSaved(false);
      }
    }

    restorePreviousReadingSession();
    return () => {
      isCancelled = true;
    };
  }, []);

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
        const lastArch = localStorage.getItem('foldbook_last_archive');
        const target = lastArch && list.includes(lastArch) ? lastArch : list[0];
        loadArchiveByIndex(target, target === lastArch);
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
      if (complete) playPageSound();

      const startX = c.m.x;
      const startY = c.m.y;
      const targetX = complete ? -(c.w * 0.98) : c.g.x;
      const targetY = c.g.y;
      const startTime = performance.now();
      const duration = 220;

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
    [playPageSound]
  );

  // --- 제스처 이벤트 핸들러 (플리커 완벽 차단) ---
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
    const g: Pt = { x: w, y: gy };

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

    if (Math.abs(dxClient) > 5 || Math.abs(dyClient) > 5) {
      d.moved = true;
    }

    if (!d.moved) return;

    // [정확한 방향 감지]:
    // 좌에서 우로 쓸기 (dxClient > 0) -> [다음 페이지(+1)] 좌측 페이지 컬
    // 우에서 좌로 쓸기 (dxClient < 0) -> [이전 페이지(-1)] 우측 페이지 컬
    const isRightSwipe = dxClient > 0;
    const side: 'left' | 'right' = isRightSwipe ? 'left' : 'right';
    const delta = isRightSwipe ? 1 : -1;
    const nextIdx = currentIndex + delta;

    if (nextIdx < 0 || nextIdx >= pages.length) return;

    const g: Pt = { x: d.w, y: d.gy };

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
      // [단순 탭 동작]:
      // 우측 탭 = 다음 페이지 (+1, 좌측 페이지 넘김)
      // 좌측 탭 = 이전 페이지 (-1, 우측 페이지 넘김)
      const isRightTap = isSingle ? d.cx >= d.w / 2 : d.cx >= d.w;
      const delta = isRightTap ? 1 : -1;

      const nextIdx = currentIndex + delta;
      if (nextIdx >= 0 && nextIdx < pages.length) {
        const tapSide: 'left' | 'right' = delta > 0 ? 'left' : 'right';
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

    const towardSpine = curl.side === 'left' ? d.vx : -d.vx;

    let complete: boolean;
    if (towardSpine > 0.18) {
      complete = true;
    } else if (towardSpine < -0.20) {
      complete = false;
    } else {
      complete = progress > 0.10 || Math.abs(dxClient) > d.w * 0.15;
    }

    finishCurl(curl, complete);
  };

  const nextSpread = curl ? pages[curl.nextIdx] : null;

  return (
    <div className="flex flex-col w-screen h-screen bg-neutral-950 text-neutral-100 overflow-hidden select-none">
      {/* --- 상단 툴바 (버튼 및 터치 영역 확대) --- */}
      {!immersive && (
        <header className="flex items-center justify-between px-3 sm:px-5 py-3 bg-neutral-900 border-b border-neutral-800 z-30 shrink-0 min-h-[56px]">
          <div className="flex items-center gap-2.5">
            {archives.length > 0 && (
              <button
                onClick={() => setShowDrawer((v) => !v)}
                className="p-2 rounded-xl hover:bg-neutral-800 text-neutral-300 min-w-[38px] min-h-[38px] flex items-center justify-center transition-colors"
                title="도서 목록 열기"
              >
                <Menu className="w-5 h-5" />
              </button>
            )}
            <h1 className="text-sm sm:text-base font-semibold truncate max-w-[180px] sm:max-w-xs text-neutral-200">
              {bookTitle}
            </h1>
          </div>

          <div className="flex items-center gap-2">
            {/* 파일 / 폴더 불러오기 */}
            <label className="cursor-pointer p-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-200 min-w-[38px] min-h-[38px] flex items-center justify-center transition-colors shadow-sm">
              <FolderOpen className="w-5 h-5" />
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
                  e.target.value = '';
                }}
              />
            </label>

            {supportsDirPicker() && (
              <button
                onClick={handlePickDirectory}
                className="p-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-200 min-w-[38px] min-h-[38px] flex items-center justify-center transition-colors shadow-sm"
                title="책 폴더 전체 연결"
              >
                <FileArchive className="w-5 h-5" />
              </button>
            )}

            <div className="w-[1px] h-5 bg-neutral-800 mx-0.5" />

            {/* 보기 모드 전환 */}
            <button
              onClick={() =>
                setViewMode((m) => (m === 'spread' ? 'split' : m === 'split' ? 'pair' : 'spread'))
              }
              className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-xs sm:text-sm font-medium text-neutral-200 flex items-center gap-1.5 transition-colors shadow-sm min-h-[38px]"
              title="보기 모드 전환"
            >
              <Columns className="w-4 h-4 sm:w-5 sm:h-5 text-indigo-400" />
              <span className="hidden sm:inline">
                {viewMode === 'spread'
                  ? '양면 폴드북'
                  : viewMode === 'split'
                  ? '단면 꽉참 (Fold 커버)'
                  : '2장 합치기'}
              </span>
            </button>

            {/* 읽기 방향 전환 */}
            <button
              onClick={() => setReadingDirection((d) => (d === 'rtl' ? 'ltr' : 'rtl'))}
              className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-xs sm:text-sm font-medium text-neutral-200 flex items-center gap-1.5 transition-colors shadow-sm min-h-[38px]"
              title="읽기 방향 전환"
            >
              <ArrowLeftRight className="w-4 h-4 sm:w-5 sm:h-5 text-amber-400" />
              <span className="hidden sm:inline">
                {readingDirection === 'rtl' ? '만화 (우->좌)' : '일반 (좌->우)'}
              </span>
            </button>

            {/* 사운드 ON/OFF 버튼 */}
            <button
              onClick={() => setSoundEnabled((v) => !v)}
              className="p-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-200 min-w-[38px] min-h-[38px] flex items-center justify-center transition-colors shadow-sm"
              title={soundEnabled ? '효과음 끄기' : '효과음 켜기'}
            >
              {soundEnabled ? (
                <Volume2 className="w-5 h-5 text-emerald-400" />
              ) : (
                <VolumeX className="w-5 h-5 text-neutral-400" />
              )}
            </button>

            <div className="w-[1px] h-5 bg-neutral-800 mx-0.5" />

            {/* 몰입 모드 (전체화면) */}
            <button
              onClick={() => setImmersive(true)}
              className="p-2 rounded-xl hover:bg-neutral-800 text-neutral-300 min-w-[38px] min-h-[38px] flex items-center justify-center transition-colors"
              title="전체화면 몰입 모드"
            >
              <Maximize2 className="w-5 h-5" />
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
            <BookOpen className="w-14 h-14 stroke-[1.5] text-indigo-400/80" />
            <p className="text-sm sm:text-base font-medium">
              {isLoadingSaved ? '이전 독서 기록을 불러오는 중...' : 'ZIP, CBZ 파일이나 이미지 폴더를 열어주세요.'}
            </p>
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
                className="pointer-events-none z-20"
                style={
                  isSinglePage && curl.side === 'right'
                    ? {
                        position: 'absolute',
                        top: 0,
                        left: '-100%',
                        width: '200%',
                        height: '100%',
                      }
                    : {
                        position: 'absolute',
                        inset: 0,
                      }
                }
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

            {/* 중앙 제본선 음영은 양면 모드 + creaseEnabled 일 때만 표시 (디폴트 OFF) */}
            {!isSinglePage && creaseEnabled && <div className="center-crease" />}
          </div>
        )}

        {immersive && (
          <button
            onClick={() => setImmersive(false)}
            className="absolute top-4 right-4 p-2.5 bg-neutral-900/80 hover:bg-neutral-800 rounded-full text-neutral-300 z-50 backdrop-blur shadow-lg"
            title="기본 모드로 복귀"
          >
            <Minimize2 className="w-5 h-5" />
          </button>
        )}
      </main>

      {/* --- 하단 네비게이션 & 페이지 스크러버 --- */}
      {!immersive && pages.length > 0 && (
        <footer className="flex items-center justify-between px-3 sm:px-5 py-2.5 bg-neutral-900 border-t border-neutral-800 z-30 shrink-0 min-h-[52px]">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCurrentIndex((idx) => Math.max(0, idx - 1))}
              disabled={currentIndex === 0}
              className="p-2 rounded-xl hover:bg-neutral-800 text-neutral-300 disabled:opacity-30 disabled:pointer-events-none min-w-[38px] min-h-[38px] flex items-center justify-center transition-colors"
              title="이전 페이지"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={() => setCurrentIndex((idx) => Math.min(pages.length - 1, idx + 1))}
              disabled={currentIndex >= pages.length - 1}
              className="p-2 rounded-xl hover:bg-neutral-800 text-neutral-300 disabled:opacity-30 disabled:pointer-events-none min-w-[38px] min-h-[38px] flex items-center justify-center transition-colors"
              title="다음 페이지"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>

          <div className="flex items-center gap-3 flex-1 max-w-md mx-3">
            <input
              type="range"
              min={0}
              max={pages.length - 1}
              value={currentIndex}
              onChange={(e) => setCurrentIndex(Number(e.target.value))}
              className="w-full accent-indigo-400 h-1.5 bg-neutral-700 rounded-lg cursor-pointer"
            />
            <span className="text-xs sm:text-sm text-neutral-400 font-mono whitespace-nowrap min-w-[55px] text-right">
              {String(currentIndex + 1) + ' / ' + String(pages.length)}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setCreaseEnabled((v) => !v)}
              className={
                'px-3 py-1.5 rounded-xl text-xs sm:text-sm font-medium transition-colors shadow-sm ' +
                (creaseEnabled ? 'bg-indigo-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200 border border-neutral-700')
              }
              title="중앙 제본선 음영 토글"
            >
              제본선 {creaseEnabled ? 'ON' : 'OFF'}
            </button>
          </div>
        </footer>
      )}

      {/* --- 사이드 서랍: 도서 목록 --- */}
      {showDrawer && (
        <div className="fixed inset-0 z-50 flex">
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowDrawer(false)} />
          <div className="relative w-72 bg-neutral-900 h-full p-4 flex flex-col z-10 border-r border-neutral-800 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-neutral-800">
              <span className="text-sm font-bold text-neutral-200">내 도서 목록</span>
              <button
                onClick={() => setShowDrawer(false)}
                className="p-1.5 rounded-lg hover:bg-neutral-800 text-neutral-400"
              >
                <X className="w-5 h-5" />
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
                    'w-full text-left px-3 py-2.5 rounded-xl text-xs sm:text-sm truncate transition-colors ' +
                    (name === currentArchiveName
                      ? 'bg-indigo-600/30 text-indigo-200 font-semibold border border-indigo-500/30'
                      : 'text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200')
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
