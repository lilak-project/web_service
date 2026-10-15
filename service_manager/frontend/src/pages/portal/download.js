import { launcher } from '../../api'

/**
 * Fetch an authorised file and hand it to the browser as a download.
 *
 * A plain <a href> would navigate WITHOUT the Authorization header the export
 * endpoints check, so the file comes through axios as a blob and is saved from
 * an object URL instead.
 */
export async function downloadFrom(path, filename) {
  const res = await launcher.get(path, { responseType: 'blob' })
  const url = URL.createObjectURL(res.data)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
