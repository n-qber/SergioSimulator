import {
  Drum, Music, Save, FilePlus, FileText, Folder, FolderPlus, FolderOpen, Layers, Library,
  Link, Unlink, History, Clock, Download, Upload, Volume2, VolumeX,
  Headphones, GitFork, Copy, CopyPlus, Scissors, Clipboard, Sliders,
  Settings, Trash2, Edit2, Edit3, Pencil, RotateCcw, RotateCw, ExternalLink,
  Share2, Users, User, Sun, Moon, Maximize2, Minimize2, Menu,
  MoreVertical, X, Check, Search, Sparkles, AlertTriangle, Info,
  Lock, Unlock, ArrowLeft, ArrowRight, ChevronLeft, ChevronRight,
  ChevronUp, ChevronDown, Plus, Minus, Activity, Zap, Tag, Box,
  Radio, Wifi, WifiOff, Cloud, CloudUpload, Eye, Square, LogOut, Repeat,
  SkipBack, SkipForward, Play, Pause, GripHorizontal
} from 'lucide';

export const ICONS = {
  drum: Drum,
  music: Music,
  save: Save,
  'file-plus': FilePlus,
  'file-text': FileText,
  folder: Folder,
  'folder-plus': FolderPlus,
  'folder-open': FolderOpen,
  layers: Layers,
  library: Library,
  link: Link,
  unlink: Unlink,
  history: History,
  clock: Clock,
  download: Download,
  upload: Upload,
  'volume-2': Volume2,
  'volume-x': VolumeX,
  headphones: Headphones,
  'git-fork': GitFork,
  copy: Copy,
  'copy-plus': CopyPlus,
  scissors: Scissors,
  clipboard: Clipboard,
  sliders: Sliders,
  settings: Settings,
  'trash-2': Trash2,
  trash: Trash2,
  'edit-2': Edit2,
  'edit-3': Edit3,
  pencil: Pencil,
  'rotate-ccw': RotateCcw,
  'rotate-cw': RotateCw,
  'external-link': ExternalLink,
  'share-2': Share2,
  share: Share2,
  users: Users,
  user: User,
  sun: Sun,
  moon: Moon,
  'maximize-2': Maximize2,
  'minimize-2': Minimize2,
  menu: Menu,
  'more-vertical': MoreVertical,
  x: X,
  check: Check,
  search: Search,
  sparkles: Sparkles,
  'alert-triangle': AlertTriangle,
  info: Info,
  lock: Lock,
  unlock: Unlock,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-up': ChevronUp,
  'chevron-down': ChevronDown,
  plus: Plus,
  minus: Minus,
  activity: Activity,
  zap: Zap,
  tag: Tag,
  box: Box,
  radio: Radio,
  wifi: Wifi,
  'wifi-off': WifiOff,
  cloud: Cloud,
  'cloud-upload': CloudUpload,
  eye: Eye,
  square: Square,
  'log-out': LogOut,
  repeat: Repeat,
  'skip-back': SkipBack,
  'skip-forward': SkipForward,
  play: Play,
  pause: Pause,
  'grip-horizontal': GripHorizontal
};

/**
 * Retorna string SVG vetorial estilizada via currentColor
 */
export function iconSvg(name, { size = 16, className = '', strokeWidth = 2 } = {}) {
  const iconData = ICONS[name];
  if (!iconData) {
    console.warn(`[Icons] Ícone "${name}" não encontrado.`);
    return '';
  }
  const children = iconData.map(([tag, attrs]) => {
    const attrStr = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
    return `<${tag} ${attrStr}/>`;
  }).join('');
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-${name} ${className}" aria-hidden="true">${children}</svg>`;
}

/**
 * Converte elementos com data-lucide em SVGs inline
 */
export function initIcons(root = document) {
  const elements = root.querySelectorAll('[data-lucide]');
  elements.forEach((el) => {
    const name = el.getAttribute('data-lucide');
    const size = parseInt(el.getAttribute('data-size'), 10) || 16;
    const strokeWidth = parseFloat(el.getAttribute('data-stroke')) || 2;
    const extraClass = el.getAttribute('data-class') || '';
    const svgHtml = iconSvg(name, { size, className: extraClass, strokeWidth });
    if (svgHtml) {
      el.innerHTML = svgHtml;
    }
  });
}
