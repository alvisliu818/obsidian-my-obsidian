import React from "react";
import { type IconName, setIcon } from "obsidian";
import { t } from "@/utils/i18n/i18n";

/**
 * 导航图标按钮组件的属性接口
 */
interface NavIconButtonProps {
	/** Obsidian 图标名称 */
	icon: IconName;
	/** 按钮的标签文本（用于无障碍访问） */
	label: string;
	/** 是否处于激活状态（用于高亮显示当前页面） */
	active?: boolean;
	/** 是否禁用按钮 */
	disabled?: boolean;
	/** 点击按钮时的回调函数 */
	onClick: () => void;
	/** 是否显示提示圆点 */
	showBadge?: boolean;
	/** 重建提示圆点的无障碍标签 */
	rebuildBadgeAria?: string;
}

/**
 * 导航图标按钮组件
 * 
 * 用于导航栏中的图标按钮，支持激活状态显示。
 * 使用 Obsidian 内置图标系统，自动设置图标。
 * 
 * @param props 按钮属性
 */
function NavIconButton({ icon, label, active, disabled, onClick, showBadge, rebuildBadgeAria }: NavIconButtonProps) {
	const buttonRef = React.useRef<HTMLButtonElement>(null);

	React.useEffect(() => {
		if (buttonRef.current) {
			setIcon(buttonRef.current, icon);
		}
	}, [icon]);

	return (
		<div className="nav-icon-wrapper">
			<button
				ref={buttonRef}
				type="button"
				className={`clickable-icon nav-action-button ${active ? "active" : ""} ${disabled ? "is-disabled" : ""}`}
				aria-label={label}
				onClick={onClick}
				disabled={disabled}
			/>
			{showBadge && (
				<span className="nav-icon-badge" aria-label={rebuildBadgeAria ?? ""} />
			)}
		</div>
	);
}

/**
 * 导航栏组件的属性接口
 */
export interface NavigationBarProps {
	/** 当前激活的标签页（"currentDisc" 表示当前唱片页，"library" 表示音乐库页） */
	activeTab: "currentDisc" | "library";
	/** 当前页面（仅在 activeTab 为 "currentDisc" 时有效，"disc" 表示唱片页，"lyrics" 表示歌词页） */
	currentPage?: "disc" | "lyrics";
	/** 打开音乐库页面的回调函数 */
	onOpenLibrary: () => void;
	/** 打开唱片页面的回调函数 */
	onOpenDisc: () => void;
	/** 打开歌词页面的回调函数（可选） */
	onOpenLyrics?: () => void;
	/** 重建所有数据的回调函数（异步） */
	onRebuild: () => Promise<void>;
	/** 是否正在重建（用于禁用重建按钮） */
	isRebuilding?: boolean;
	/** 是否需要重建索引（用于显示提示圆点） */
	needsRebuild?: boolean;
	/** 打开搜索对话框的回调函数 */
	onSearch: () => void;
	/** 打开设置页面的回调函数 */
	onSettings: () => void;
}

/**
 * 导航栏组件
 * 
 * 提供音乐播放器的主要导航功能，包括：
 * - 搜索歌曲
 * - 切换到音乐库页面
 * - 切换到唱片/歌词页面
 * - 重建所有数据
 * - 打开设置
 * 
 * 根据当前激活的标签页和页面，自动高亮对应的按钮。
 * 
 * @param props 导航栏属性
 */
export function NavigationBar(props: NavigationBarProps) {
	const {
		activeTab,
		currentPage,
		onOpenLibrary,
		onOpenDisc,
		onOpenLyrics,
		onRebuild,
		onSearch,
		onSettings,
		isRebuilding = false,
		needsRebuild = false,
	} = props;

	return (
		<div className="nav-buttons-container">
			<NavIconButton icon="search" label={t("nav.search")} onClick={onSearch} />
			<NavIconButton
				icon="music-2"
				label={t("nav.library")}
				active={activeTab === "library"}
				onClick={onOpenLibrary}
			/>
			<NavIconButton
				icon="disc-album"
				label={t("nav.disc")}
				active={activeTab === "currentDisc" && currentPage === "disc"}
				onClick={onOpenDisc}
			/>
			{onOpenLyrics && (
				<NavIconButton
					icon="type"
					label={t("nav.lyrics")}
					active={activeTab === "currentDisc" && currentPage === "lyrics"}
					onClick={onOpenLyrics}
				/>
			)}
			<NavIconButton
				icon="database-zap"
				label={t("nav.rebuild")}
				onClick={() => {
					void onRebuild();
				}}
				disabled={isRebuilding}
				showBadge={needsRebuild}
				rebuildBadgeAria={t("nav.rebuildBadge")}
			/>
			<NavIconButton icon="settings" label={t("nav.settings")} onClick={onSettings} />
		</div>
	);
}

