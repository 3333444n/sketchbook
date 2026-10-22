// Window-chrome geometry shared by main (BrowserWindow options) and the renderer
// (tab strip). Keep these names stable: both sides import them.

/** Height in px of the renderer's tab strip, which doubles as the title bar. */
export const TAB_STRIP_HEIGHT = 40

/** Left padding in px the tab strip leaves free for the macOS traffic lights. */
export const TRAFFIC_LIGHT_INSET = 78

/** Position of the traffic lights (titleBarStyle 'hidden'): vertically centred in the strip. */
export const TRAFFIC_LIGHT_POSITION = { x: 14, y: 13 }
