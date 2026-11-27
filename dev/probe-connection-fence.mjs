/**
 * Probe for the carrier trust fence: mounts the Host half on a fake web server
 * twice — once with a DSH 0.2.0–0.2.2 shaped `connection` (which owns
 * `requestRejection`) and once with a 0.2.3-alpha.1+ shaped one (which only has
 * `admit`, because the WebServer already admitted the request). The tip route
 * stands in for every route: it reads one shipped file and answers quickly, so
 * the probe stays hermetic.
 */
import { apply } from '../index.js'

const failures = []
const check = (name, condition, detail = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!condition) failures.push(name)
}

const response = () => ({
  statusCode: 0,
  headers: {},
  body: null,
  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = value
  },
  end(data) {
    this.body = data === undefined || data === null ? null : Buffer.from(data)
  },
})

const mount = (connection) => {
  const routes = new Map()
  apply({
    connection,
    webServer: {
      register: (route) => {
        routes.set(route.path, route)
        return () => {}
      },
    },
    effect: (fn) => {
      fn()
      return () => {}
    },
    get: () => undefined,
  })
  return routes.get('/dsh-versions/tip-qrcode')
}

// --- DSH 0.2.0-rc.2 … 0.2.2-rc.5: the handler owns the fence. ---------------
const fenced = []
const legacyRoute = mount({
  requestRejection: (request) => {
    fenced.push(request.method)
    return request.headers['x-untrusted'] === '1' ? 403 : undefined
  },
})
check('legacy carrier: tip route is registered', legacyRoute !== undefined)

const allowed = response()
await legacyRoute.handler({ method: 'GET', headers: {} }, allowed)
check('legacy carrier: request passes to the handler', allowed.statusCode === 200, String(allowed.statusCode))
check('legacy carrier: fence ran exactly once', fenced.length === 1, JSON.stringify(fenced))

const refused = response()
await legacyRoute.handler({ method: 'GET', headers: { 'x-untrusted': '1' } }, refused)
check('legacy carrier: fence status short-circuits', refused.statusCode === 403, String(refused.statusCode))
check('legacy carrier: rejection writes no body', refused.body === null)

// --- DSH 0.2.3-alpha.1+: the WebServer admitted; there is no fence to call. --
const modernRoute = mount({ admit: () => ({ peer: {} }) })
check('0.2.3 carrier: tip route is registered', modernRoute !== undefined)

const modern = response()
let modernError = null
try {
  await modernRoute.handler({ method: 'GET', headers: {} }, modern)
} catch (error) {
  modernError = error
}
check('0.2.3 carrier: handler does not throw', modernError === null, String(modernError?.message ?? ''))
check('0.2.3 carrier: request passes to the handler', modern.statusCode === 200, String(modern.statusCode))

// --- A carrier naming neither method never 400s; it runs without the fence. --
const bareRoute = mount({})
const bare = response()
let bareError = null
try {
  await bareRoute.handler({ method: 'GET', headers: {} }, bare)
} catch (error) {
  bareError = error
}
check('unknown carrier: handler does not throw', bareError === null, String(bareError?.message ?? ''))
check('unknown carrier: request passes to the handler', bare.statusCode === 200, String(bare.statusCode))

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nall trust-fence checks passed')
