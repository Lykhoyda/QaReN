export type ForegroundSurface =
  | 'app'
  | 'expo_dev_menu'
  | 'dev_client_picker'
  | 'first_run_tutorial'
  | 'react_native_dev_menu'
  | 'unknown';

export type RemedyAuthority = 'available' | 'unavailable' | 'blocked';

export interface ForegroundSurfaceRemedy {
  condition: 'expo_dev_menu';
  tool: 'cdp_dev_settings';
  arguments: { action: 'hideDevMenu' };
  guidance: string;
}

const EXPO_DEVELOPER_MENU_REMEDY: ForegroundSurfaceRemedy = {
  condition: 'expo_dev_menu',
  tool: 'cdp_dev_settings',
  arguments: { action: 'hideDevMenu' },
  guidance:
    'Expo Developer Menu detected. Call cdp_dev_settings({ action: "hideDevMenu" }), then take a fresh device_snapshot and require the app surface before navigation.',
};

export function recommendForegroundSurfaceRemedy(input: {
  condition: ForegroundSurface;
  authority: RemedyAuthority;
}): ForegroundSurfaceRemedy | null {
  if (input.authority !== 'available' || input.condition !== 'expo_dev_menu') return null;
  return {
    ...EXPO_DEVELOPER_MENU_REMEDY,
    arguments: { ...EXPO_DEVELOPER_MENU_REMEDY.arguments },
  };
}
