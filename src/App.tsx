
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
  w?: number;
  h?: number;
  aspect?: number;
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
  aspect: number;
  isSingle?: boolean;
  rawIndex: number;
  sliceIndex?: number;
}

export type ReadingDirection = 'rtl' | 'ltr';
export type ViewMode = 'spread' | 'split' | 'pair';
export type TapAction = 'page' | 'menu';

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
  atEndNext?: boolean;
}

interface CurlState {
  side: 'left' | 'right';
  nextIdx: number;
  w: number;
  h: number;
  g: Pt;
  m: Pt;
}

// --- 이미지 바이너리 헤더 파서 (PNG, JPEG, WebP, GIF 실시간 규격 감지) ---
function parseImageSize(bytes: Uint8Array): { w: number; h: number } | null {
  if (!bytes || bytes.length < 24) return null;
  // PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { w: view.getUint32(16), h: view.getUint32(20) };
  }
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1];
      offset += 2;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const h = view.getUint16(offset + 3);
        const w = view.getUint16(offset + 5);
        return { w, h };
      }
      if (offset + 2 > bytes.length) break;
      const len = view.getUint16(offset);
      offset += len;
    }
  }
  // GIF
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { w: view.getUint16(6, true), h: view.getUint16(8, true) };
  }
  // WebP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x20) {
      return { w: bytes[26] | (bytes[27] << 8), h: bytes[28] | (bytes[29] << 8) };
    }
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x4c) {
      const b1 = bytes[21], b2 = bytes[22], b3 = bytes[23];
      const w = 1 + (((b2 & 0x3f) << 8) | b1);
      const h = 1 + (((bytes[24] & 0xf) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
      return { w, h };
    }
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58) {
      const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { w, h };
    }
  }
  return null;
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

// --- 이미지 종횡비 기반 가변 스마트 스프레드 생성 함수 (모드 전환 시 위치 보존용) ---
function buildSpreadsList(
  rawFiles: RawImageFile[],
  viewMode: ViewMode,
  readingDirection: ReadingDirection
): SpreadPage[] {
  if (rawFiles.length === 0) return [];
  const list: SpreadPage[] = [];
  const isSpreadImage = (f: RawImageFile) => (f.aspect ? f.aspect >= 1.05 : false);

  if (viewMode === 'split') {
    rawFiles.forEach((f, idx) => {
      if (isSpreadImage(f)) {
        const firstSlice: SliceType = readingDirection === 'rtl' ? 'right-half' : 'left-half';
        const secondSlice: SliceType = readingDirection === 'rtl' ? 'left-half' : 'right-half';

        list.push({
          title: f.name + ' (1/2)',
          left: { url: f.url, slice: firstSlice, label: String(idx + 1) + '-1' },
          right: { url: f.url, slice: firstSlice, label: String(idx + 1) + '-1' },
          thumbUrl: f.url,
          aspect: (f.aspect || 1.4) / 2,
          isSingle: true,
          rawIndex: idx,
          sliceIndex: 0,
        });

        list.push({
          title: f.name + ' (2/2)',
          left: { url: f.url, slice: secondSlice, label: String(idx + 1) + '-2' },
          right: { url: f.url, slice: secondSlice, label: String(idx + 1) + '-2' },
          thumbUrl: f.url,
          aspect: (f.aspect || 1.4) / 2,
          isSingle: true,
          rawIndex: idx,
          sliceIndex: 1,
        });
      } else {
        list.push({
          title: f.name,
          left: { url: f.url, slice: 'full', label: String(idx + 1) },
          right: { url: f.url, slice: 'full', label: String(idx + 1) },
          thumbUrl: f.url,
          aspect: f.aspect || 0.7,
          isSingle: true,
          rawIndex: idx,
          sliceIndex: 0,
        });
      }
    });
  } else {
    let i = 0;
    while (i < rawFiles.length) {
      const f = rawFiles[i];
      if (isSpreadImage(f)) {
        list.push({
          title: f.name,
          left: { url: f.url, slice: 'left-half', label: String(i + 1) + 'L' },
          right: { url: f.url, slice: 'right-half', label: String(i + 1) + 'R' },
          thumbUrl: f.url,
          aspect: f.aspect || 1.414,
          isSingle: false,
          rawIndex: i,
          sliceIndex: 0,
        });
        i++;
      } else {
        const next = rawFiles[i + 1];
        if (i === 0 || !next || isSpreadImage(next)) {
          list.push({
            title: f.name,
            left: { url: f.url, slice: 'full', label: String(i + 1) },
            right: { url: f.url, slice: 'full', label: String(i + 1) },
            thumbUrl: f.url,
            aspect: f.aspect || 0.7,
            isSingle: true,
            rawIndex: i,
            sliceIndex: 0,
          });
          i++;
        } else {
          const f1 = f;
          const f2 = next;
          const leftFile = readingDirection === 'rtl' ? f2 : f1;
          const rightFile = readingDirection === 'rtl' ? f1 : f2;
          list.push({
            title: f1.name + ' + ' + f2.name,
            left: { url: leftFile.url, slice: 'full', label: leftFile.name },
            right: { url: rightFile.url, slice: 'full', label: rightFile.name },
            thumbUrl: f1.url,
            aspect: ((f1.aspect || 0.7) + (f2.aspect || 0.7)),
            isSingle: false,
            rawIndex: i,
            sliceIndex: 0,
          });
          i += 2;
        }
      }
    }
  }

  return list;
}

export default function App() {
  // --- 상태 관리 ---
  const [rawFiles, setRawFiles] = useState<RawImageFile[]>([]);
  // --- 책별(권별) 독서 진행도 영구 보관 (LocalStorage) ---
  const saveBookProgress = useCallback((bookKey: string, rawIdx: number, pageIdx: number) => {
    if (!bookKey || bookKey === 'FoldBook 뷰어') return;
    try {
      const data = JSON.parse(localStorage.getItem('foldbook_books_progress') || '{}');
      data[bookKey] = { rawIndex: rawIdx, pageIndex: pageIdx };
      localStorage.setItem('foldbook_books_progress', JSON.stringify(data));
    } catch {}
  }, []);

  const getBookProgress = useCallback((bookKey: string): { rawIndex: number; pageIndex: number } | null => {
    try {
      const data = JSON.parse(localStorage.getItem('foldbook_books_progress') || '{}');
      return data[bookKey] || null;
    } catch {
      return null;
    }
  }, []);

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

  // 책 전환 시 저장된 독서 위치 적용 (없으면 0번째 첫 페이지)
  const applyBookProgress = useCallback((bookKey: string, spreads: SpreadPage[]) => {
    if (spreads.length === 0) {
      setCurrentIndex(0);
      return;
    }
    const saved = getBookProgress(bookKey);
    if (saved) {
      let matchIdx = spreads.findIndex((s) => s.rawIndex === saved.rawIndex);
      if (matchIdx === -1) {
        matchIdx = Math.min(saved.pageIndex, Math.max(0, spreads.length - 1));
      }
      setCurrentIndex(matchIdx);
    } else {
      setCurrentIndex(0);
    }
  }, [getBookProgress]);


  const pages = useMemo<SpreadPage[]>(() => {
    return buildSpreadsList(rawFiles, viewMode, readingDirection);
  }, [rawFiles, viewMode, readingDirection]);

  // 페이지 인덱스 안전 범위 보정 (인덱스 초과 방지)
  useEffect(() => {
    if (pages.length > 0 && currentIndex >= pages.length) {
      setCurrentIndex(pages.length - 1);
    }
  }, [pages.length, currentIndex]);


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

  // 화면 단순 탭 동작 (페이지 넘김 vs 전체화면 메뉴 토글)
  const [tapAction, setTapAction] = useState<TapAction>(() => {
    return (localStorage.getItem('foldbook_tap_action') as TapAction) || 'page';
  });
  const [showImmersiveControls, setShowImmersiveControls] = useState<boolean>(false);

  const [dirHandle, setDirHandle] = useState<LibraryDirHandle | null>(null);
  const zipFilesMapRef = useRef<Map<string, File>>(new Map());
  const subDirsMapRef = useRef<Map<string, File[]>>(new Map());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [archives, setArchives] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('foldbook_archive_list');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
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
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const singleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mainLastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);

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
    localStorage.setItem('foldbook_tap_action', tapAction);
  }, [tapAction]);

  useEffect(() => {
    if (bookTitle) localStorage.setItem('foldbook_last_book', bookTitle);
    if (currentArchiveName) localStorage.setItem('foldbook_last_archive', currentArchiveName);
    localStorage.setItem('foldbook_last_index', String(currentIndex));
    const bookKey = currentArchiveName || (bookTitle !== 'FoldBook 뷰어' ? bookTitle : null);
    if (bookKey && pages.length > 0 && pages[currentIndex]) {
      saveBookProgress(bookKey, pages[currentIndex].rawIndex, currentIndex);
    }
  }, [bookTitle, currentArchiveName, currentIndex, pages, saveBookProgress]);

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

  // --- 보기 모드 전환 핸들러 (분할 <-> 양면 전환 시 현재 읽던 페이지 위치 정밀 유지) ---
  const handleToggleViewMode = useCallback(() => {
    if (pages.length === 0) {
      setViewMode((m) => (m === 'spread' ? 'split' : 'spread'));
      return;
    }
    const current = pages[currentIndex];
    const currentRawIdx = current?.rawIndex ?? 0;
    const currentSliceIdx = current?.sliceIndex ?? 0;

    const nextMode: ViewMode = viewMode === 'spread' ? 'split' : 'spread';
    const targetSpreads = buildSpreadsList(rawFiles, nextMode, readingDirection);

    let matchIdx = targetSpreads.findIndex((s) => {
      if (nextMode === 'split') {
        return s.rawIndex === currentRawIdx && (s.sliceIndex ?? 0) === currentSliceIdx;
      }
      return s.rawIndex === currentRawIdx;
    });

    if (matchIdx === -1) {
      matchIdx = targetSpreads.findIndex((s) => s.rawIndex >= currentRawIdx);
      if (matchIdx === -1) matchIdx = Math.max(0, targetSpreads.length - 1);
    }

    setViewMode(nextMode);
    setCurrentIndex(matchIdx);
  }, [pages, currentIndex, viewMode, rawFiles, readingDirection]);

  // --- 브라우저 OS 알림바 숨김 & 전체화면 토글 (HTML5 Fullscreen API) ---
  const toggleFullscreen = useCallback(async () => {
    if (!document.fullscreenElement) {
      try {
        if (document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
        }
      } catch (e) {
        console.warn('전체화면 요청 실패:', e);
      }
      setImmersive(true);
    } else {
      try {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        }
      } catch (e) {
        console.warn('전체화면 해제 실패:', e);
      }
      setImmersive(false);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const handleFsChange = () => {
      setImmersive(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    document.addEventListener('webkitfullscreenchange', handleFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange);
      document.removeEventListener('webkitfullscreenchange', handleFsChange);
    };
  }, []);

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

  // --- 현재 페이지(스프레드) 종횡비에 실시간 맞춤 가변 섀시 크기 계산 ---
  const currentSpread = pages[currentIndex];
  const isDisplaySingle = viewMode === 'split' || !!currentSpread?.isSingle;

  const { chassisW, chassisH } = useMemo(() => {
    // 현재 보고 있는 페이지 고유 종횡비 사용 (단면 표지면 세로형, 2페이지면 가로형 자동 가변)
    const targetAspect = currentSpread?.aspect || (viewMode === 'split' ? 0.7 : 1.414);

    const availableW = containerSize.w * (immersive ? 1.0 : 0.96);
    const availableH = containerSize.h * (immersive ? 1.0 : 0.94);

    let w = availableW;
    let h = w / targetAspect;

    if (h > availableH) {
      h = availableH;
      w = h * targetAspect;
    }

    return { chassisW: Math.round(w), chassisH: Math.round(h) };
  }, [currentSpread, viewMode, containerSize, immersive]);

  // --- 다음 권 존재 여부 확인 ---
  const hasNextBook = useMemo(() => {
    if (!currentArchiveName || archives.length === 0) return false;
    const currentIdx = archives.indexOf(currentArchiveName);
    return currentIdx !== -1 && currentIdx + 1 < archives.length;
  }, [currentArchiveName, archives]);

  // --- ZIP/CBZ 압축 해제 및 이미지 로드 (IndexedDB 영구 저장 연동) ---
  const loadZipFile = async (file: File | Blob, customTitle?: string) => {
    const fileName = customTitle || ('name' in file ? file.name : (currentArchiveName || '단행본.zip'));
    const title = fileName.replace(/\.(zip|cbz)$/i, '');
    setBookTitle(title);
    setCurrentArchiveName(fileName);
    localStorage.setItem('foldbook_last_archive', fileName);
    
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
      const size = parseImageSize(bytes);
      const w = size?.w || 1000;
      const h = size?.h || 700;
      return {
        name,
        url: URL.createObjectURL(blob),
        w,
        h,
        aspect: w / h,
      };
    });

    // 이전 URL 해제
    rawFiles.forEach((f) => URL.revokeObjectURL(f.url));
    setRawFiles(loadedFiles);

    // 책별 보관된 마지막 독서 위치 조회 및 복원 (본 적 없으면 0번째 첫 페이지)
    const targetSpreads = buildSpreadsList(loadedFiles, viewMode, readingDirection);
    applyBookProgress(fileName, targetSpreads);
  };

  // 일반 이미지 다중/폴더 선택 처리 (IndexedDB 영구 저장 및 폴더명 추출)
  const handleMultipleImageFiles = async (
    files: FileList | File[],
    customTitle?: string
  ) => {
    const valid = Array.from(files)
      .filter((f) => IMAGE_EXT_REGEX.test(f.name))
      .sort((a, b) => {
        const pathA = (a as any).webkitRelativePath || a.name;
        const pathB = (b as any).webkitRelativePath || b.name;
        return collator.compare(pathA, pathB);
      });

    if (valid.length === 0) return;

    const relPath = (valid[0] as any).webkitRelativePath as string | undefined;
    const folderName = relPath && relPath.includes('/') ? relPath.split('/')[0] : undefined;
    const title = customTitle || folderName || valid[0]?.name.split('.')[0] || '만화책 폴더';
    setBookTitle(title);
    setCurrentArchiveName(title);
    localStorage.setItem('foldbook_last_archive', title);

    // 이전 URL 해제
    rawFiles.forEach((f) => URL.revokeObjectURL(f.url));

    // IndexedDB에 이미지 블롭 영구 보관 (에러 시 무시)
    try {
      const persistItems = valid.map((f) => ({ name: f.name, blob: f }));
      persistImagesList(persistItems, title);
    } catch {}

    const loaded: RawImageFile[] = await Promise.all(
      valid.map(async (f) => {
        let w = 1000, h = 700;
        try {
          const headerBytes = new Uint8Array(await f.slice(0, 65536).arrayBuffer());
          const size = parseImageSize(headerBytes);
          if (size) { w = size.w; h = size.h; }
        } catch {}
        return {
          name: f.name,
          url: URL.createObjectURL(f),
          w,
          h,
          aspect: w / h,
        };
      })
    );

    setRawFiles(loaded);

    // 폴더/이미지 책별 보관된 마지막 독서 위치 복원 (본 적 없으면 0번째 첫 페이지)
    const targetSpreads = buildSpreadsList(loaded, viewMode, readingDirection);
    applyBookProgress(title, targetSpreads);
  };

  // --- 다음 권 불러오기 로직 연결 (폴더 핸들 및 다중 ZIP 메모리 맵 모두 지원) ---
  const loadArchiveByIndex = useCallback(
    async (nextArchiveName: string) => {
      try {
        if (subDirsMapRef.current.has(nextArchiveName)) {
          const imgs = subDirsMapRef.current.get(nextArchiveName)!;
          await handleMultipleImageFiles(imgs, nextArchiveName);
          return;
        }

        let file: File | Blob | null = null;
        if (zipFilesMapRef.current.has(nextArchiveName)) {
          file = zipFilesMapRef.current.get(nextArchiveName)!;
        } else if (dirHandle) {
          file = await getArchiveFile(dirHandle, nextArchiveName);
        }
        if (file) {
          await loadZipFile(file, nextArchiveName);
        }
      } catch (err) {
        console.error('다음 권 로드 실패:', err);
      }
    },
    [dirHandle, applyBookProgress, viewMode, readingDirection]
  );

  useEffect(() => {
    goNextBookRef.current = () => {
      if (!currentArchiveName || archives.length === 0) return;
      const currentIdx = archives.indexOf(currentArchiveName);
      if (currentIdx !== -1 && currentIdx + 1 < archives.length) {
        const nextName = archives[currentIdx + 1];
        loadArchiveByIndex(nextName);
      }
    };
  }, [currentArchiveName, archives, loadArchiveByIndex]);

  // --- 이미지들이 담긴 폴더 선택 이벤트 핸들러 (웹킷 디렉터리 완벽 지원) ---
  const handleFolderChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const fileList = Array.from(files);

    // 1. 폴더 안에 ZIP/CBZ 압축 파일들이 담겨 있는 경우
    const zips = fileList
      .filter((f) => /\.(zip|cbz)$/i.test(f.name))
      .sort((a, b) => collator.compare(a.name, b.name));

    if (zips.length > 0) {
      const map = new Map<string, File>();
      zips.forEach((f) => map.set(f.name, f));
      zipFilesMapRef.current = map;
      const names = zips.map((f) => f.name);
      setArchives(names);
      localStorage.setItem('foldbook_archive_list', JSON.stringify(names));
      loadZipFile(zips[0]);
      setCurrentArchiveName(zips[0].name);
      localStorage.setItem('foldbook_last_archive', zips[0].name);
      if (zips.length > 1) setShowDrawer(true);
      e.target.value = '';
      return;
    }

    // 2. 폴더 안에 이미지 파일들이 담겨 있는 경우
    const images = fileList.filter((f) => IMAGE_EXT_REGEX.test(f.name));
    if (images.length === 0) {
      alert('선택한 폴더 안에 이미지 파일(JPG, PNG, WEBP 등)이나 ZIP 파일이 없습니다.');
      e.target.value = '';
      return;
    }

    // 하위 폴더별(1권, 2권 등) 분기 감지
    const subDirMap = new Map<string, File[]>();
    for (const f of images) {
      const rel = (f as any).webkitRelativePath as string | undefined;
      if (rel && rel.includes('/')) {
        const parts = rel.split('/');
        if (parts.length >= 3) {
          const subName = parts[1];
          if (!subDirMap.has(subName)) subDirMap.set(subName, []);
          subDirMap.get(subName)!.push(f);
        }
      }
    }

    if (subDirMap.size > 1) {
      // 여러 권의 하위 폴더가 감지된 경우: 도서 목록에 추가
      const subNames = Array.from(subDirMap.keys()).sort((a, b) => collator.compare(a, b));
      subDirsMapRef.current = subDirMap;
      setArchives(subNames);
      localStorage.setItem('foldbook_archive_list', JSON.stringify(subNames));
      const firstSub = subNames[0];
      const firstImgs = subDirMap.get(firstSub)!;
      await handleMultipleImageFiles(firstImgs, firstSub);
      setCurrentArchiveName(firstSub);
      localStorage.setItem('foldbook_last_archive', firstSub);
      setShowDrawer(true);
    } else {
      // 단일 이미지 폴더인 경우: 전체 이미지 즉시 로드
      const folderName = (images[0] as any).webkitRelativePath
        ? (images[0] as any).webkitRelativePath.split('/')[0]
        : '만화책 폴더';
      await handleMultipleImageFiles(images, folderName);
    }

    e.target.value = '';
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
          await loadZipFile(file, fileName);
        } else if (imagesReq.result && Array.isArray(imagesReq.result) && imagesReq.result.length > 0) {
          const imgItems = imagesReq.result as { name: string; blob: Blob }[];
          const title = (nameReq.result as string) || '단행본';
          setBookTitle(title);
          const loaded: RawImageFile[] = imgItems.map((item) => ({
            name: item.name,
            url: URL.createObjectURL(item.blob),
          }));
          setRawFiles(loaded);
          const targetSpreads = buildSpreadsList(loaded, viewMode, readingDirection);
          applyBookProgress(title, targetSpreads);
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
      localStorage.setItem('foldbook_archive_list', JSON.stringify(list));
      if (list.length > 0) {
        setShowDrawer(true);
        const lastArch = localStorage.getItem('foldbook_last_archive');
        const target = lastArch && list.includes(lastArch) ? lastArch : list[0];
        loadArchiveByIndex(target);
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

    // 모바일에서 홈 다녀왔을 때 터치 한 번으로 OS 전체화면 복구
    if (immersive && !document.fullscreenElement) {
      try {
        if (document.documentElement.requestFullscreen) {
          document.documentElement.requestFullscreen();
        }
      } catch {}
    }

    const rect = chassis.getBoundingClientRect();
    const scale = rect.width / chassis.offsetWidth || 1;
    const isSingle = isDisplaySingle;

    const w = isSingle ? chassis.offsetWidth : chassis.offsetWidth / 2;
    const h = chassis.offsetHeight;

    const cx = (e.clientX - rect.left) / scale;
    const cy = (e.clientY - rect.top) / scale;

    const edgeY = cy < h / 2 ? 0 : h;
    const gy = Math.max(0, Math.min(h, cy * 0.3 + edgeY * 0.7));
    const g: Pt = { x: w, y: gy };

    if (showImmersiveControls) setShowImmersiveControls(false);
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
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
        singleTapTimerRef.current = null;
      }
      lastTapRef.current = null;
    }

    if (!d.moved) return;

    // [정확한 방향 감지]:
    // 좌에서 우로 쓸기 (dxClient > 0) -> [다음 페이지(+1)] 좌측 페이지 컬
    // 우에서 좌로 쓸기 (dxClient < 0) -> [이전 페이지(-1)] 우측 페이지 컬
    const isRightSwipe = dxClient > 0;
    const side: 'left' | 'right' = isRightSwipe ? 'left' : 'right';
    const delta = isRightSwipe ? 1 : -1;
    const nextIdx = currentIndex + delta;

    if (nextIdx < 0) return;
    if (nextIdx >= pages.length) {
      if (hasNextBook && (readingDirection === 'rtl' ? dxClient > 0 : dxClient < 0)) {
        d.atEndNext = true;
      }
      return;
    }

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

    const isSingle = isDisplaySingle;

    if (!d.moved) {
      const now = performance.now();
      const last = lastTapRef.current;
      const clientX = e.clientX;
      const clientY = e.clientY;

      // [더블 탭 감지]: 280ms 이내에 45px 반경 안을 두 번 탭한 경우 전체화면 토글
      if (last && now - last.time < 280 && Math.hypot(clientX - last.x, clientY - last.y) < 45) {
        if (singleTapTimerRef.current) {
          clearTimeout(singleTapTimerRef.current);
          singleTapTimerRef.current = null;
        }
        lastTapRef.current = null;
        toggleFullscreen();
        return;
      }

      lastTapRef.current = { time: now, x: clientX, y: clientY };

      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
      }

      singleTapTimerRef.current = setTimeout(() => {
        singleTapTimerRef.current = null;
        lastTapRef.current = null;

        // [단순 싱글 탭 - 메뉴 토글 모드]
        if (tapAction === 'menu') {
          if (immersive) {
            setShowImmersiveControls((v) => !v);
          }
          return;
        }

        // [단순 싱글 탭 - 페이지 넘김 모드 (디폴트)]
        const isRightTap = isSingle ? d.cx >= d.w / 2 : d.cx >= d.w;
        const delta = isRightTap ? 1 : -1;

        const nextIdx = currentIndex + delta;
        if (nextIdx >= pages.length && hasNextBook && (readingDirection === 'rtl' ? isRightTap : !isRightTap)) {
          goNextBookRef.current();
          playPageSound();
          return;
        }

        if (nextIdx >= 0 && nextIdx < pages.length) {
          const tapSide: 'left' | 'right' = delta > 0 ? 'left' : 'right';
          const g: Pt = { x: d.w, y: d.h / 2 };
          const instantCurl: CurlState = { side: tapSide, nextIdx, w: d.w, h: d.h, g, m: g };
          setCurl(instantCurl);
          finishCurl(instantCurl, true);
        }
      }, 240);

      return;
    }

    if (d.atEndNext) {
      const dxClient = e.clientX - d.startX;
      const isCompleteSwipe = readingDirection === 'rtl'
        ? (d.vx > 0.15 || dxClient > d.w * 0.12)
        : (d.vx < -0.15 || dxClient < -d.w * 0.12);
      if (isCompleteSwipe) {
        goNextBookRef.current();
        playPageSound();
        return;
      }
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

  const handleMainPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    if (e.target !== containerRef.current) return;
    const now = performance.now();
    const last = mainLastTapRef.current;
    if (last && now - last.time < 280 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 45) {
      mainLastTapRef.current = null;
      toggleFullscreen();
    } else {
      mainLastTapRef.current = { time: now, x: e.clientX, y: e.clientY };
    }
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
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-950/70 hover:bg-indigo-900 border border-indigo-500/40 text-indigo-200 text-xs sm:text-sm font-semibold transition-colors shadow-sm min-h-[38px]"
                title="도서 목록 열기"
              >
                <BookOpen className="w-4 h-4 text-indigo-400 shrink-0" />
                <span className="truncate max-w-[90px] sm:max-w-none">
                  도서 목록 ({archives.length})
                </span>
              </button>
            )}
            <h1 className="text-sm sm:text-base font-semibold truncate max-w-[130px] sm:max-w-xs text-neutral-200">
              {bookTitle}
            </h1>
          </div>

          <div className="flex items-center gap-2">

            {/* 1. 파일 열기 (ZIP, CBZ 또는 이미지들) */}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="p-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-200 min-w-[38px] min-h-[38px] flex items-center justify-center transition-colors shadow-sm"
              title="파일 열기 (ZIP, CBZ 압축 파일 또는 이미지 여러 장)"
            >
              <FileArchive className="w-5 h-5 text-indigo-400" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,.cbz,image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = e.target.files;
                if (!files || files.length === 0) return;
                const fileList = Array.from(files);
                const zips = fileList
                  .filter((f) => /\.(zip|cbz)$/i.test(f.name))
                  .sort((a, b) => collator.compare(a.name, b.name));

                if (zips.length > 0) {
                  const map = new Map<string, File>();
                  zips.forEach((f) => map.set(f.name, f));
                  zipFilesMapRef.current = map;
                  const names = zips.map((f) => f.name);
                  setArchives(names);
                  localStorage.setItem('foldbook_archive_list', JSON.stringify(names));
                  loadZipFile(zips[0]);
                  setCurrentArchiveName(zips[0].name);
                  localStorage.setItem('foldbook_last_archive', zips[0].name);
                  if (zips.length > 1) {
                    setShowDrawer(true);
                  }
                } else {
                  handleMultipleImageFiles(fileList);
                }
                e.target.value = '';
              }}
            />

            {/* 2. 폴더 열기 (이미지 폴더 통째로 로드) */}
            <button
              onClick={() => {
                if (supportsDirPicker()) {
                  handlePickDirectory();
                } else {
                  folderInputRef.current?.click();
                }
              }}
              className="p-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-200 min-w-[38px] min-h-[38px] flex items-center justify-center transition-colors shadow-sm"
              title="이미지/만화책 폴더 통째로 열기"
            >
              <FolderOpen className="w-5 h-5 text-amber-400" />
            </button>
            <input
              ref={folderInputRef}
              type="file"
              // @ts-ignore
              webkitdirectory=""
              directory=""
              multiple
              className="hidden"
              onChange={handleFolderChange}
            />

            <div className="w-[1px] h-5 bg-neutral-800 mx-0.5" />

            {/* 보기 모드 전환 (페이지 위치 자동 보정) */}
            <button
              onClick={handleToggleViewMode}
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
              onClick={toggleFullscreen}
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
        className={"relative flex-1 flex items-center justify-center overflow-hidden " + (immersive ? "p-0" : "p-2 sm:p-4")}
        onPointerUp={handleMainPointerUp}
        onDoubleClick={toggleFullscreen}
      >
        {pages.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-neutral-400 gap-5 max-w-sm px-4 text-center">
            <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-3xl bg-indigo-950/60 border border-indigo-500/30 flex items-center justify-center shadow-2xl">
              <BookOpen className="w-8 h-8 sm:w-10 sm:h-10 stroke-[1.5] text-indigo-400" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-neutral-100">만화책을 열어주세요</h2>
              <p className="text-xs sm:text-sm text-neutral-400 mt-1">
                {isLoadingSaved
                  ? '이전 독서 기록을 불러오는 중...'
                  : '이미지들이 담긴 폴더를 선택하거나 ZIP/CBZ 압축 파일을 열어보세요.'}
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-2.5 w-full mt-1">
              <button
                onClick={() => folderInputRef.current?.click()}
                className="flex-1 py-3 px-4 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs sm:text-sm flex items-center justify-center gap-2 shadow-lg transition-transform active:scale-95"
              >
                <FolderOpen className="w-4 h-4 text-amber-300" />
                <span>이미지 폴더 열기</span>
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex-1 py-3 px-4 rounded-2xl bg-neutral-800 hover:bg-neutral-700 text-neutral-200 font-semibold text-xs sm:text-sm flex items-center justify-center gap-2 border border-neutral-700/80 shadow transition-transform active:scale-95"
              >
                <FileArchive className="w-4 h-4 text-indigo-400" />
                <span>ZIP / CBZ 파일</span>
              </button>
            </div>
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
            onDoubleClick={toggleFullscreen}
          >
            {isDisplaySingle ? (
              /* [가변 단면 표시 - 단면 표지/작가의 말 또는 분할 모드] */
              <div className="w-full h-full relative overflow-hidden flex items-center justify-center bg-[#f8f8f5]">
                <div
                  className="w-full h-full bg-no-repeat"
                  style={getSliceStyle(
                    curl && nextSpread
                      ? (nextSpread.isSingle || isDisplaySingle ? nextSpread.left : nextSpread.right)
                      : currentSpread?.left || currentSpread?.right
                  )}
                />
              </div>
            ) : (
              /* [가변 양면 표시 - 2페이지 펼침면] */
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
                  isDisplaySingle && curl.side === 'right'
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
                    isDisplaySingle
                      ? currentSpread.left
                      : curl.side === 'right'
                      ? currentSpread.right
                      : currentSpread.left
                  )}
                  back={getSliceStyle(
                    isDisplaySingle
                      ? nextSpread.left
                      : curl.side === 'right'
                      ? nextSpread.left
                      : nextSpread.right
                  )}
                />
              </div>
            )}

            {/* 중앙 제본선 음영은 펼침면 + creaseEnabled 일 때만 표시 (단면 표지에는 표시 안함) */}
            {!isDisplaySingle && creaseEnabled && <div className="center-crease" />}

            {/* 권말 다음 권 안내 배너 */}
            {currentIndex === pages.length - 1 && hasNextBook && (
              <div className="absolute bottom-5 sm:bottom-8 px-4 py-2 bg-indigo-950/90 border border-indigo-500/40 rounded-full text-indigo-200 text-xs sm:text-sm font-medium shadow-2xl pointer-events-none z-30 animate-pulse backdrop-blur">
                마지막 페이지입니다. 다음으로 넘기면 다음 권이 열립니다.
              </div>
            )}
          </div>
        )}

        {immersive && (tapAction === 'page' || showImmersiveControls) && (
          <>
            {/* 우상단 전체화면 최소화 버튼 */}
            <button
              onClick={toggleFullscreen}
              style={{
                top: 'calc(1rem + env(safe-area-inset-top, 0px))',
                right: 'calc(1rem + env(safe-area-inset-right, 0px))',
              }}
              className="absolute p-2.5 bg-neutral-900/80 hover:bg-neutral-800 rounded-full text-neutral-300 z-50 backdrop-blur shadow-lg transition-opacity duration-200 flex items-center justify-center"
              title="기본 모드로 복귀"
            >
              <Minimize2 className="w-5 h-5" />
            </button>

            {/* 중앙 하단 페이지 번호 배지 */}
            {tapAction === 'menu' && (
              <div
                style={{
                  bottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))',
                }}
                className="absolute left-1/2 -translate-x-1/2 px-4 py-1.5 bg-neutral-900/80 border border-neutral-700/60 rounded-full text-xs text-neutral-300 backdrop-blur shadow-lg pointer-events-none z-50 font-mono"
              >
                {String(currentIndex + 1) + ' / ' + String(pages.length)}
              </div>
            )}
          </>
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
              onClick={() => {
                if (currentIndex < pages.length - 1) {
                  setCurrentIndex((idx) => idx + 1);
                } else if (hasNextBook) {
                  goNextBookRef.current();
                  playPageSound();
                }
              }}
              disabled={currentIndex >= pages.length - 1 && !hasNextBook}
              className="p-2 rounded-xl hover:bg-neutral-800 text-neutral-300 disabled:opacity-30 disabled:pointer-events-none min-w-[38px] min-h-[38px] flex items-center justify-center transition-colors"
              title={currentIndex >= pages.length - 1 && hasNextBook ? '다음 권으로 넘어가기' : '다음 페이지'}
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
              onClick={() => setTapAction((a) => (a === 'page' ? 'menu' : 'page'))}
              className={
                'px-2.5 sm:px-3 py-1.5 rounded-xl text-xs sm:text-sm font-medium transition-colors shadow-sm ' +
                (tapAction === 'menu'
                  ? 'bg-indigo-600 text-white'
                  : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200 border border-neutral-700')
              }
              title="화면 단순 탭 동작 전환 (페이지 넘기기 vs 전체화면 메뉴 토글)"
            >
              {tapAction === 'menu' ? '탭: 메뉴 토글' : '탭: 페이지 넘김'}
            </button>

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
