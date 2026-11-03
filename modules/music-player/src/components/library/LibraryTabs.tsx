/**
 * 音乐库顶部标签栏（role="tablist" / role="tab"）。
 */

import { PlayingIndicator } from "@/components/player/PlayingIndicator";
import "./LibraryPage.css";
import { t } from "@/utils/i18n/i18n";

export type TabId = "all" | "favorites" | "playlists" | "artists" | "albums";

export interface LibraryTabsProps {
	activeTab: TabId;
	onChangeTab: (tabId: TabId) => void;
	/** 与 currentList 一致且正在播放时，在对应标签上显示指示器 */
	currentList?: string;
	activePath?: string | null;
}

const TAB_ORDER: TabId[] = ["all", "favorites", "playlists", "artists", "albums"];

const TAB_I18N: Record<TabId, string> = {
	all: "library.tab.all",
	favorites: "library.tab.favorites",
	playlists: "library.tab.playlists",
	artists: "library.tab.artists",
	albums: "library.tab.albums",
};

function tabMatchesCurrentList(tabId: TabId, currentList: string): boolean {
	switch (tabId) {
		case "all":
			return currentList === "all";
		case "favorites":
			return currentList === "favorites";
		case "playlists":
			return currentList.startsWith("playlist:");
		case "artists":
			return currentList.startsWith("artist:");
		case "albums":
			return currentList.startsWith("album:");
	}
}

export function LibraryTabs({ activeTab, onChangeTab, currentList, activePath }: LibraryTabsProps) {
	return (
		<nav className="toolbar">
			<div className="tabs" role="tablist">
				{TAB_ORDER.map((id) => {
					const selected = activeTab === id;
					const cl = currentList;
					const matched = Boolean(cl && activePath && tabMatchesCurrentList(id, cl));

					return (
						<div
							key={id}
							role="tab"
							id={`library-tab-${id}`}
							aria-selected={selected}
							tabIndex={0}
							className={`library-tab${selected ? " active" : ""}`}
							onClick={() => onChangeTab(id)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									onChangeTab(id);
								}
							}}
						>
							{matched ? (
								<span className="tab-playing-indicator" aria-hidden="true">
									<PlayingIndicator />
								</span>
							) : null}
							<span className="tab-label">{t(TAB_I18N[id])}</span>
						</div>
					);
				})}
			</div>
		</nav>
	);
}
