/**
 * Exposes window.api (see shared/ipc.ts). Methods map to ipcMain.handle('<group>.<method>') and
 * events to webContents.send('<channel>').
 */
import { contextBridge, ipcRenderer } from 'electron'
import { API_EVENTS, API_METHODS, MEDIA_PROTOCOL } from '../shared/ipcChannels'

type AnyFn = (...args: unknown[]) => unknown

function setPath(obj: Record<string, any>, path: string[], value: unknown) {
  let o = obj
  for (const key of path.slice(0, -1)) o = o[key] ??= {}
  o[path[path.length - 1]] = value
}

const api: Record<string, any> = {}
for (const name of API_METHODS) {
  setPath(api, name.split('.'), ((...args: unknown[]) => ipcRenderer.invoke(name, ...args)) as AnyFn)
}
for (const [name, channel] of Object.entries(API_EVENTS)) {
  setPath(api, name.split('.'), (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  })
}
setPath(api, ['app', 'fileUrl'], (path: string) => `${MEDIA_PROTOCOL}://local/${encodeURIComponent(path)}`)

contextBridge.exposeInMainWorld('api', api)
