import React from "react";
import { type IconName, setIcon } from "obsidian";

/**
 * 图标按钮组件的属性接口
 */
export interface IconButtonProps {
	/** Obsidian 图标名称 */
	icon: IconName;
	/** 按钮的标签文本（用于无障碍访问） */
	label: string;
	/** 自定义 CSS 类名（可选） */
	className?: string;
	/** 点击按钮时的回调函数（可选） */
	onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
	/** 双击按钮时的回调函数（可选） */
	onDoubleClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

/**
 * 通用图标按钮组件
 * 
 * 一个可复用的图标按钮组件，使用 Obsidian 内置图标系统。
 * 通过 ref 和 useEffect 自动设置图标，支持自定义样式和点击事件。
 * 
 * @param props 按钮属性
 * @returns 返回一个带有 Obsidian 图标的按钮元素
 * 
 * @example
 * ```tsx
 * <IconButton 
 *   icon="play" 
 *   label="播放" 
 *   onClick={() => handlePlay()} 
 * />
 * ```
 */
export function IconButton({ icon, label, className, onClick, onDoubleClick }: IconButtonProps) {
	const btnRef = React.useRef<HTMLButtonElement>(null);

	React.useEffect(() => {
		if (btnRef.current) {
			setIcon(btnRef.current, icon);
		}
	}, [icon]);

	return (
		<button
			ref={btnRef}
			type="button"
			className={className}
			aria-label={label}
			onClick={onClick}
			onDoubleClick={onDoubleClick}
		/>
	);
}

