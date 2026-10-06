// The one place to change the app's name and identity.
export const APP_NAME = 'AI Video Editor'
export const APP_ID = 'com.aivideoeditor.app'
/** Folder name used under %APPDATA% / %LOCALAPPDATA%. Never change after release: settings live there. */
export const APP_DATA_FOLDER = 'AI Video Editor'

export const RELEASE_REPO = { owner: 'trendlinepros-afk', repo: 'Automated-Video-Editing' }

/** Version of project.json written by this app. Bump and add a migration in shared/migrations.ts. */
export const PROJECT_FORMAT_VERSION = 2
/** Version of settings.json and profile files. */
export const SETTINGS_FORMAT_VERSION = 1
/** Version of asset library description files (asset.json). */
export const LIBRARY_FORMAT_VERSION = 1
/** Version of the bundled rendering engine. Each project records the one it was made with. */
export const ENGINE_VERSION = '1.0.0'

export const DEFAULT_MCP_PORT = 47821
export const MCP_SERVER_NAME = 'ave'
