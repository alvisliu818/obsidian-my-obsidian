import type { NavigationBehavior } from './settings';

export type NavigationAction = 'none' | 'pause' | 'close';

export function getNavigationAction(
	behavior: NavigationBehavior,
	isSourceFile: boolean,
): NavigationAction {
	if (isSourceFile || behavior === 'continue') return 'none';
	return behavior;
}
