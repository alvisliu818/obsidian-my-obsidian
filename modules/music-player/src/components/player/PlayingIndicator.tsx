import "./PlayingIndicator.css";
import { t } from "@/utils/i18n/i18n";

/**
 * 播放指示器组件（柱状图动画效果）
 * 用于显示当前正在播放的状态
 */
export function PlayingIndicator() {
	return (
		<div className="playing-indicator" aria-label={t("playback.playing")}>
			<div className="equalizer-bar" style={{ animationDelay: '0s' }} />
			<div className="equalizer-bar" style={{ animationDelay: '0.1s' }} />
			<div className="equalizer-bar" style={{ animationDelay: '0.2s' }} />
			<div className="equalizer-bar" style={{ animationDelay: '0.3s' }} />
		</div>
	);
}

/**
 * 创建播放指示器的 HTML 字符串（用于非 React 环境）
 */
export function createPlayingIndicatorHTML(): string {
	const label = t("playback.playing");
	return `
		<div class="playing-indicator" aria-label="${label}">
			<div class="equalizer-bar" style="animation-delay: 0s"></div>
			<div class="equalizer-bar" style="animation-delay: 0.1s"></div>
			<div class="equalizer-bar" style="animation-delay: 0.2s"></div>
			<div class="equalizer-bar" style="animation-delay: 0.3s"></div>
		</div>
	`;
}

