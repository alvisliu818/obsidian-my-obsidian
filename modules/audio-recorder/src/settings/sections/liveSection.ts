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
			name: '标记时截屏窗口',
			aliases: ['screenshot', 'marker', 'live'],
			desc: '在实时转写面板里点「重点 / 问题」等标记时，同时截取所选窗口的画面，并把截图链接写在标签后面。',
			control: { type: 'toggle', key: 'liveMarkerScreenshotEnabled' },
		},
		{
			name: '截图窗口',
			aliases: ['window', 'capture target'],
			desc: '标记时截取哪一个窗口。也可以在实时转写面板里随时改选。',
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
		desc: '边说边出字的实时转写面板（whisper.cpp server 模式），以及标记时是否截屏。',
		displayValue: (): string =>
			settings.liveMarkerScreenshotEnabled ? '截屏开' : '截屏关',
		items: sectionItems(rows),
	};
}
