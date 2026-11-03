/**
 * The live-transcribe section: the marker-screenshot switch and the window it
 * screenshots. The panel itself is opened from a command; the settings here
 * only shape what a marker click does.
 * @module settings/sections/liveSection
 */

import type { LiveTranscribeSettingsActions } from './context';
import { sectionItems } from './rowHelpers';
import type { Setting, SettingGroupItem } from 'obsidian';

/**
 * The live-transcribe page. Chinese by construction — a merged-fork feature,
 * not upstream surface.
 * @param live - The picker action the window row opens
 * @param settings - Read for the page's display value
 */
export function livePage(
	live: LiveTranscribeSettingsActions,
	settings: {
		liveMarkerScreenshotEnabled: boolean;
		liveMarkerWindowName: string;
	},
): SettingGroupItem {
	const rows: SettingGroupItem[] = [
		{
			name: '启用截屏按钮',
			aliases: ['screenshot', 'marker', 'live'],
			desc: '实时转写面板里显示「截屏」按钮：点击即截取所选窗口，截图链接作为独立一行写进转写。标记（悬停句子上出现）不截屏，两者相互独立。',
			control: { type: 'toggle', key: 'liveMarkerScreenshotEnabled' },
		},
		{
			name: '截图窗口',
			aliases: ['window', 'capture target'],
			desc: '点截屏按钮时截取哪一个窗口。也可以在实时转写面板里随时改选。',
			render: (setting: Setting): void => {
				const label = setting.controlEl.createSpan({
					text: settings.liveMarkerWindowName || '未选择',
				});
				label.style.marginRight = '8px';
				label.style.color = 'var(--text-muted)';
				setting.addButton((button) =>
					button.setButtonText('选择窗口…').onClick(() => {
						live.pickScreenshotWindow((name) => {
							label.setText(name);
						});
					}),
				);
			},
		},
	];
	return {
		type: 'page',
		name: '实时转写',
		desc: '实时转写面板（whisper.cpp server 模式）：按停顿分句、逐句悬停标记、独立截屏按钮。',
		displayValue: (): string =>
			settings.liveMarkerScreenshotEnabled ? '截屏开' : '截屏关',
		items: sectionItems(rows),
	};
}
