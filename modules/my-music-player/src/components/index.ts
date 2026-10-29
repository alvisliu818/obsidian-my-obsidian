/**
 * 组件统一导出
 * 
 * 统一导出常用的 React 组件，方便其他模块导入使用
 */

// Root 组件
export { MusicPlayerRoot } from "./root/MusicPlayerRoot";

// Page 组件
export { PlayPage } from "./player/PlayPage";
export type { PlayPageViewMode, PlayPageProps } from "./player/PlayPage";
export { LibraryPage } from "./library/LibraryPage";

// Modal 组件
export { TextInputModal } from "./modal/TextInputModal";
export { PlaylistPickerModal } from "./modal/PlaylistPickerModal";
export { QueueModal } from "./modal/QueueModal";
export { TrackSearchModal } from "./modal/TrackSearchModal";
export { ConfirmModal } from "./modal/ConfirmModal";

// Player 组件
export { AlbumDisc } from "./player/AlbumDisc";
export { PlaybackControls } from "./player/PlaybackControls";
export { ProgressBar } from "./player/ProgressBar";
export { TrackActions } from "./player/TrackActions";
export { TrackHeader } from "./player/TrackHeader";
export { PlayingIndicator, createPlayingIndicatorHTML } from "./player/PlayingIndicator";
export { LyricsFull } from "./player/LyricsFull";
export { LyricsTriplet } from "./player/LyricsTriplet";
export { LyricsExtendedFull } from "./player/LyricsExtendedFull";
export { LyricsExtendedTriplet } from "./player/LyricsExtendedTriplet";

// Shared 组件
export { IconButton } from "./shared/IconButton";
export { NavigationBar } from "./shared/NavigationBar";

