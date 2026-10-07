/** Names of every window.api method (invoke channels) and event (send channels). Keep in sync with ipc.ts. */
export const MEDIA_PROTOCOL = 'ave-media'

export const API_METHODS = [
  'app.info', 'app.openPath', 'app.showItemInFolder', 'app.saveDiagnostics', 'app.openExternal', 'app.pickFolder', 'app.pickFiles',
  'app.saveFile', 'app.copyText',
  'updates.state', 'updates.check', 'updates.restartNow', 'updates.later',
  'setup.status', 'setup.installEnvironment',
  'settings.get', 'settings.update', 'settings.setPikzelsKey', 'settings.hasPikzelsKey', 'settings.openAppLog',
  'settings.claudeSetup',
  'profiles.list', 'profiles.save', 'profiles.create', 'profiles.delete', 'profiles.suggestions', 'profiles.answerSuggestion',
  'music.list', 'music.rescan', 'music.addFolder', 'music.removeFolder',
  'projects.recent', 'projects.create', 'projects.open', 'projects.locate', 'projects.removeRecent', 'projects.close',
  'project.get', 'project.apply', 'project.undo', 'project.redo', 'project.relinkSource', 'project.startEdit',
  'project.sendChat', 'project.requestReedit', 'project.requestFixAudio', 'project.requestStabilize', 'project.requestInsertClip', 'project.requestShorts', 'project.exportCheck', 'project.addNote', 'project.noteToRule',
  'project.reviewRequest', 'project.introDecision', 'project.setVideoTheme', 'project.regeneratePublish', 'project.seamAudio', 'project.waveform',
  'project.frameAt',
  'project.versions.list', 'project.versions.save', 'project.versions.restore', 'project.versions.remove',
  'project.versions.compareFrames',
  'project.exportVideo', 'project.cancelExport', 'project.exportLog', 'project.exportPack', 'project.saveToLibrary',
  'thumbnails.generate', 'thumbnails.regenerate', 'thumbnails.choose', 'thumbnails.exportImage',
  'thumbnails.recreate', 'thumbnails.edit', 'thumbnails.faceSwap', 'thumbnails.score', 'thumbnails.titles',
  'preview.state', 'preview.showBefore',
  'claude.state', 'claude.stop', 'claude.resume', 'claude.estimate',
  'library.list', 'library.changeFolder', 'library.update', 'library.duplicate', 'library.remove', 'library.placeInProject',
  'pikzels.list', 'pikzels.create', 'pikzels.refresh', 'pikzels.updateInstructions', 'pikzels.remove',
  'pikzels.rename', 'pikzels.pricing', 'pikzels.setPrices', 'pikzels.thumbnailsFromLink',
  'shorts.state', 'shorts.exportShort', 'shorts.exportAll', 'shorts.remove', 'shorts.refresh',
  'themes.list', 'themes.analyze', 'themes.cancel', 'themes.update', 'themes.remove', 'themes.sheets'
] as const

export type ApiMethod = (typeof API_METHODS)[number]

/** api path -> channel */
export const API_EVENTS = {
  'app.onMenu': 'menu',
  'updates.onState': 'updates:state',
  'setup.onProgress': 'setup:progress',
  'profiles.onSuggestion': 'profiles:suggestion',
  'project.onChange': 'project:change',
  'project.onRenderJob': 'render:job',
  'preview.onState': 'preview:state',
  'claude.onState': 'claude:state',
  'claude.onOutput': 'claude:output',
  'themes.onProgress': 'themes:progress',
  'project.onCheckProgress': 'exportcheck:progress',
  'shorts.onState': 'shorts:state'
} as const
