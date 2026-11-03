/**
 * 视图设置服务
 * 
 * 负责管理视图的 DOM 设置和 React 挂载
 */

import { App } from "obsidian";
import { createRoot, Root } from "react-dom/client";
import * as React from "react";
import type { MusicPlayerView } from "@/views/MusicPlayerView";
import { MusicPlayerRoot } from "@/components";

export interface ViewSetupResult {
	container: HTMLElement;
	navHost: HTMLElement;
	reactRoot: Root;
}

export class ViewSetupService {
	constructor(_app: App) {}

	/**
	 * 设置视图的 DOM 结构和 React 挂载
	 */
	setupView(containerEl: HTMLElement, view: MusicPlayerView): ViewSetupResult {
		const leafContent = containerEl.closest(".workspace-leaf-content");
		leafContent?.addClass('music-player');
		const viewHeaderEl = leafContent?.querySelector(".view-header") ?? containerEl.querySelector(".view-header");
		const viewHeader = viewHeaderEl instanceof HTMLElement ? viewHeaderEl : null;
		const viewContentEl = leafContent?.querySelector(".view-content") ?? containerEl.querySelector(".view-content");
		const viewContent = viewContentEl instanceof HTMLElement ? viewContentEl : null;
		viewContent?.addClass('music-player');

		let container: HTMLElement | null = null;
		if (viewHeader instanceof HTMLElement) {
			container = viewContent;
		} else if (leafContent instanceof HTMLElement) {
			container = leafContent;
		} else {
			const children = Array.from(containerEl.children);
			container = children[children.length - 1] as HTMLElement;
		}

		if (!container) {
			throw new Error("无法找到内容容器");
		}

		const navContainer = leafContent ?? container;
		const navHostEl = navContainer.querySelector("nav-header");
		let navHost = navHostEl instanceof HTMLElement ? navHostEl : null;
		if (!navHost) {
			navHost = navContainer.createDiv();
			// 为导航栏宿主添加统一根前缀，便于样式隔离与定位
			navHost.className = "music-player nav-header";
			if (viewHeader && navContainer === leafContent) {
				navContainer.insertBefore(navHost, viewHeader);
			} else {
				navContainer.insertBefore(navHost, navContainer.firstChild);
			}
		} else {
			navHost.classList.add("music-player");
			navHost.empty?.();
		}

		// 清理所有旧的 React 挂载点（可能存在的残留元素）
		const oldReactMounts = container.querySelectorAll(".music-player-react-root");
		oldReactMounts.forEach(el => el.remove());
		
		// 创建新的 DOM 元素用于挂载 React
		const reactMount = container.createDiv();
		// 为侧栏内容区根节点添加统一根前缀，便于用 .music-player 作为样式作用域
		reactMount.className = "music-player music-player-container music-player-react-root";
		// 确保容器有内容，如果没有子元素，直接 appendChild
		if (container.firstChild) {
			container.insertBefore(reactMount, container.firstChild);
		} else {
			container.appendChild(reactMount);
		}

		const reactRoot = createRoot(reactMount);
		reactRoot.render(React.createElement(MusicPlayerRoot, { view, navHost }));

		return { container, navHost, reactRoot };
	}
}

